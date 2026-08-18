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
| `/webhook/consult-slots`, no LLM, filtered at the longest bookable duration | live |
| Both paths authorize a card at booking, nothing charged | live, verified at $112.50 and $225.00 |
| Stripe Checkout: manual capture, card saved off-session, card-only | live |
| Calendar event created tentative, `PENDING:` prefix, guest not invited | live, untested against a real payment |
| Confirm and decline capability links, with emails | live, bad-input paths tested |
| Decline releases the authorization, deletes the event, frees the slot | live, untested against a real payment |
| Execution saving on the workflow | on (closes nlma.io#4's second half) |
| Page copy, terms, post-checkout page describe the above | live |

Not built: re-authorization, transcript analysis, capture, guest-side email at booking.
**Nothing captures money today.** An authorization sits until it is released or expires.

---

## 1. Prove the loop with one real authorization

**Owner: F. Blocks: everything downstream. Time: ~15 min.**

The seam from payment to pending appointment cannot be exercised without a real
authorization, so it is the one part of what shipped today that is unproven.

- [ ] Book yourself a free intro at nlma.io/consults. Authorize the $112.50 on your own card.
- [ ] Check the calendar: event exists, titled `PENDING: Consult, <name>`, shows as tentative, and the guest has **not** received an invite.
- [ ] Check your inbox: "Pending consult" email arrives with the amount and two links.
- [ ] Click **Decline**. Expect: page says Declined, event disappears, guest email arrives, and the authorization shows as canceled in Stripe.
- [ ] Repeat, and this time click **Confirm**. Expect: event loses the `PENDING:` prefix, guest receives the invite with the Meet link, authorization still uncaptured.
- [ ] Cancel that second authorization in the Stripe dashboard when done, or leave it to expire.

If any step misbehaves, the execution is now saved in n8n and can be read directly.

## 2. Confirm the restricted key's scopes

**Owner: F. Blocks: item 4. Time: ~5 min.**

Session creation with `customer_creation=always` succeeded, but Stripe only creates the
Customer when the payment completes, so the scope is not yet proven. Item 1 proves it
incidentally: if a Customer and a saved payment method appear on that test, the key is fine.

- [ ] Stripe dashboard, API keys, restricted key `nlma-consults-booking`. Confirm write on: Checkout Sessions, PaymentIntents, Customers. Read on: Payment Methods.
- [ ] Tell me if Customers write is missing. Without it there is no saved card, and item 4 cannot exist as designed.

## 3. Tell the guest something at booking time

**Owner: C. Blocks: nothing. Ready to build now.**

Today a guest authorizes a card and then hears nothing at all until you confirm. Stripe
sends no receipt for an uncaptured authorization, so from their side the money vanished
into silence. This is the most visible gap in what shipped.

- [ ] Gmail node after `Store Booking`: "Request received" to the guest, naming the time,
      the amount authorized, that it is not a charge, and that the invite follows confirmation.
- [ ] Same email carries a plain-language line about what happens if you decline.

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

**Owner: F. Blocks: item 7. Time: ~10 min.**

- [ ] On n8n.nlma.io, create a `googleDriveOAuth2Api` credential and authorize as forrest@nlma.io.
- [ ] `drive.readonly` is sufficient; the workflow only reads transcript files.

## 6. Confirm Meet actually produces transcripts

**Owner: F. Blocks: item 7. Time: ~5 min plus one call.**

The entire capture design rests on a transcript existing. Worth proving before building on it.

- [ ] Google Meet settings: turn transcripts on (requires a Workspace edition that offers them).
- [ ] Hold a one-minute call with yourself and confirm a transcript lands in Drive under "Meet Recordings".
- [ ] Tell me the folder name and file naming pattern you see; the poll keys off it.

## 7. Transcript analysis and automatic capture

**Owner: C. Blocked by: items 5 and 6. This is the piece that charges money.**

You chose automatic capture with no human approval step. Two rails are already written
into terms.html and will be enforced in code, not just prose:

- never capture more than the amount authorized;
- an inconclusive or missing analysis releases the authorization rather than capturing it.

- [ ] Schedule trigger, every 15 minutes: find confirmed bookings whose end time passed and that have no capture decision yet.
- [ ] Fetch the transcript from Drive; if none exists within 6 hours of the call ending, release and stop.
- [ ] Analyze via cliproxy: was this introductory discussion or billable advisory work, and for how many minutes.
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
| L1 | Delete the stale 8/20 4:00 PM event, titled "Consult hold (superseded, safe to delete)". It is set to free so it blocks nothing, but it is clutter. | F |
| L2 | Availability is thin: Tuesday and Thursday at 11:00, 2:00, and 4:00 only, so a visitor often sees one or two open times. Widen `HOURS` and `DOW`. | F decides, C edits |
| L3 | Those constants now live in **two** nodes, `Parse+Slots` and `Slots Prep`, and must be changed together. Worth collapsing into one source. | C |
| L4 | `/webhook/consult-book` is no longer called by the site. It still books without a card and is the rollback path. Retire it once item 1 passes. | C |
| L5 | `doneStep` in consults.html is dead markup now that every path redirects to Stripe. | C |
| L6 | nginx CSP: add `form-action 'self' https://checkout.stripe.com`; `frame-src calendar.google.com` is inert now and can go. | C |
| L7 | nlma.io#5 can be closed: the $112.50 disclosure now has a collection point behind it. | C |
| L8 | `Book Prep` and `Checkout Prep` still read only `company_website` for the honeypot. Harmless, since every frontend posts that key, but it is the last piece of nlma.io#4. | C |

---

## Order of work

```
F: 1 (prove the loop) ─┬─> F: 2 (scopes confirmed as a side effect)
                       │
C: 3 (guest email) ────┘   independent, can ship immediately

F: 2 ──> C: 4 (re-auth + sweeps)

F: 5 (Drive cred) ─┬─> C: 7 (analysis + capture)
F: 6 (transcripts) ┘

C: 8 only if you want CRM records
```

Item 3 is the only build task with no prerequisite. Everything else waits on you.
