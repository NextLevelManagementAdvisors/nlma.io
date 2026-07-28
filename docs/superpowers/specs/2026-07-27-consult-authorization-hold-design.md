# Consult authorization hold — design

**Date:** 2026-07-27
**Status:** Approved design, pre-implementation
**Extends:** `2026-07-21-consult-scheduling-design.md`

Built from four systems only: **nlma.io**, **n8n.nlma.io**, **crm.nlma.io** (Twenty), and
**Stripe**. No new services and no new database.

## Problem

`nlma.io/consults` currently lets anyone book a free discovery consult with no payment
instrument of any kind. Two consequences:

1. **Spam bookings.** A bot or time-waster occupies a real calendar slot at zero cost.
2. **Free-riding on billable advice.** A visitor books a "free intro" and then asks for
   work that is plainly a billable hour.

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
| Billable path | **Unchanged — prepay in full** | Already far above a 15-min floor. Keeps blast radius on the free path plus new post-call branches. That path has never processed a real payment, so it is not being rewritten in the same change. |
| Phone consults | **Discovery is Meet-only** | Phone leaves no Drive artifact. Google Voice Call Notes is unverified and its MCP tool currently crashes the server (gsuite-mcp#144). Phone remains available for billable consults, which need no post-call decision. |
| Hold horizon | **Keep 21 days; re-authorize before the call** | Preserves the booking horizon. Costs a nightly job and a decline path. |
| Decline policy | **Guest re-confirms; cancel at T−12h if unresolved** | Protects the calendar from cards that die, without cancelling a real client over an expired card. |
| Disclosure | **Plain language on the booking form + full clause in /terms** | A client who learns about transcript-driven billing only from a charge has a strong dispute. |
| Record store | **Twenty Opportunity (business record) + Stripe (operational state)** | No new database. Consults become visible against the Person in the CRM. Stripe already holds every operational field natively. |
| Approval mechanism | **Unguessable UUID capability link, not HMAC** | n8n cannot `require('crypto')`. A Twenty record UUID is 122 bits of entropy and is never shown to the guest, which satisfies the actual security requirement without a signing sidecar. |

## Verified constraints

Measured facts, not assumptions. These drive the design.

- **Authorization validity is 7 days.** Card-not-present customer-initiated transactions:
  7 days on Visa, Mastercard, Amex, Discover. Nothing is charged during the window;
  uncaptured funds release automatically and the PaymentIntent goes to `canceled`.
  Per-payment deadline is readable at
  `charge.payment_method_details.card.capture_before`.
- **Off-session re-auth is a merchant-initiated transaction (MIT).** Visa allows MITs
  only **4 days 18 hours** — shorter than the 7-day CIT window. The re-auth job must
  therefore fire close to the call, not early.
- **30-day extended authorizations are not available.** They are an IC+ pricing feature;
  this account is on blended pricing. Non-lodging merchant categories also incur an added
  0.08% Visa fee. Would require a Stripe support request.
- **n8n code nodes cannot `require('crypto')`** (`NODE_FUNCTION_ALLOW_BUILTIN` unset), and
  the webhook node's `rawBody` arrives already parsed. This is why the
  `consult-stripe-verify` sidecar exists and why the approval mechanism below avoids
  HMAC entirely.
- **Stripe PaymentIntent metadata is mutable after creation.** This is what allows the
  Calendar `eventId` to be stored operationally without a separate database.
- **Meet transcripts and Gemini notes are both supported on this Workspace** — confirmed
  by live artifacts under `admin@fidumcompany.com`
  (`ZIP-A-DEE : Fidum – 2024/11/04 09:28 EST – Transcript`,
  `Caleb DeHart — re: buying the Vue - 2026/07/22 09:04 EDT - Notes by Gemini`).
  Meet transcription requires Business Standard or above, so that is the tier floor.
- **Transcript capture is not automatic and not always usable.** One observed Gemini notes
  doc is only 3.5 KB (`Meeting started 2026/07/11 10:44 EDT`), i.e. a near-empty capture.
  The analyzer must handle absent and unusable transcripts.
- **`crm.nlma.io` is live** and serving Twenty.
- **No Google Drive credential exists in n8n.** The `DocuSeal → Drive + Gmail` workflow
  (`OVVA1Ea0VzFGwFYr`) has a `googleDrive` node with **no credentials attached** and has
  never run (`triggerCount: 0`). The Consults workflow's Google credential
  (`kKPeZuvma85RLakQ`) is calendar-scoped.
- **Twenty has no n8n integration today.** No workflow among the 54 on this instance
  references Twenty or `crm.nlma.io`.

## Unverified — confirm before implementation

- **Does `forrest@nlma.io` generate Meet transcripts?** Consults are organized on that
  calendar, but the confirming Drive query timed out (300 s) and never completed. All
  positive evidence so far is from `admin@fidumcompany.com`. If the organizer account does
  not produce transcripts, the analyzer has nothing to read and the post-call branch
  degrades to manual.
- **Is `consult-stripe-verify` running?** Could not be confirmed: `systemctl` fails from
  Shell_VPS ("Failed to connect to bus") and port probes return empty because that tool
  runs in a separate network namespace. Pre-flight check, not a given.

## System responsibilities

| System | Role |
|---|---|
| **nlma.io** | Booking widget, disclosure copy, `/terms` clause |
| **n8n.nlma.io** | All logic: re-triage, checkout creation, paid guard, transcript poll, analysis, verdict email, approve/release webhooks, nightly re-auth, T−12h sweep |
| **crm.nlma.io** | System of record (Twenty Opportunity linked to a Person) and UUID source |
| **Stripe** | Hold, capture, cancel, off-session re-auth, and all operational state |

The existing `consult-stripe-verify` sidecar is **unchanged**. It keeps its single job of
verifying Stripe webhook signatures for `consult-paid`. Nothing is added to it. It is not
retired because n8n provably cannot verify an HMAC over a raw request body, and removing
it would drop the paid path from two security layers to one.

## Architecture

### Both paths converge on one Stripe flow

Rather than bolting a card onto the free branch, both paths become the same Checkout flow
with different parameters:

| Parameter | Discovery | Billable |
|---|---|---|
| `mode` | `payment` | `payment` |
| `capture_method` | `manual` | automatic (default) |
| `unit_amount` | `11250` | `Math.round(450 × dur/60 × 100)` |
| `setup_future_usage` | `off_session` | — |
| `customer_creation` | `always` | — |
| `metadata[consultId]` | Twenty Opportunity UUID | Twenty Opportunity UUID |

Both land in the existing signature-verified `consult-paid` webhook. This reuses working
machinery instead of duplicating it, and the free path stops being a separate un-gated
door.

### Critical gotcha — the paid guard must change

With `capture_method=manual`, `checkout.session.completed` arrives with
`payment_status: "unpaid"`, not `"paid"`. The current `Paid Guard` books only when
`payment_status == "paid"`. **Left unchanged, every held discovery booking is silently
rejected.** The guard must accept either:

- `payment_status == "paid"` (billable, auto-captured), or
- the retrieved PaymentIntent in status `requires_capture` (discovery hold placed).

The existing two-layer defence is preserved: edge signature verification in the sidecar,
then server-side re-fetch of the session from Stripe. Neither layer is relaxed.

### Closing the bypass

`consult-book` gains **server-side re-triage**, mirroring `consult-checkout`. If triage
returns billable, it responds 402 and the client is routed to the paid flow. The
`requestFree` button survives as a legitimate "this is simpler than you sized it"
affordance, but the server decides, not the client.

### Stripe is the operational store

Every field the money machine needs already exists in Stripe. No database is added:

| Operational field | Location in Stripe |
|---|---|
| `paymentIntentId` | the PaymentIntent object |
| `holdExpiry` | `charge.payment_method_details.card.capture_before` |
| `status` | PI status: `requires_capture` / `succeeded` / `canceled` |
| `consultStart`, `durationMin`, `name`, `email`, `medium`, `request` | Checkout `metadata` (existing pattern) |
| `consultId` | Checkout `metadata[consultId]` — the Twenty UUID |
| `customerId`, `paymentMethodId` | Customer + PaymentMethod, created by `setup_future_usage` |
| `eventId` | written to PI metadata after the Calendar event is created |

### Twenty is the business record

A **stock Opportunity**, linked to a Person via `pointOfContact`. Stock stages are left
alone; consult state lives in a custom field so it never fights Twenty's own semantics.

Stock fields used: `name`, `amount`, `closeDate`, `pointOfContact`, `stage`.

**Four custom fields** to add:

| Field | Type | Purpose |
|---|---|---|
| `consultStatus` | Select | `pending_payment`, `held`, `awaiting_approval`, `needs_reconfirm`, `captured`, `released`, `cancelled` |
| `verdict` | Select | `none`, `in_scope`, `billable`, `unclear` |
| `transcriptLink` | Link | The Drive doc the verdict was based on |
| `paymentIntentId` | Text | Direct lookup; Stripe metadata search is the fallback |

The Opportunity's own record **UUID is the `consultId`** — no separate identifier field.

### Approval links: capability URLs, not signatures

```
https://n8n.nlma.io/webhook/consult-approve?id=<opportunity-uuid>&a=capture
https://n8n.nlma.io/webhook/consult-approve?id=<opportunity-uuid>&a=release
```

Security properties:

- **Unguessable.** Twenty generates UUIDv4 record IDs server-side — 122 bits of entropy.
- **Never exposed to the guest.** The UUID appears only in Forrest's email. The guest sees
  Stripe's hosted Checkout and `/consults/confirmed`, neither of which carries it.
  Guest-facing re-confirm links use a fresh Stripe-generated Checkout URL, so the UUID is
  never transmitted to the client.
- **Tampering with `a=` is not a threat.** Only Forrest holds the UUID and he is
  authorized for both actions.
- **Expiry is server-side state, not a signed claim.** The handler reads the PaymentIntent
  at click time; a PI that is no longer `requires_capture` is already terminal, so a stale
  link is an idempotent no-op rather than a replay.
- **The endpoint is public** (all n8n webhooks are). It gets the same nginx rate-limit
  treatment as `consult-intake`, and an unknown UUID returns a generic 404 that reveals
  nothing.

**Twenty is not in the money path.** At click time the handler resolves the PaymentIntent
either from the Opportunity's `paymentIntentId` field or, if Twenty is unreachable, by
querying Stripe directly:

```
GET /v1/payment_intents/search?query=metadata['consultId']:'<uuid>'
```

Two independent paths to the same PaymentIntent means a CRM outage cannot strand a live
authorization hold.

### Capture is capped at the authorized amount

A PaymentIntent can never capture more than it authorized. The discovery hold is $112.50,
so that is the ceiling regardless of what the transcript shows. Capture amount is
`min(recommended_amount_cents, 11250)`.

If the analyzer concludes the call delivered materially more than 15 minutes of billable
advice, the verdict email states the excess explicitly — for example "45 min of billable
advice; $112.50 capturable, $225.00 beyond the hold". Collecting that excess is a manual
decision (invoice or follow-up charge) and is **out of scope for automation**. Nothing
charges the saved card beyond the hold without Forrest initiating it separately.

## Components — n8n `NLMA Consults` (id `R0cMmqeBshPYpdqt`)

1. **`Book Re-Triage`** — cliproxy call on the free branch, mirroring `Checkout Triage`.
   Billable → 402.
2. **`Create Opportunity`** — Twenty GraphQL mutation; returns the UUID used as
   `consultId`. Runs *before* the Checkout session so the ID can be embedded in metadata.
3. **`Transcript Poll`** — schedule trigger, hourly. Finds PaymentIntents in
   `requires_capture` whose `metadata.consultStart` is more than 20 minutes past and whose
   Opportunity `verdict` is `none`. Searches Drive for a transcript or Gemini notes
   matching the event. Artifacts can take about an hour to appear, so an empty poll is not
   a failure — the record is picked up by the next hourly run. Only after 24 hours of
   empty polls does it escalate to the manual-decision email.
4. **`Analyze`** — cliproxy `gpt-5.5` (Claude models persona-refuse this prompt shape on
   this cliproxy). Returns `{verdict, rationale, evidence, recommended_amount_cents}`.
   **Proposes only; never acts.**
5. **`Verdict Email`** — Gmail (cred `Po71UEDidkAwWYqo`) to Forrest: verdict, rationale, an
   evidence quote with timestamp, and the two capability links.
6. **`Approve Webhook`** (`consult-approve`) — resolves the PI, checks it is still
   `requires_capture`, captures or cancels, updates the Opportunity, returns a plain
   confirmation page. Idempotent.
7. **`Nightly Re-Auth`** — schedule trigger ~02:00 ET. Finds consults within 3 days whose
   hold will not survive to `consultStart + 12h`. Creates an off-session manual-capture
   PaymentIntent against the saved payment method, then writes the new PI id to the
   Opportunity.
8. **`T-12h Sweep`** — hourly. Opportunities in `needs_reconfirm` with the consult inside
   12 hours: cancel the Calendar event, email the guest, notify Forrest, free the slot.
9. **`Expiry Sweep`** — hourly, same trigger as above. Two jobs:
   - **Auto-release:** any PaymentIntent still `requires_capture` within 6 hours of its
     `capture_before` is cancelled, the Opportunity set to `released`, and Forrest
     notified. This is what makes "no decision" resolve to "no charge" rather than
     depending on Stripe's own expiry, so the outcome is recorded in the CRM instead of
     silently lapsing.
   - **Orphan cleanup:** Opportunities left in `pending_payment` for more than 24 hours
     (checkout abandoned or never created) are set to `cancelled`.

Hourly rather than more frequent polling is deliberate: this instance has a recurring
`execution_data` bloat problem, so execution count is kept low (~50/day added).

### Frontend `consults.html`

- Disclosure text immediately before card entry: the call is transcribed, the transcript is
  reviewed to confirm the call stayed within a free intro, a $112.50 authorization hold is
  placed and released unless the call becomes paid advice.
- Medium selector: phone hidden unless triage returns billable.
- Line 220 currently reads *"Free intro calls book instantly."* — **now false**. Must be
  rewritten.
- Free path redirects to Stripe Checkout rather than booking inline. The 3-step widget keeps
  its shape; step 3 moves to `/consults/confirmed` for both paths.

### `/terms`

Full clause covering: the authorization hold and its amount, card-on-file storage and
re-authorization, transcript review as the billing criterion, and transcript retention.

## Data flow

```
BOOK  → server re-triage
        billable? → 402, route to paid flow
        free?     → create Twenty Opportunity (pending_payment)
                  → UUID becomes consultId
                  → Checkout (manual capture, $112.50, save card,
                    metadata[consultId]=UUID)

PAY   → consult-paid: sidecar verifies signature → re-fetch session
      → confirm PaymentIntent requires_capture
      → create Calendar event (Meet)
      → write eventId into PI metadata
      → Opportunity: consultStatus=held, paymentIntentId set

T−3d  → hold will not survive to consultStart+12h?
        → off-session re-auth (MIT window: Visa 4d18h)
        → success: update Opportunity with new PI id
        → decline: email guest a fresh Checkout link, alert Forrest,
                   consultStatus=needs_reconfirm

T−12h → still needs_reconfirm?
        → cancel Calendar event, email guest, notify Forrest,
          consultStatus=cancelled

CALL  → Meet transcript / Gemini notes land in Drive

+1h   → Transcript Poll finds doc → Analyze → Verdict Email
        consultStatus=awaiting_approval

CLICK → resolve PI (Opportunity field, or Stripe metadata search)
      → still requires_capture? → capture or cancel
      → consultStatus=captured | released

NEVER → auto-release at holdExpiry − 6h, Forrest notified
```

## Error handling

| Failure | Behaviour |
|---|---|
| Opportunity created but Checkout creation fails | Orphan Opportunity in `pending_payment`, no money involved. Swept after 24 h. Harmless — this is why the CRM record is created first. |
| No transcript after 24 h | Manual-decision email, no AI verdict |
| Transcript present but unusable (e.g. 3.5 KB stub) | Treated as `unclear` → manual email |
| Analyzer returns unparseable output | Treated as `unclear` → manual email |
| Forrest never clicks | **Auto-release** at `holdExpiry − 6h`, Forrest notified |
| Off-session re-auth declines | Guest re-confirm link; cancel at T−12h |
| Twenty unreachable at click time | Resolve the PI via Stripe metadata search; capture proceeds. Opportunity update retried separately. |
| Twenty unreachable at booking time | No UUID, so no booking. Fail closed with an apology and no charge. |
| Stripe capture fails | Alert, PI untouched, retry-able |
| Capture recommended above the hold amount | Capped at $112.50; excess surfaced as a manual note, never auto-charged |
| Approval link replayed | PI already terminal → idempotent no-op |
| Approval link with unknown UUID | Generic 404, no information disclosed |
| Slot taken between checkout and payment | Existing auto-refund + apology email path, unchanged |

**Every ambiguous path resolves to release, never to charging.** The default outcome of any
failure, timeout, or uncertainty is that the client is not charged.

## Testing

- **Analyzer fixtures from real data.** Existing transcripts in Drive
  (`ZIP-A-DEE : Fidum`, `Bookkeeping Hours (Daniel Lucas)`) serve as fixtures for in-scope
  versus billable classification, plus the 3.5 KB stub as the unusable case. Real
  transcripts, not synthetic ones.
- **Capability links:** unknown UUID → 404; valid → acts exactly once; replay → no-op;
  link used after auto-release → no-op.
- **Decline path:** Stripe test card `4000000000000341` (attaches successfully, fails on
  off-session use).
- **Guard regression:** assert a `requires_capture` PaymentIntent books, and that an unpaid
  session with no PaymentIntent still does not.
- **Twenty-down drill:** block the CRM and confirm capture still succeeds via Stripe
  metadata search, and that booking fails closed.
- **Full end-to-end in Stripe test mode before going live.** This is the smoke test
  deferred in the original build (which chose to let the first real customer payment be the
  test). It can now run without a real customer.

## Prerequisites — Forrest only

These are UI/OAuth steps that cannot be automated.

1. **Google Drive access for n8n.** No Drive credential exists. Either create a
   `googleDriveOAuth2Api` credential (browser consent flow) or grant the existing service
   account at `/opt/gsuite-mcp/scheduler-service-account.json` domain-wide delegation for
   Drive and Docs read scopes.
2. **Twenty workspace API key** (Settings → APIs & Webhooks) for n8n to call the GraphQL
   API.
3. **Four custom fields on Opportunity** — `consultStatus`, `verdict`, `transcriptLink`,
   `paymentIntentId` (Settings → Data model).
4. **Add `Customers` (write) to the `nlma-consults-booking` restricted key.** Required to
   save cards for re-authorization. Existing scopes already cover Checkout Sessions,
   PaymentIntents, Charges & Refunds, Webhooks, Events.
5. **Confirm `forrest@nlma.io` produces Meet transcripts** (see Unverified, above).

## Risks

- **Revenue released if Forrest is away.** Auto-release on no click is deliberate — the safe
  default is not charging. Accepted.
- **Card-on-file raises the disclosure bar.** Storing a payment method for later
  re-authorization is a stronger commitment than a one-time hold, reflected in the /terms
  clause.
- **MIT window is tighter than the CIT window.** Re-auth has 4d18h on Visa, not 7 days, so
  the nightly job must fire close to the call. Firing too early wastes the authorization.
- **Twenty becomes load-bearing at booking time.** If the CRM is down, no UUID can be
  minted and bookings fail closed. This is the accepted cost of using the CRM as the record
  store; the alternative was a second database.
- **Transcript-driven billing depends on capture discipline.** If a Meet call is not
  transcribed, the decision falls back to Forrest's recall. The system degrades to manual
  rather than failing.
- **The free path is no longer instant.** It now involves a Stripe redirect. A deliberate
  conversion cost in exchange for the spam gate.

## Out of scope

- Migrating `httplib2` → `AuthorizedSession` in gsuite-mcp (tracked in gsuite-mcp#144).
- Google Voice Call Notes integration for phone consults (blocked on #144; avoided by the
  Meet-only decision).
- Extended 30-day authorizations (requires IC+ pricing).
- Retiring the `consult-stripe-verify` sidecar (n8n cannot replace HMAC verification).
- Any change to the billable prepay path beyond the shared-Checkout parameterization.
- Collecting billable amounts above the $112.50 hold.
