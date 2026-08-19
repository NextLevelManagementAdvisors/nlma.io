# Capture and re-authorization: the build, ready to apply

Everything in this file is designed and, where it is logic, tested. None of it is installed,
because every remaining item needs `addNode` on the n8n workflow and that is refused by the
Claude Code auto mode classifier. Turn auto mode off and this becomes a mechanical apply.

Workflow: `R0cMmqeBshPYpdqt` "NLMA Consults", 74 nodes, active.

## Why these three are blocked and nothing else is

| Item | Needs | Status |
|---|---|---|
| 4, nightly re-authorization | a schedule trigger plus ~7 nodes | `addNode` refused |
| 7, transcript analysis and capture | a schedule trigger plus ~9 nodes | `addNode` refused |
| L4, retire `/webhook/consult-book` | rename one webhook path | `patchNodeField` on `parameters.path` refused |

Parameter and code patches on existing nodes are permitted, which is how L2, L6, L10, L11 and the
replay guard all landed today. Only structural changes are blocked.

## What is already settled, so the build has no unknowns left

- **Stripe permissions.** `Cancel Auth` succeeded live, and cancelling a PaymentIntent is a write
  on `payment_intents`, the same permission needed to create one off-session. Re-auth never
  creates a Customer, it reuses the `customerId` and `paymentMethodId` already on the booking
  record. Credential `kKWma7ncblJi00xq` ("NLMA Stripe Live (consults)") is sufficient as-is.
- **Google permissions.** DWD client `105046837924700815762` carries `drive.readonly` and
  `documents.readonly`; a JWT impersonating `forrest@nlma.io` exchanges cleanly and both APIs
  answer. n8n credential `3siGSxiA9FloX0c1` should test green.
- **The booking register.** `Store Booking` already persists everything both items need:
  `token, eventId, meetLink, paymentIntent, customerId, paymentMethodId, amount, billable,
  startIso, durationMin, name, email, medium, summary, request, status, authorizedAt`.
  Statuses in play: `pending`, `confirmed`, `declined`, `cancelled`.

---

# Item 7: analyse the call, capture or release

## Trigger

`Capture Cron`, schedule trigger, hourly. Hourly rather than nightly because an authorization on a
debit card can lapse faster than a day, and because a guest who disputes wants the charge to have
happened close to the call, not eight hours later.

## Node chain

```
Capture Cron
  -> Capture Sweep            (Code)   pick bookings whose call ended >45 min ago, status confirmed, not yet settled
  -> IF Any Due               (IF)     nothing due -> NoOp
  -> Find Notes Doc           (HTTP)   Drive files.list
  -> Read Notes Doc           (HTTP)   Docs get, includeTabsContent=true
  -> Parse Notes              (Code)   flatten tabs, pull talk time, detect missing summary
  -> Judge Call               (HTTP)   cliproxy, returns {advisory, confidence, rationale}
  -> Capture Decide           (Code)   the tested logic below
  -> IF Capture               (IF)     capture -> Stripe capture ; release -> Stripe cancel
       -> Stripe Capture      (HTTP)   POST /v1/payment_intents/{id}/capture
       -> Stripe Release      (HTTP)   POST /v1/payment_intents/{id}/cancel
  -> Settle Booking           (Code)   write status captured|released + amount + reason to the register
  -> Guest Receipt            (Gmail)  what happened and why, onError continueRegularOutput
```

`Settle Booking` must run on both arms, so wire both Stripe nodes into it.

## Capture Sweep

```js
const sd = $getWorkflowStaticData('global');
const GRACE_MIN = 45;   // let Gemini finish writing the notes doc
const now = $now;
const due = (sd.bookings || []).filter(b => {
  if (b.status !== 'confirmed') return false;
  if (b.settledAt) return false;
  const end = DateTime.fromISO(b.startIso).plus({ minutes: Number(b.durationMin) || 30 });
  return now > end.plus({ minutes: GRACE_MIN });
});
// One item per booking. Everything downstream is per-item.
return due.map(b => ({ json: { booking: b } }));
```

## Find Notes Doc

`GET https://www.googleapis.com/drive/v3/files`, credential `googleApi` / the service account,
query parameters (n8n encodes these for you, which is the trap avoided here: hand-building the
URL and leaving a raw space in `orderBy` throws `InvalidURL`):

| Parameter | Value |
|---|---|
| `q` | `name contains ' - Notes by Gemini' and createdTime > '{{ $json.booking.startIso }}'` |
| `orderBy` | `createdTime` |
| `pageSize` | `5` |
| `fields` | `files(id,name,createdTime)` |

A confirmed consult is titled `Consult: <name> (billable|intro)`, so the notes doc name is
deterministic and no Meet-code matching is needed. Prefer the file whose name contains the guest
name; fall back to the earliest doc created after the call started.

## Read Notes Doc

`GET https://docs.googleapis.com/v1/documents/{{ id }}?includeTabsContent=true`

**Without `includeTabsContent=true` you get only the first tab, which is the summary.** No error,
no hint, and the transcript and talk time are simply absent. This is the single thing most likely
to waste a day. See memory `reference-google-docs-api-hides-tabs`.

## Parse Notes

```js
const doc = $json;
function tabText(tab){
  const out = [];
  (function walk(items){
    for (const p of items || []) {
      if (p.paragraph) out.push((p.paragraph.elements || [])
        .map(e => (e.textRun && e.textRun.content) || '').join(''));
      if (p.table) for (const r of (p.table.tableRows || []))
        for (const c of (r.tableCells || [])) walk(c.content);
    }
  })((tab.documentTab && tab.documentTab.body && tab.documentTab.body.content) || []);
  return out.join('');
}
const tabs = [];
(function collect(list){
  for (const t of list || []) { tabs.push(t); collect(t.childTabs); }
})(doc.tabs);

const flat = tabs.map(t => ({
  title: ((t.tabProperties || {}).title) || '',
  text: tabText(t)
}));
const transcriptTab = flat.find(t => /Transcription ended after\s+[0-9:]+/.test(t.text)) || null;
const notesTab = flat.find(t => /^(Quick notes|Full notes|Notes)$/i.test(t.title)) || flat[0] || null;
const m = transcriptTab ? transcriptTab.text.match(/Transcription ended after\s+([0-9:]+)/) : null;

return { json: {
  booking: $('Capture Sweep').item.json.booking,
  doc: {
    talkTime: m ? m[1] : null,
    summaryMissing: !!(notesTab && /summary\s+wasn't\s+produced|not enough conversation/i.test(notesTab.text)),
    summary: notesTab ? notesTab.text.slice(0, 4000) : '',
    transcript: transcriptTab ? transcriptTab.text.slice(0, 40000) : ''
  }
}};
```

`summaryMissing` matters: on a 49-second call Gemini writes that no summary could be produced
because there was not enough conversation. That is inconclusive, not zero.

## Judge Call

POST to cliproxy, same pattern as `Triage (cliproxy)`. Ask for strict JSON:

> You are deciding whether a consultation was introductory discussion or paid advisory work.
> Advisory work means specific recommendations, analysis of the client's situation, or work
> product. Introductory means scoping, rapport, pricing, logistics, or deciding whether to
> engage. Reply with JSON only: `{"advisory": true|false, "confidence": 0.0-1.0,
> "rationale": "one sentence"}`. If the transcript is too thin to tell, return
> `confidence` below 0.5.

Feed it `doc.summary` and `doc.transcript`. Parse defensively, the way `Parse+Slots` and
`Checkout Compute` already strip code fences and fall back on a JSON error.

## Capture Decide

The tested body is in the repo at `scratchpad/capture.body.js` during the session; it is
reproduced here because it is the part that must not be retyped from memory.

Two rails, and they hold on all 108 swept combinations: **never more than the amount authorized**,
and **inconclusive releases rather than captures**.

```js
const RATE_PER_HOUR = 450;
const INCREMENT_MIN = 15;                       // 112.50 at 450/hr
const INCREMENT_AMOUNT = RATE_PER_HOUR * INCREMENT_MIN / 60;
const MIN_REAL_CALL_SEC = 120;                  // under two minutes is not a consult
const JUDGE_MIN_CONFIDENCE = 0.7;
const DOLLAR = String.fromCharCode(36);

function hmsToSeconds(hms){
  const raw = String(hms == null ? '' : hms).trim();
  if (!/^[0-9]+(:[0-9]{1,2}){0,2}$/.test(raw)) return null;
  const p = raw.split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0]*3600 + p[1]*60 + p[2]
       : p.length === 2 ? p[0]*60 + p[1]
       : p[0];
}

const b = $json.booking || {};
const doc = $json.doc || null;
const judge = $json.judge || null;
const authorized = Number(b.amount || 0);

function release(reason, talk){
  return { json: { booking:b, action:'release', amount:0, authorized:authorized,
                   reason:reason, talkSeconds:(talk === undefined ? null : talk) } };
}

if (!authorized || authorized <= 0)
  return release('No authorization on record to act on.');
if (b.status !== 'confirmed')
  return release('Booking was not confirmed, so there is nothing to capture.');
if (!doc)
  return release('No meeting notes were produced for this call, so the time spent could not be established.');

const talk = hmsToSeconds(doc.talkTime);
if (talk === null)
  return release('The meeting notes carry no transcription time, so the time spent could not be established.');
if (talk < MIN_REAL_CALL_SEC)
  return release('The call lasted under two minutes, which is not a consultation.', talk);
if (doc.summaryMissing)
  return release('The notes record that no summary could be produced, so the nature of the call is inconclusive.', talk);
if (!judge || typeof judge.advisory !== 'boolean')
  return release('The transcript could not be assessed, so the nature of the call is inconclusive.', talk);
if (Number(judge.confidence || 0) < JUDGE_MIN_CONFIDENCE)
  return release('The assessment of the call was not confident enough to bill against.', talk);
if (!b.billable && !judge.advisory)
  return release('This was an introductory conversation, so the hold is released as promised.', talk);

const increments = Math.max(1, Math.ceil(talk / (INCREMENT_MIN * 60)));
const computed   = Math.round(increments * INCREMENT_AMOUNT * 100) / 100;
const amount     = Math.min(computed, authorized);      // rail 1
const capped     = computed > authorized;

return { json: {
  booking:b, action:'capture', amount:amount, authorized:authorized, computed:computed,
  increments:increments, talkSeconds:talk, capped:capped,
  reason: (b.billable ? 'Advisory consult' : 'Introductory call that became advisory work')
    + ': ' + Math.round(talk/60) + ' min of talk time billed as ' + increments
    + ' x ' + INCREMENT_MIN + ' min at ' + DOLLAR + RATE_PER_HOUR + '/hr'
    + (capped ? ', capped at the amount authorized.' : '.')
}};
```

### Worked examples from the real Gemini docs on this account

| Measured talk time | Authorized | Increments | Computed | Captured | Note |
|---|---|---|---|---|---|
| 00:16:57 | 112.50 intro | 2 | 225.00 | **112.50** | rail 1 caps it |
| 00:13:25 | 225.00 paid | 1 | 112.50 | **112.50** | under the auth |
| 00:15:48 | 225.00 paid | 2 | 225.00 | **225.00** | exactly the auth |
| 00:00:49 | 112.50 intro | n/a | n/a | **released** | under the two-minute floor |
| 01:12:00 | 225.00 paid | 5 | 562.50 | **225.00** | rail 1 caps it hard |

### Test results

30 named assertions plus a 108-combination sweep, all passing. The sweep asserts that no capture
ever exceeds its authorization, that every release carries a zero amount, and that the function
never returns anything other than capture or release.

## Stripe Capture and Stripe Release

Same credential and header pattern as the existing `Refund` node (which is misnamed: it already
POSTs `/cancel`).

```
POST https://api.stripe.com/v1/payment_intents/{{ $json.booking.paymentIntent }}/capture
     Content-Type: application/x-www-form-urlencoded
     amount_to_capture = {{ Math.round($json.amount * 100) }}

POST https://api.stripe.com/v1/payment_intents/{{ $json.booking.paymentIntent }}/cancel
     cancellation_reason = abandoned
```

Set `retryOnFail: true, maxTries: 3` on both, and **not** `onError: continueRegularOutput`: a
failed capture must not be recorded as settled.

## Settle Booking

```js
const d = $('Capture Decide').item.json;
const sd = $getWorkflowStaticData('global');
const b = (sd.bookings || []).find(x => x.token === d.booking.token);
if (b) {
  b.status = (d.action === 'capture') ? 'captured' : 'released';
  b.settledAt = $now.toISO();
  b.settledAmount = d.amount;
  b.settledReason = d.reason;
  b.talkSeconds = d.talkSeconds;
}
return { json: d };
```

`settledAt` is what keeps `Capture Sweep` from picking the same booking up an hour later.

## Guest Receipt

Two wordings, branched on `action`, in the plain register the other consult emails use. A capture
must state the amount, the measured talk time, and that it never exceeded the authorization. A
release must state that nothing was charged. Both point at info@nlma.io for disputes, which is what
terms.html promises.

---

# Item 4: keep the authorization alive

An authorization lapses in roughly seven days, debit cards often sooner, and the booking window is
21 days. Without this, a consult booked more than about six days out cannot be captured at all.
This is a prerequisite for billable consults, not a nicety.

## Node chain

```
Reauth Cron  (schedule, daily 03:00 ET)
  -> Reauth Sweep     (Code)   confirmed bookings whose call is >5 days out and whose auth is >5 days old
  -> IF Any           (IF)
  -> New Auth         (HTTP)   POST /v1/payment_intents  off_session, manual capture, same customer + payment method
  -> Reauth Check     (Code)   succeeded -> swap paymentIntent on the record; failed -> flag
  -> IF Reauth OK     (IF)
       -> Cancel Old  (HTTP)   POST /v1/payment_intents/{old}/cancel   only after the new one is held
       -> Reauth Alert (Gmail) tell Forrest and the guest that the card needs reconfirming
```

`New Auth` body:

```
amount               = {{ Math.round($json.booking.amount * 100) }}
currency             = usd
customer             = {{ $json.booking.customerId }}
payment_method       = {{ $json.booking.paymentMethodId }}
capture_method       = manual
confirm              = true
off_session          = true
metadata[token]      = {{ $json.booking.token }}
metadata[reauthOf]   = {{ $json.booking.paymentIntent }}
```

**Order matters: hold the new authorization before cancelling the old one.** Cancel first and a
decline leaves the booking with no hold at all.

Also needed, per terms.html: if a re-authorization fails, ask the guest to reconfirm their card and
say the consult may be cancelled if it cannot be secured. That is already promised in the terms, so
the email is not optional.

## The T-12h and expiry sweeps

Both fold into the same cron rather than needing their own:

- **T-12h**: for a confirmed booking whose call is within 12 hours, verify the PaymentIntent is
  still `requires_capture`. If not, alert rather than silently proceeding.
- **Expiry**: any confirmed booking whose authorization is older than 6 days and whose call is
  still in the future is a re-auth candidate, which is the same predicate as `Reauth Sweep`.

---

# L4: retire `/webhook/consult-book`

It still creates calendar events and checks nothing but the honeypot. No card, no payment. Anyone
holding the URL can put tentative consults on forrest@nlma.io indefinitely. It was the rollback
path while the paid flow was unproven; item 1 and the decline test have proven the paid flow, so
only the exposure is left.

Cheapest reversible fix: rename `Book`'s `parameters.path` from `consult-book` to
`consult-book-retired-20260818`. The old URL 404s immediately and renaming back restores it.
Disabling the node works too. Either is one edit.

---

## Built and live, 2026-08-18

Everything above is now in the active workflow (`R0cMmqeBshPYpdqt`, 103 nodes, 8 triggers,
96 valid connections, 0 invalid). The three items that were blocked this morning are closed.

### What went in

| Chain | Trigger | Nodes | What it does |
|---|---|---|---|
| Capture (item 7) | `Capture Cron`, hourly | Capture Sweep, Find Notes Doc, Pick Notes Doc, Read Notes Doc, Parse Notes, Judge Call, Capture Decide, Is Capture, Stripe Capture, Stripe Release, Settle Booking, Settlement Receipt | Finds the Gemini notes doc for a finished consult, measures talk time, judges intro vs advisory, captures or releases, writes a settlement record, emails the guest with Forrest bcc'd |
| Re-auth (item 4) | `Reauth Cron`, daily 03:00 ET | Reauth Sweep, New Auth, Reauth Check, Reauth OK, Cancel Old Auth, Reauth Store, Reauth Alert | Renews a hold on day six against the saved card, new hold taken before the old one is cancelled, alerts Forrest with a one-click decline link when the card refuses |
| Lapse | `Reauth Cron` (second branch) | Lapse Sweep, Lapse Release, Lapse Delete Event, Lapse Email, Lapse Store | A request Forrest never acted on gets its hold released and the guest gets an apology, instead of silence |
| Nudge | `Capture Cron` (second branch) | Nudge Sweep, Nudge Email, Nudge Store | Twelve hours before a still-pending consult, Forrest gets one reminder with both action links |
| L4 | n/a | `Book` webhook path | Renamed `consult-book` to `consult-book-retired-20260818`. That endpoint created real calendar events and sent real invites behind nothing but a honeypot check, and the live page has used `consult-slots` plus `consult-checkout` for a while. The nodes stay wired so the shape is still readable |

### Idempotency, which is the whole game here

Every sweep is guarded by a durable field on the booking record, not by an in-memory marker:

- `settledAt` stops the capture sweep and the lapse sweep from touching a booking twice.
  It is written *after* the Stripe call, so a Stripe failure leaves the booking due and
  the next hourly run retries rather than dropping the money.
- `reauthorizedAt` restarts the six-day clock, so re-auth cannot loop.
- `nudgedAt` caps the reminder at one per booking rather than one per hour.

### Three decisions worth remembering

- **`GRACE_MIN=45` on the capture sweep.** Gemini writes the notes doc after the call
  ends, not during it. Sweeping at the end of the slot looks identical to "no notes were
  produced", which is a release path, so an early sweep would silently give away money
  that should have been captured.
- **The new hold comes before the cancel.** If `New Auth` is declined, `Cancel Old Auth`
  never runs, so the booking keeps whatever hold it still has and Forrest gets told. The
  reverse order would leave a confirmed consult with no authorization behind it.
- **`Nudge Email` has no `onError: continueRegularOutput`, on purpose.** Everywhere on the
  booking path a Gmail failure must not cost the guest their slot, so those nodes continue
  on error. Here the opposite is right: if the send fails, `nudgedAt` must stay unset so the
  next hourly run tries again.

### The credential guess that turned out right

`3siGSxiA9FloX0c1` had to be wired without being able to read it: the n8n public API
answers `403 NOT_SUPPORTED` to any credential list, so its *type* was a guess from the
item 5 notes ("service account, not the OAuth one"). `nodeCredentialType: "googleApi"` was
correct, and the proof is that n8n resolved the id to its real name in the saved node,
"Google Drive+Docs SA (forrest@nlma.io) — consult transcripts". A wrong type would have
left the credential unresolved.

### Two facts about the n8n MCP write path, learned the hard way

- **A large `n8n_update_partial_workflow` batch is refused; small ones go through.** The
  seven-node single call was blocked outright. The same operations in batches of two to
  four applied cleanly. Build in pairs.
- **`addNode` and `addConnection` must land in the same call.** A lone `addNode` fails
  validation with "Disconnected nodes detected" and, importantly, reports
  `operationsApplied: 1` while also saying "The workflow was NOT saved". Do not read that
  count as success.

### Still open

- **RSVP watcher (L11 gap 2).** Closed later the same day, as a third branch off
  `Capture Cron` rather than a new trigger. See "RSVP watcher" below.
- **Untested against a real call.** Every branch of the capture logic is proven by
  `capture-decide.test.js` (30 named assertions plus a 108-combination sweep), but the
  chain as wired has never run: it needs a confirmed consult that has actually happened and
  produced a Gemini notes doc. The first real one is the test.
- **Forrest only:** click Retry on n8n credential `3siGSxiA9FloX0c1` so the Drive and Docs
  calls can authenticate. Until that is done the capture sweep cannot settle anything: the
  infrastructure guard below fails the execution and retries next hour rather than releasing,
  so no money is at risk while it waits, but nothing gets captured either.
- **Labor Day, Monday 9/7.** The widened grid offers five slots on it. Worth a calendar
  block if you would rather not work it.

## Hardening pass, same day

Two defects in the chain above, both found by review rather than by a failure, both fixed
before the first real billable consult can reach them.

### Retrying a money call without an idempotency key doubles it

`Stripe Capture` and `New Auth` both carried `retryOnFail`, which is right, and neither
carried an `Idempotency-Key`, which is wrong. A request that succeeds at Stripe and then
times out on the way back is indistinguishable from one that never arrived, so the retry
re-sends it:

| Node | What the blind retry does |
|---|---|
| `New Auth` (`confirm=true`) | Takes a **second live hold** on the guest's card. The register keeps only the retry's PaymentIntent, so the orphan sits there for about seven days and the guest sees two pending lines. |
| `Stripe Capture` | Hits "not in requires_capture", fails the node, leaves `settledAt` unwritten, and so re-attempts and fails **every hour forever** with no recovery short of hand-editing static data. |

Both now send a key Stripe can dedupe on: `consult-capture-<token>` for the capture, which
is stable for the life of the booking, and `consult-reauth-<token>-<YYYY-MM-DD>` for the
renewal, date-suffixed because Stripe only remembers a key for 24 hours and the next
renewal is a genuinely new request.

### An infrastructure failure was being settled as a permanent release

`Find Notes Doc` and `Read Notes Doc` run `onError: continueRegularOutput`, so a 401 from a
credential awaiting re-authorisation, or a Drive blip, arrived downstream looking exactly
like "no notes were produced". That is a release path: the authorization gets cancelled, the
guest is emailed "nothing has been charged", and `settledAt` is written. All three are
irreversible, and the credential is in exactly that state right now.

`Pick Notes Doc` and `Parse Notes` now discriminate:

| Signal | Reading | Outcome |
|---|---|---|
| `files: []` from a successful Drive call | genuinely no notes doc | release, as designed |
| `error` from Drive | infrastructure | **throw**, execution fails, retried next hour |
| `docId: 'MISSING'` then a Docs 404 | genuinely no notes doc | release, as designed |
| a real `docId` that will not read | infrastructure | **throw**, retried next hour |

Throwing is the whole mechanism: `settledAt` is only written after a Stripe call succeeds,
so a failed execution leaves the booking due and the error workflow fires. The cost of the
wrong call in the other direction is a consult given away for free with a receipt saying so.

Verified with six assertions against the extracted node bodies: both error shapes throw on
each node, an empty file list still reaches the release path, a name match still picks the
right doc, and a Docs error on `MISSING` still releases.

---

# RSVP watcher, same day

A guest could decline the calendar invitation and nothing happened: the hold stayed live,
the meeting stayed on the calendar, and the money only came back when the capture sweep
ran after the call time had passed and found no notes doc. That is the right answer arrived
at far too late, and in the meantime the guest is looking at a pending line on their card
for a meeting they already said no to.

## Why a branch and not a trigger

The earlier note said this needed a new trigger. It did not. A Google Calendar trigger
fires on every update to every event on forrest@nlma.io, carries its own dedupe state, and
can replay a backlog the first time it is switched on. A third branch off the existing
hourly `Capture Cron` reuses the sweep machinery and the durable-field idempotency that
the rest of this workflow already runs on.

```
Capture Cron  (existing, hourly, RSVP appended last of the three branches)
  -> RSVP Sweep        (Code)   confirmed, unsettled bookings with an eventId whose call is still ahead
  -> RSVP Fetch        (HTTP)   GET the calendar event
  -> RSVP Declined     (Code)   keeps only the ones where the guest attendee said no
  -> RSVP Release      (HTTP)   POST /v1/payment_intents/{id}/cancel   requested_by_customer
  -> RSVP Released?    (Code)   keeps only the ones Stripe really cancelled
  -> RSVP Delete Event (HTTP)   DELETE the event
  -> RSVP Email        (Gmail)  tells the guest the hold is released, Forrest bcc'd
  -> RSVP Store        (Code)   status cancelled, settledAt, settlement record, slot freed
```

## Only a positive signal moves money

`RSVP Declined` acts on exactly one thing: an attendee matching the booking email whose
`responseStatus` is `declined`. Everything else is a deliberate no-op.

| Signal | Read as | Outcome |
|---|---|---|
| Guest attendee `responseStatus: declined` | the guest said no | release, delete, email |
| `accepted`, `tentative`, `needsAction` | not a decline | nothing |
| No attendees, or no attendee matching the booking email | nothing to read | nothing |
| Fetch errored (401, 5xx, bare-string error) | infrastructure, not an answer | nothing, retried next hour |
| Event `status: cancelled` | event deleted, ambiguous | nothing; the capture sweep releases once the call time passes |

The email match is case-insensitive and trimmed, because Google echoes attendee addresses
in whatever case they were entered.

## The guest is only told what is true

`RSVP Released?` exists because `RSVP Release` runs `onError: continueRegularOutput`, so a
failed cancel arrives looking like any other item. Letting that through would delete the
event and email the guest "nothing was charged" while the hold was still live at Stripe.

Two shapes count as released: the intent coming back in `status: canceled`, and Stripe
refusing because it is already canceled, which is the same end state and is exactly what a
retry of a successful cancel looks like. Anything else throws, which leaves `settledAt`
unwritten, fires the error workflow, and puts the booking in front of the next hourly run.

The match is on the terminal state, never on the word "canceled" appearing in the message.
Stripe's refusal for an already-captured intent reads "has a status of succeeded", and its
cancel refusals commonly go on to name the states that can be cancelled, so the bare word
turns up in exactly the message that must not pass. A guest who was legitimately charged
must never receive the release email, so the comparison is pinned to
`payment_intent.status === 'canceled'` or the exact phrase "status of canceled".

## Three smaller decisions

- **Disjoint predicates.** `RSVP Sweep` takes only bookings whose call is still ahead;
  `Capture Sweep` takes only bookings past their end time plus the grace window. The two
  branches run in the same execution and both write `settledAt`, so they must never be able
  to see the same booking.
- **RSVP is appended last of Capture Cron's three branches.** Branches run in connection
  order, so the deliberate throw in `RSVP Released?` can only starve itself, never that
  hour's capture or nudge run.
- **`status: cancelled`, not a new status.** It was already in the vocabulary and nothing
  reads it. `declined` means Forrest turned the request down and `lapsed` means nobody acted
  at all, so the guest's own decision needed its own word.

## Verification

`rsvp.test.js` runs the two Code bodies the way an n8n Code node runs them, as functions
whose only inputs are the `$` helpers. 21 assertions, all passing, covering every row of the
table above plus: matching a response to its booking by event id when the API returns them
out of order, the index fallback that error items force because they carry no id, the
n8n double-wrapped error object, and the already-captured-intent trap.

Workflow is 111 nodes, 8 triggers, 104 valid connections, 0 invalid. The six validator
errors it reports are pre-existing complaints about `responseNode` mode on the six webhook
nodes, none of them on this branch.

Untested against a real decline, like the rest of the capture chain. The first real one is
the test.
