# Consult buildout: remaining action list

Written 2026-08-17, after shipping calendar-first booking and authorize-at-booking.
Companion to `2026-07-27-consult-authorization-hold-design.md`, which is the design
this list finishes.

Owner column is literal: **F** is something only Forrest can do (credentials, scopes,
a real card, a Google Workspace setting). **C** is a build task.

---

## Where the system stands

Live and verified today:

| Piece | State |
|---|---|
| Calendar-first booking, times inline in the grid | live |
| `/webhook/consult-slots`, no LLM, filtered at the longest bookable duration | live, and freeBusy filtering verified against the real calendar: 8/20 correctly offers only 16:00, 8/25 correctly drops the 11:00 Charles already holds |
| Both paths authorize a card at booking, nothing charged | live. The $112.50 and $225.00 figures were verified at **session creation**, not at payment: `Create Checkout Session` returns the right amounts and metadata. No session has ever been completed |
| Stripe Checkout: manual capture, card saved off-session, card-only | live |
| Calendar event created tentative, `PENDING:` prefix, guest not invited | live, untested against a real payment |
| Confirm and decline capability links, with emails | live, bad-input paths tested |
| Decline releases the authorization, deletes the event, frees the slot | live, untested against a real payment |
| Execution saving on the workflow | on (closes nlma.io#4's second half) |
| Page copy, terms, post-checkout page describe the above | live |
| Guest "request received" email at booking | live as of 2026-08-17, confirmed present in the **active** workflow version, untested against a real payment |
| A post-call artifact to analyze | confirmed present and current: Gemini notes Docs, newest 2026-08-14, carrying the full transcript and a measured talk time (item 6) |

Measured 2026-08-17: the `Paid` webhook has **never fired**. All eight saved executions
are Intake, Checkout, or Slots. Everything downstream of a completed payment is written
and unexercised.

Not built: re-authorization, transcript analysis, capture.
**Nothing captures money today.** An authorization sits until it is released or expires.

---

## 1. Prove the loop with one real authorization

**Owner: F. Blocks: everything downstream. Time: ~15 min.**

The seam from payment to pending appointment cannot be exercised without a real
authorization, so it is the one part of what shipped today that is unproven.

Confirmed 2026-08-17 from the execution log, so this is measured rather than assumed:
**the `Paid` webhook has never fired.** Eight saved executions exist and every one is
Intake, Checkout, or Slots. Everything from `Retrieve Session` onward, which is the
tentative event, both emails, the confirm patch, and the authorization cancel, has never
run against real data. One card pass exercises all of it at once.

- [ ] Book yourself a free intro at nlma.io/consults. Authorize the $112.50 on your own card.
- [ ] Check the calendar: event exists, titled `PENDING: Consult, <name>`, shows as tentative, and the guest has **not** received an invite.
- [ ] Check your inbox: "Pending consult" email arrives with the amount and two links.
- [ ] Check the guest inbox too: "Your consult request for ..." should arrive in the same execution, saying the card was authorized and not charged. This is the one piece built today and never run.
- [ ] Click **Decline**. Expect: page says Declined, event disappears, guest email arrives, and the authorization shows as canceled in Stripe.
- [ ] Repeat, and this time click **Confirm**. Expect: event loses the `PENDING:` prefix, guest receives the invite with the Meet link, authorization still uncaptured.
- [ ] Cancel that second authorization in the Stripe dashboard when done, or leave it to expire.

If any step misbehaves, the execution is now saved in n8n and can be read directly.

## 2. Confirm the restricted key's scopes

**Owner: F. Blocks: item 4. Time: ~5 min.**

Session creation with `customer_creation=always` succeeded, but Stripe only creates the
Customer when the payment completes, so the scope is not yet proven. Item 1 proves it
incidentally: if a Customer and a saved payment method appear on that test, the key is fine.

Checked 2026-08-17 from the browser: `dashboard.stripe.com` redirects to a login wall in
this Chrome, and I do not enter credentials. This one needs your keyboard either way.

- [ ] Stripe dashboard, API keys, restricted key `nlma-consults-booking`. Confirm write on: Checkout Sessions, PaymentIntents, Customers. Read on: Payment Methods.
- [ ] Tell me if Customers write is missing. Without it there is no saved card, and item 4 cannot exist as designed.

Two things checked 2026-08-17 that narrow this down.

**Nothing in the execution history can settle it.** The workflow has eight saved
executions, all of them Intake, Checkout, or Slots. The `Paid` webhook has never fired
once. `customer_creation=always` only mints the Customer when a payment completes, so
with no completed checkout there is no Customer to look at. `Create Checkout Session`
succeeding does prove Checkout Sessions write; it proves nothing about Customers.

**I tried to prove it directly and was stopped by my own permission layer.** The plan was
a throwaway n8n node POSTing `/v1/customers` with credential `kKWma7ncblJi00xq`, read the
status, then delete the node. Both `n8n_create_workflow` and `n8n_update_partial_workflow`
were refused by the Claude Code auto mode classifier, which will not let me attach a live
payment credential to a new HTTP node unattended. Approve that one write and I can close
this item in about a minute, with one live-mode Customer named
"n8n scope probe 2026-08-17, safe to delete" as the only residue. Otherwise it rides along
with item 1.

## 3. Tell the guest something at booking time

**Owner: C. Built 2026-08-17. Untested against a real payment; item 1 exercises it.**

A guest used to authorize a card and hear nothing at all until you confirmed. Stripe sends
no receipt for an uncaptured authorization, so from their side the money vanished into
silence. That was the most visible gap in what shipped.

Node **Guest Received Email** now sits between `Notify Forrest` and `Paid Booked Shape`,
so the same execution that emails you emails them. It reads its fields from
`$('Store Booking')`, the same paired-item pattern `Paid Booked Shape` already relied on
across a Gmail node, and runs `onError: continueRegularOutput` so a Gmail hiccup can never
cost the guest their booking.

What it says: the time they asked for, the amount authorized and that a hold is not a
charge, that you review each request yourself so the time is held rather than confirmed,
that the invite follows your confirmation, and that a decline releases the hold and gets
them a note so they can pick another time. The last line splits on `billable`: a paid
consult says the fee is captured after the call for the time actually spent and never more
than the amount authorized; a free intro says it captures nothing unless the conversation
turns into paid advisory work.

- [x] Guest email at booking.
- [ ] Confirm the wording reads right when you see the real one during item 1.

## 4. Re-authorization, so a 21-day booking survives

**Owner: C. Blocked by: item 2. Design: spec section "Nightly Re-Auth".**

A card authorization dies at roughly 7 days. The booking window is 21 days. Without this,
a call three weeks out reaches its date with a dead authorization and captures nothing.

- [ ] Schedule trigger, nightly.
- [ ] Walk `sd.bookings` for status `pending` or `confirmed` with a future `startIso`.
- [ ] Where the authorization is older than 5 days: create a fresh off-session PaymentIntent on the saved payment method, then cancel the old one. Order matters: new one first, so a failure never leaves the booking unsecured.
- [ ] On failure, email the guest to reconfirm their card and copy yourself.
- [ ] T-12h sweep: a booking still unsecured 12 hours before the call gets cancelled and the guest told.
- [ ] Expiry sweep: an authorization whose call has passed with no capture gets released, not left to rot.

## 5. Google Drive credential in n8n

**Owner: F. Blocks: item 7. Time: ~5 min.**

Revised 2026-08-17. The credential already exists and does not need creating. It is
**Google Drive+Docs SA (forrest@nlma.io) — consult transcripts**, credential id
`3siGSxiA9FloX0c1`, a Google Service Account credential rather than the OAuth one this
list originally called for. That is the better shape: no consent screen, no refresh token
to expire.

It is currently **broken**. Its connection test returns:

```
401 {"error":"unauthorized_client","error_description":"Client is unauthorized to
retrieve access tokens using this method, or client not authorized for any of the
scopes requested."}
```

- Service account: `gsuite-scheduler@gsuite-mcp-493905.iam.gserviceaccount.com`
- Client ID (the number the Admin console asks for): `105046837924700815762`
- Impersonating: `forrest@nlma.io`
- Scopes requested: `https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/documents.readonly`

That error means exactly one thing: the service account impersonates a user, and Google
Workspace has no domain-wide delegation grant covering those two scopes for that client.

- [ ] Admin console, Security, Access and data control, API controls, Domain-wide delegation.
- [ ] Search the grant list for client ID `105046837924700815762`. That is `gsuite-scheduler`, read off `/opt/gsuite-mcp/scheduler-service-account.json` on the VPS, so no Cloud console trip is needed.
- [ ] If that client already has an entry, **append** the two scopes to the existing list. Do not replace it: whatever else runs on that grant breaks silently if you do.
- [ ] Back in n8n, reopen the credential and hit Retry. Green means item 7 is unblocked.

I could not do this one from the browser: both `admin.google.com` and
`console.cloud.google.com` are blocked to me, and a Workspace security setting is yours
to make regardless.

**The obvious shortcut does not work, so do not spend time on it.** The tempting move is
to skip domain-wide delegation entirely by making an ordinary OAuth Drive credential in
n8n and clicking Connect once. That fails on the redirect URI. The only OAuth client on
the box, `/opt/gsuite-mcp/client_secret.json`
(`54363791624-nsierni7qvgm7n4fv3icutbdo3v7kvn1.apps.googleusercontent.com`), registers
exactly one callback:

```
https://gsuite.nlma.io/oauth2callback
```

n8n's callback (`https://n8n.nlma.io/rest/oauth2-credential/callback`) is not on it, and
adding it is itself a Cloud console trip. So the OAuth route costs the same console visit
as the delegation grant and leaves a second credential to maintain. Append the two scopes
and be done.

Worth knowing: Drive reads for `forrest@nlma.io` do work today through gsuite-mcp, which
runs on a stored OAuth user session rather than the service account. That is how item 6
was answered. It confirms the data is reachable; it just is not reachable from n8n yet.

## 6. Confirm the call produces a readable artifact

**Owner: none. Answered 2026-08-17. No longer blocks item 7.**

Resolved by reading Drive rather than by asking you to hold a test call. The answer is
better than the question assumed, and it retargets item 7.

**Standalone Meet transcripts are effectively dead on this account.** The newest
`... - Transcript` Doc is `yms-gpgc-pui (2025-03-25 21:51 GMT-4) - Transcript`, almost
eighteen months old. Building capture on that would have built it on a feature that is
not running.

**Gemini notes are alive and are the better artifact.** The newest is
`Meeting started 2026/08/14 16:42 EDT - Notes by Gemini`, three days old, and there are
several from 8/12 to 8/14. They are Google Docs, and each one contains, in order:

| Section | What it gives item 7 |
|---|---|
| Quick notes | a short summary |
| Full notes, Details | topic-by-topic account with timestamps |
| Transcript | the full speaker-attributed transcript, timestamped |
| Closing line | `Transcription ended after 00:16:57`, the actual talk time |

That last line is the thing the original design was going to have to infer. Billable
minutes can be read off it directly and cross-checked against the analysis.

**Naming.** Two shapes, and ours will always be the first:

| Shape | Example |
|---|---|
| Titled event | `Nina / Forrest - PMP - 2026/08/13 12:49 EDT - Notes by Gemini` |
| Untitled meeting | `Meeting started 2026/08/14 16:42 EDT - Notes by Gemini` |

A confirmed consult is titled `Consult: <name> (billable)` or `Consult: <name> (intro)`,
so its notes Doc name is deterministic. No Meet-code matching needed.

**They do not live in "Meet Recordings."** Two folders carry that name
(`1DmlUrAjLIQrWFoDYpQI8EumBETyfy-If` and `1oi_XOmFfz3BwnDG91PuVyFu7z4TJIUc1`) and hold
three files between them. Everything else is loose, so item 7 searches by name and
`createdTime`, never by folder parent.

Nothing is required of you here. If you want transcripts switched back on as a belt and
braces second source, that is a Meet admin setting, but item 7 no longer waits on it.

## 7. Transcript analysis and automatic capture

**Owner: C. Blocked by: item 5 only, since item 6 answered itself. This is the piece that
charges money.**

You chose automatic capture with no human approval step. Two rails are already written
into terms.html and will be enforced in code, not just prose:

- never capture more than the amount authorized;
- an inconclusive or missing analysis releases the authorization rather than capturing it.

- [ ] Schedule trigger, every 15 minutes: find confirmed bookings whose end time passed and that have no capture decision yet.
- [ ] Fetch the **Gemini notes Doc**, not a transcript file: `name contains ' - Notes by Gemini' and createdTime > <call end>`, then match on the event title the booking already knows (`Consult: <name> ...`). Item 6 established that standalone transcripts stopped appearing in March 2025 while notes Docs are current, and that neither lands in a "Meet Recordings" folder.
- [ ] If none exists within 6 hours of the call ending, release and stop. Keep `' - Transcript'` as a secondary search in case Meet transcription is switched back on.
- [ ] Read `Transcription ended after HH:MM:SS` from the tail of the Doc. That is measured talk time, so the analysis has a hard number to defend rather than an estimate.
- [ ] Analyze the Doc's Transcript section via cliproxy: was this introductory discussion or billable advisory work, and for how many minutes. Reconcile against the measured talk time and take the lower.
- [ ] Capture `min(analyzed amount, authorized amount)`, with a free intro capped at $112.50.
- [ ] Email the guest what was captured and why, in plain language, and copy yourself.
- [ ] Record the decision and the transcript link on the booking so a dispute can be answered.

## 8. Optional: CRM records in Twenty

**Owner: F then C. Not required for the money path.**

The original spec tracked each consult as a Twenty Opportunity. Nothing built so far needs it.

- [ ] F: Twenty API key as an n8n credential.
- [ ] F: four Opportunity custom fields: `consultStatus`, `verdict`, `transcriptLink`, `paymentIntentId`.
- [ ] C: create the Opportunity at booking, update it at confirm, decline, and capture.

---

## Loose ends

Small, independent, none of them blocking.

| # | Item | Owner |
|---|---|---|
| L1 | ~~Delete the stale 8/20 4:00 PM event.~~ **Done.** It is gone from forrest@nlma.io as of 2026-08-17; the only consult on the calendar now is Charles Daucourt, 8/25 11:00. | — |
| L2 | Availability is thin, and now measured rather than guessed. `/consult-slots` returns **12 open times across 18 days**: 8/20 has one (16:00), 8/25 has two, and everything before 8/20 is gone entirely. A visitor who wants this week sees nothing. Widen `HOURS` and `DOW`. | F decides, C edits |
| L3 | ~~Slot constants duplicated across two nodes.~~ **Blocked, not done.** The fix is to make the intake path triage-only: it computes availability nobody reads, because the visitor already picked a time from `/consult-slots`. That deletes `HOURS`/`DOW`/`HORIZON`/`MINH` from `Parse+Slots`, leaves `Slots Prep` as the single source, and drops a wasted freeBusy call per intake. It needs a rewire (`Parse+Slots` to `Respond OK`, orphaning `FreeBusy` and `Filter Slots`), and code-only edits cannot do it: change the code without the rewire and `FreeBusy` gets an undefined `timeMin`. The n8n structural write was refused by the auto mode classifier. | C, needs one approval |
| L4 | `/webhook/consult-book` is no longer called by the site. It still books without a card and is the rollback path. Retire it **after** item 1 passes, not before. | C |
| L5 | ~~`doneStep` dead markup.~~ **Done 2026-08-18.** The block and its one reference are gone, along with the stale `#doneMsg` mention in the CSS comment. | — |
| L6 | nginx CSP. **Staged, not live.** `form-action 'self' https://checkout.stripe.com` added and the inert `frame-src calendar.google.com` removed in `/etc/nginx/sites-available/nlma.io` (backup `nlma.io.bak-csp-formaction-*`); `nginx -t` passes. The reload could not be run: the Shell MCP chroot sits in a separate PID namespace, so `nginx -s reload` fails with `kill(...) No such process`, and SSH from here was refused by the classifier. **Needs one command on the host: `systemctl reload nginx`.** Nothing is broken meanwhile; the old policy stays live and blocks nothing the site does. | F, one command |
| L7 | ~~Close nlma.io#5.~~ **Done 2026-08-18.** Closed as completed, with a comment recording that option 2 was built, that the CSP half is staged pending reload, and that the paid branch is still unexercised. | — |
| L8 | ~~Honeypot key mismatch.~~ **Done 2026-08-18.** `Book Prep` and `Checkout Prep` now accept `nlma_check` or `company_website`, matching `Guard`. With all three accepting both, consults.html was switched to post `nlma_check` on the intake call, and the checkout call now sends it too (it previously sent no honeypot at all, so that check was dead code). Verified live rather than assumed: an empty honeypot returns a verdict, a filled one returns 400. Old cached pages posting `company_website` still work. This closes nlma.io#4, and nlma.io#5 closed with it, so the repo has no open issues. | — |
| L9 | ~~Stripe webhook replay could double-book one payment.~~ **Found and fixed 2026-08-18.** `Paid Guard` detected a replayed `checkout.session.completed` only by finding the hold marked `done`, and that marker is not durable: `CO Race` prunes every non-`held` hold on the next visitor's checkout, and a payer who lingers past the 15-minute hold expiry never gets the marker written at all. So a retry (the edge verifier returns 500 on a forward failure or a >60s timeout, and its own comment notes Stripe then retries a verified event) could create a **second booking with a new token on the same PaymentIntent**: two confirm/decline emails for one payment, and declining the duplicate runs `Cancel Auth` on the shared PI, silently killing the authorization behind the consult just confirmed. `Paid Guard` now also dedupes on `paymentIntent` against the bookings register, which is retained 30 days past the call, well beyond Stripe's 3-day retry window. Proven with a six-case harness run against both the old and new code: the old guard fails the two replay cases, the new one passes all six, and the happy path still yields a tentative event at $112.50 with the PI, customer, and payment method intact. | — |

---

## Order of work

```
C: 3 (guest email) ──> shipped 2026-08-17
F: 6 (call artifact) ──> answered 2026-08-17, no action needed

F: 1 (prove the loop) ──> F: 2 (scopes confirmed as a side effect)
                     └──> also proves item 3's email for the first time

F: 2 ──> C: 4 (re-auth + sweeps)

F: 5 (DWD grant) ──> C: 7 (analysis + capture)

C: 8 only if you want CRM records
```

Two things left that only you can do: **one real card pass** (item 1, which carries item 2
with it) and **appending two scopes to one delegation grant** (item 5). Item 6 is closed.
Approving a single n8n write would also let me settle item 2 on its own.

## What is actually proven, as of 2026-08-18

| Half of the flow | State |
|---|---|
| Intake, triage, slots, honeypot rejects on all three webhooks, Checkout Session creation with the right amounts | **verified live** |
| Stripe signature verifier at the edge (`consult-stripe-verify.service` on 127.0.0.1:3071, nginx routes `/webhook/consult-paid` to it) | **verified live**: it answers an unsigned probe with `{"error":"invalid_signature"}` 400, so the endpoint is up and the signing secret is loaded |
| The whole Paid branch, and the Approve confirm/decline happy paths | **wired, never executed once.** No `Paid` execution has ever run, because no one has paid yet. The Approve reject path was tested against four bad inputs; confirm and decline have not run. |
| Capture (item 7) and nightly re-authorization (item 4) | **not built** |
| CRM (item 8) | **not in the graph at all.** 74 nodes, zero CRM nodes. Its absence blocks nothing; it would only add records alongside a flow that already works without it. |

Two things this cannot prove from here, both of which item 1 settles:

- **Whether the Stripe dashboard endpoint is registered** at
  `https://n8n.nlma.io/webhook/consult-paid` with `checkout.session.completed` selected and
  enabled. The verifier holding a working signing secret is strong evidence someone set it up,
  but registration lives in the dashboard. If the Paid branch no-shows during item 1, check the
  dashboard first, not the workflow.
- **Whether the authorization survives to the call.** Card authorizations lapse in roughly seven
  days, and slots currently run 3 to 18 days out. So most bookable times today sit past the
  window: a billable consult booked more than about six days out will fail capture until item 4
  ships. That makes item 4 a prerequisite rather than a follow-up, and it makes L2 a money
  decision as well as a marketing one, since the availability you pick sets how exposed the
  window is.

One flag, no action needed: pending bookings and their confirm/decline links live in n8n
workflow static data. If that is ever lost the links stop resolving and the authorization
expires and releases on its own, so the failure mode is bounded and never takes money.
