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
