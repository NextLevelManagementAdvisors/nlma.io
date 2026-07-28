# Consult authorization hold — design

**Date:** 2026-07-27
**Status:** Approved design, pre-implementation
**Supersedes nothing.** Extends `2026-07-21-consult-scheduling-design.md`.

## Problem

`nlma.io/consults` currently lets anyone book a free discovery consult with no
payment instrument of any kind. Two consequences:

1. **Spam bookings.** A bot or time-waster occupies a real calendar slot at zero cost.
2. **Free-riding on billable advice.** A visitor books a "free intro" and then asks
   for work that is plainly a billable hour.

There is also a concrete bypass in the current implementation. `consults.html:403-404`
renders a **"Request a free intro instead →"** button that sets `billable=false` and
`price=0` **client-side**, then submits to the free booking webhook. The free branch
(`consult-book` → `Book Prep`) validates name, email, duration and slot but **never
re-checks `billable`**. The billable branch (`consult-checkout`) does re-triage
server-side and cannot be spoofed; the free branch has no equivalent guard. So today a
visitor can request billable advice, click that button, and book a free consult with no
card and no triage.

## Requirement

Every scheduled consult must be backed by an authorization hold of **at least 15 minutes**
of advisory time — $112.50 at the standing $450/hr rate.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Who decides bill/no-bill | **Forrest approves; nothing auto-captures** | An LLM misreading a call would otherwise charge a real client unprompted. Matches existing HITL patterns for money and outward actions. |
| Billable path | **Unchanged — prepay in full** | Already far above a 15-min floor. Keeps blast radius on the free path plus a new post-call branch. That path has never processed a real payment, so it is not being rewritten in the same change. |
| Phone consults | **Discovery is Meet-only** | Phone leaves no Drive artifact. Google Voice Call Notes is unverified and its MCP tool currently crashes the server (gsuite-mcp#144). Phone remains available for billable consults, which need no post-call decision. |
| Hold horizon | **Keep 21 days; re-authorize before the call** | Preserves the booking horizon. Costs a nightly job, a Stripe key scope change, and a decline path. |
| Decline policy | **Guest re-confirms; cancel at T−12h if unresolved** | Protects the calendar from cards that die, without cancelling a real client over an expired card. |
| Disclosure | **Plain language on the booking form + full clause in /terms** | A client who learns about transcript-driven billing only from a charge has a strong dispute. |
| Architecture | **n8n orchestrates; sidecar owns the money links** | n8n cannot `require('crypto')`, so HMAC validation must live in the sidecar. n8n already has Google OAuth, cliproxy and Gmail. |

## Verified constraints

These are measured facts, not assumptions. They drive the design.

- **Authorization validity is 7 days.** Card-not-present customer-initiated
  transactions: 7 days on Visa, Mastercard, Amex, Discover. Nothing is charged during
  the window; uncaptured funds release automatically and the PaymentIntent goes to
  `canceled`. Per-payment deadline is readable at
  `charge.payment_method_details.card.capture_before`.
- **Off-session re-auth is a merchant-initiated transaction (MIT).** Visa allows MITs
  only **4 days 18 hours** — shorter than the 7-day CIT window. The re-auth job must
  therefore fire close to the call, not early.
- **30-day extended authorizations are not available.** They are an IC+ pricing
  feature; this account is on blended pricing. Non-lodging merchant categories also
  incur an added 0.08% Visa fee. Would require a Stripe support request.
- **n8n code nodes cannot `require('crypto')`** (`NODE_FUNCTION_ALLOW_BUILTIN` unset),
  and the webhook node's `rawBody` arrives already parsed. This is why
  `consult-stripe-verify` exists. HMAC cannot be validated inside n8n.
- **The sidecar is stdlib-only Python.** No Google libraries; it cannot read Drive
  without new dependencies.
- **Meet transcripts and Gemini notes are both supported on this Workspace** —
  confirmed by live artifacts under `admin@fidumcompany.com`
  (`ZIP-A-DEE : Fidum – 2024/11/04 09:28 EST – Transcript`,
  `Caleb DeHart — re: buying the Vue - 2026/07/22 09:04 EDT - Notes by Gemini`).
  Meet transcription requires Business Standard or above, so that is the tier floor.
- **Transcript capture is not automatic and not always usable.** One observed Gemini
  notes doc is only 3.5 KB (`Meeting started 2026/07/11 10:44 EDT`), i.e. a near-empty
  capture. The analyzer must handle absent and unusable transcripts.

## Unverified — must be confirmed before implementation

- **Does `forrest@nlma.io` generate transcripts?** Consults are organized on that
  calendar, but the confirming Drive query timed out (300s) and the check never
  completed. All positive evidence so far is from `admin@fidumcompany.com`. If the
  organizer account does not produce transcripts, the analyzer has nothing to read.
- **Is `consult-stripe-verify` actually running?** Could not be confirmed:
  `systemctl` fails from Shell_VPS ("Failed to connect to bus") and port probes return
  empty because that tool runs in a separate network namespace. Treat as a pre-flight
  check, not a given.

## Architecture

### Both paths converge on one Stripe flow

Rather than bolting a card onto the free branch, both paths become the same Checkout
flow with different parameters:

| Parameter | Discovery | Billable |
|---|---|---|
| `mode` | `payment` | `payment` |
| `capture_method` | `manual` | automatic (default) |
| `unit_amount` | `11250` | `Math.round(450 × dur/60 × 100)` |
| `setup_future_usage` | `off_session` | — |
| `customer_creation` | `always` | — |

Both land in the existing signature-verified `consult-paid` webhook. This reuses working
machinery instead of duplicating it, and the free path stops being a separate un-gated
door.

### Critical gotcha — the guard must change

With `capture_method=manual`, `checkout.session.completed` arrives with
`payment_status: "unpaid"`, not `"paid"`. The current `Paid Guard` books only when
`payment_status == "paid"`. **Left unchanged, every held discovery booking is silently
rejected.** The guard must accept either:

- `payment_status == "paid"` (billable, auto-captured), or
- the retrieved PaymentIntent in status `requires_capture` (discovery hold placed).

The existing two-layer defence is preserved: edge HMAC signature verification in the
sidecar, then server-side re-fetch of the session from Stripe. Neither layer is relaxed.

### Closing the bypass

`consult-book` gains **server-side re-triage**, mirroring `consult-checkout`. If triage
returns billable, it responds 402 and the client is routed to the paid flow. The
`requestFree` button survives as a legitimate "this is simpler than you sized it"
affordance, but the server decides, not the client.

### Durable consult record

Current holds live in n8n `staticData` with a 15-minute TTL — correct for slot races,
wrong for state that must survive booking → call → transcript → approval across days.
The sidecar also needs to map an approval token to a PaymentIntent independently of n8n.

**The sidecar owns a SQLite table** as the single source of truth for money state:

```
consultId        TEXT PRIMARY KEY
paymentIntentId  TEXT
customerId       TEXT
paymentMethodId  TEXT
holdAmount       INTEGER   -- cents
holdExpiry       TEXT      -- ISO, from capture_before
consultStart     TEXT      -- ISO
durationMin      INTEGER
eventId          TEXT      -- Google Calendar event
email            TEXT
name             TEXT
status           TEXT      -- held | needs_reconfirm | awaiting_approval
                           -- | captured | released | cancelled
verdict          TEXT      -- in_scope | billable | unclear | none
transcriptDocId  TEXT
createdAt        TEXT
updatedAt        TEXT
```

Money state stops living in a store a workflow edit can wipe. `staticData` keeps its
existing 15-minute slot-hold role, unchanged.

## Components

### n8n `NLMA Consults` (id `R0cMmqeBshPYpdqt`) — additions

1. **`Book Re-Triage`** — cliproxy call on the free branch, mirroring `Checkout Triage`.
   Billable → 402.
2. **`Transcript Poll`** — schedule trigger, hourly. Selects records where
   `status = held`, the call ended more than 20 minutes ago, and `verdict = none`.
   Searches Drive for a transcript or Gemini notes matching the event.
   Because artifacts can take up to about an hour to appear, a poll that finds nothing is
   not a failure — the record keeps `verdict = none` and is simply picked up by the next
   hourly run. Only after 24 hours of empty polls does it escalate to the manual-decision
   email.
3. **`Analyze`** — cliproxy `gpt-5.5` (Claude models persona-refuse this prompt shape on
   this cliproxy). Returns
   `{verdict, rationale, evidence, recommended_amount_cents}`.
   **Proposes only; never acts.**
4. **`Verdict Email`** — Gmail (cred `Po71UEDidkAwWYqo`) to Forrest: verdict, rationale,
   an evidence quote with timestamp, and two signed links.
5. **`Nightly Re-Auth`** — schedule trigger ~02:00 ET. Selects records whose consult is
   within 3 days and whose hold will not survive to `consultStart + 12h`. Creates an
   off-session manual-capture PaymentIntent against the saved payment method.
6. **`T-12h Sweep`** — hourly. Records in `needs_reconfirm` with the consult inside 12
   hours: cancel the Calendar event, email the guest, notify Forrest, free the slot.

Hourly rather than more frequent polling is deliberate: this instance has a recurring
`execution_data` bloat problem, so execution count is kept low.

### Sidecar `consult-stripe-verify` (`/opt/consult-stripe-verify`, :3071) — additions

Existing responsibility (Stripe webhook signature verification) is unchanged.

- **`GET /consult-capture?t=<token>`** — HMAC-SHA256 over `{consultId, action, exp}`,
  compared with `hmac.compare_digest`. Verifies expiry. Captures the PaymentIntent.
  Idempotent. Returns a plain HTML confirmation.
- **`GET /consult-release?t=<token>`** — same verification. Cancels the PaymentIntent,
  releasing the hold. Idempotent.
- **`POST /consult-record`** — authenticated write endpoint for n8n (shared secret in
  the sidecar `.env`, chmod 600, same pattern as `STRIPE_WHSEC`).

Token expiry is `holdExpiry − 6h`, deliberately identical to the auto-release deadline.
These two values must stay equal: if the token expired earlier than auto-release, there
would be a window in which Forrest's approval link returns 400 while the hold is still
live and uncaptured — a click that silently does nothing. After auto-release the record
is terminal, so a later click is an idempotent no-op rather than an error.

### Capture is capped at the authorized amount

A PaymentIntent can never capture more than it authorized. The discovery hold is
$112.50, so that is the ceiling regardless of what the transcript shows. Capture amount
is `min(recommended_amount_cents, holdAmount)`.

If the analyzer concludes the call delivered materially more than 15 minutes of billable
advice, the verdict email states the excess explicitly as a note — for example
"45 min of billable advice; $112.50 capturable, $225.00 beyond the hold". Collecting
that excess is a manual decision for Forrest (invoice or a follow-up charge) and is
**out of scope for automation**. Nothing charges the saved card beyond the hold without
Forrest initiating it separately.

### Frontend `consults.html`

- Disclosure text immediately before card entry: the call is transcribed, the transcript
  is reviewed to confirm the call stayed within a free intro, a $112.50 authorization
  hold is placed and released unless the call becomes paid advice.
- Medium selector: phone hidden unless triage returns billable.
- Line 220 currently reads *"Free intro calls book instantly."* — **now false**. Must be
  rewritten.
- Free path redirects to Stripe Checkout rather than booking inline. The 3-step widget
  keeps its shape; step 3 moves to `/consults/confirmed` for both paths.

### `/terms`

Full clause covering: the authorization hold and its amount, card-on-file storage and
re-authorization, transcript review as the billing criterion, and transcript retention.

## Data flow

```
BOOK  → server re-triage
        billable? → 402, route to paid flow
        free?     → Checkout (manual capture, $112.50, save card)
      → consult-paid: verify signature → re-fetch session
      → confirm PaymentIntent requires_capture
      → POST /consult-record (status=held, eventId null)   [record FIRST]
      → create Calendar event (Meet)
      → PATCH record with eventId

T−3d  → hold will not survive to consultStart+12h?
        → off-session re-auth (MIT window: Visa 4d18h)
        → success: update record with new PI + expiry
        → decline: email guest re-confirm link, alert Forrest,
                   status = needs_reconfirm

T−12h → still needs_reconfirm?
        → cancel Calendar event, email guest, notify Forrest

CALL  → Meet transcript / Gemini notes land in Drive

+1h   → Transcript Poll finds doc → Analyze → Verdict Email
        status = awaiting_approval

CLICK → sidecar verifies HMAC → capture or cancel → status terminal

NEVER → auto-release at holdExpiry − 6h, Forrest notified
```

## Error handling

| Failure | Behaviour |
|---|---|
| No transcript after 24h | Manual-decision email, no AI verdict |
| Transcript present but unusable (e.g. 3.5 KB stub) | Treated as `unclear` → manual email |
| Analyzer returns unparseable output | Treated as `unclear` → manual email |
| Forrest never clicks | **Auto-release** at `holdExpiry − 6h`, Forrest notified |
| Off-session re-auth declines | Guest re-confirm link; cancel at T−12h |
| Stripe capture fails | Alert, record preserved, retry-able |
| Sidecar down | Links fail loudly; record intact, nothing lost |
| Approval link replayed | Idempotent no-op |
| Approval link forged or expired | 400, no state change |
| Slot taken between checkout and payment | Existing auto-refund + apology email path, unchanged |
| Record write fails after hold placed | `retryOnFail` 3×; if still failing, alert Forrest with the PaymentIntent id so the hold can be released manually. Without a record nothing else would ever release it — this is why the record is written **before** the Calendar event. |
| Calendar event creation fails after record write | Record exists, so the hold is recoverable: release it, email the guest, notify Forrest. Recoverable by design; the reverse order would not be. |
| Capture recommended above the hold amount | Capture capped at `holdAmount`; excess surfaced in the email as a manual note, never auto-charged |

**Every ambiguous path resolves to release, never to charging.** The default outcome of
any failure, timeout, or uncertainty is that the client is not charged.

## Testing

- **Analyzer fixtures from real data.** Existing transcripts in Drive
  (`ZIP-A-DEE : Fidum`, `Bookkeeping Hours (Daniel Lucas)`) serve as fixtures for
  in-scope versus billable classification, plus the 3.5 KB stub as the unusable case.
  Real transcripts, not synthetic ones.
- **HMAC:** forged token → 400; expired token → 400; valid → acts exactly once;
  replay → idempotent no-op.
- **Decline path:** Stripe test card `4000000000000341` (attaches successfully, fails
  on off-session use).
- **Guard regression:** assert a `requires_capture` PaymentIntent books, and that an
  unpaid session with no PaymentIntent still does not.
- **Full end-to-end in Stripe test mode before going live.** This is the smoke test
  deferred in the original build (which chose to let the first real customer payment be
  the test). It can now run without a real customer.

## Manual prerequisites — Forrest only

1. **Add `Customers` (write) scope to the `nlma-consults-booking` restricted key.**
   Required to save cards for re-authorization. Dashboard-only; cannot be done via API.
   Existing scopes already cover Checkout Sessions, PaymentIntents, Charges & Refunds,
   Webhooks, Events.
2. **Confirm `forrest@nlma.io` produces Meet transcripts** (see Unverified, above).

## Risks

- **Revenue released if Forrest is away.** Auto-release on no click is deliberate — the
  safe default is not charging. Accepted.
- **Card-on-file raises the disclosure bar.** Storing a payment method for later
  re-authorization is a stronger commitment than a one-time hold and is reflected in the
  /terms clause.
- **MIT window is tighter than the CIT window.** Re-auth has 4d18h on Visa, not 7 days,
  so the nightly job must fire close to the call. Firing too early wastes the
  authorization.
- **Transcript-driven billing depends on capture discipline.** If a Meet call is not
  transcribed, the decision falls back to Forrest's recall. The system degrades to
  manual rather than failing.
- **The free path is no longer instant.** It now involves a Stripe redirect. This is a
  deliberate conversion cost in exchange for the spam gate.

## Out of scope

- Migrating `httplib2` → `AuthorizedSession` in gsuite-mcp (tracked in gsuite-mcp#144).
- Google Voice Call Notes integration for phone consults (blocked on #144; avoided by
  the Meet-only decision).
- Extended 30-day authorizations (requires IC+ pricing).
- Any change to the billable prepay path beyond the shared-Checkout parameterization.
