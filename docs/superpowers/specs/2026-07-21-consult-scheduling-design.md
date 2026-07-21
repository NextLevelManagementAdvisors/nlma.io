# nlma.io Consult Scheduling — Design Spec

**Date:** 2026-07-21
**Status:** Approved (design), pending implementation plan
**Repo:** `NextLevelManagementAdvisors/nlma.io` (frontend) + n8n workflows on `n8n.nlma.io`

## 1. Goal

Let a visitor to nlma.io book a consult that lands on `forrest@nlma.io`'s Google
Calendar. A visitor describes what they need; an AI triage step sizes the meeting
and classifies it as **free discovery** or **billable advice**. Free consults book
directly; billable consults book **only after Stripe payment succeeds**.

## 2. Configuration (single-source constants)

| Constant | Value |
|---|---|
| Target calendar | `forrest@nlma.io` (primary) |
| Timezone anchor | America/New_York (ET) |
| Bookable slots | Tue & Thu at 11:00, 14:00, 16:00 ET (recurring) |
| Slot filtering | Real free/busy via Google Calendar `freeBusy.query` |
| Min notice | 24 hours |
| Booking horizon | 21 days |
| Buffer between calls | 15 minutes |
| Durations AI may pick | 15 / 30 / 45 / 60 min |
| Medium | Guest chooses **Google Meet** or **phone** |
| Billable rate | **$450/hr**, prorated (15m=$112.50, 30m=$225, 45m=$337.50, 60m=$450) |
| Payment | Stripe Checkout, pay-to-book, **NLMA** Stripe account |
| Slot hold TTL | 15 minutes |
| Triage model | `claude-sonnet-5` (one call returns duration + billable + summary) |

All constants live in one place per surface: a `CONFIG` object in the widget JS and
n8n workflow-level variables / a shared `Set` node, so tuning is a one-line change.

## 3. Architecture

Static site (nginx-served HTML) hosts a client-side widget. All stateful/backend
logic is in n8n workflows on `n8n.nlma.io`, reached over HTTPS. Google Calendar and
Stripe are called from n8n (their own credentials), never from the browser.

```
Browser (/consults page)
   │  1. POST /webhook/consult-intake      {name,email,medium,request,honeypot}
   ▼
n8n consult-intake ──► Claude (Sonnet) triage ──► {duration, billable, price, summary}
   │                └─► Google freeBusy.query ──► open slots (template − busy − holds − <24h)
   │  returns {triage, slots[]}
   ▼
Browser shows verdict + slot picker
   │
   ├─ FREE ─► 2f. POST /webhook/consult-book {slot, …}
   │              └─► n8n: re-check freebusy → create Calendar event (+Meet, +attendee) → confirm
   │
   └─ BILLABLE ─► 2b. POST /webhook/consult-checkout {slot, …}
                     └─► n8n: soft-hold slot → create Stripe Checkout session → return URL
                  Browser redirects to Stripe Checkout
                     └─► on success → Stripe webhook → /webhook/consult-paid
                             └─► n8n: verify sig → create event (+Meet,+attendee) → release hold
                                       → Stripe emails receipt → redirect to /consults/confirmed
```

## 4. Components

### 4.1 `/consults` page (new static page in the repo)
- New file `consults.html`, built from the existing page skeleton (same `<head>`
  icon/OG/manifest block, brand palette, `.site-head` desktop nav + `.mobile-nav`,
  footer). Follows the "nav is duplicated per file" convention — no includes.
- Nav wiring: add **"Book a consult"** as the header primary CTA (`head-cta .btn-primary`)
  across all pages, replacing/duplicating the current "Start a project" mailto CTA, and
  add a `/consults` link to desktop nav, mobile nav, and footer Company `<ul>` on every
  page (index, about, services, portfolio, referrals, contact, resume).
- Widget = a 3-step client-side state machine, no framework, inline `<script>`:
  1. **Intake form:** name, email, phone (revealed when medium=phone), medium toggle
     (Meet/phone), "What do you need?" textarea, hidden `company_website` **honeypot**
     (reuse existing pattern), input-length cap (~2000 chars).
  2. **Result + slot picker:** shows the AI verdict ("~45-min paid consult — $337.50"
     or "Free intro call, ~30 min"), a one-line rationale, a **"request a free intro
     instead"** escape hatch on billable, and a grid of real open slots rendered in the
     **visitor's local timezone** (with the ET equivalent shown).
  3. **Confirm/pay:** free → confirm button → `/consult-book`; billable → "Pay $X &
     book" → `/consult-checkout` → redirect to Stripe.
- Confirmation: an inline success state on return; billable path returns from Stripe
  to `/consults/confirmed` (query params consumed, then cleaned).
- Graceful degradation: if the intake webhook is unreachable, fall back to the existing
  email/phone CTAs with a visible message.

### 4.2 n8n `consult-intake` (webhook)
- **Anti-abuse gate (first):** reject if honeypot filled; enforce max input length;
  nginx per-route rate-limit; optional Cloudflare Turnstile token check (hardening).
- **Triage:** HTTP node → Anthropic Messages API (`claude-sonnet-5`). Prompt returns
  strict JSON `{duration_min, billable, rationale, summary}` where `duration_min ∈
  {15,30,45,60}`. Triage rule (§6).
- **Price:** `billable ? round(450 * duration_min/60, 2) : 0`.
- **Availability:** build the slot template (Tue/Thu × {11,14,16} ET) across the 21-day
  horizon; call Google `freeBusy.query` for the calendar; drop slots that (a) start
  <24h out, (b) overlap a busy block once extended by `duration_min` + 15m buffer, or
  (c) overlap an active hold (§4.6).
- **Returns:** `{duration_min, billable, price, summary, slots:[{startISO_ET, ...}]}`.

### 4.3 n8n `consult-book` (free path, webhook)
- Re-validate the chosen slot against live freebusy + holds (race guard).
- Create the Google Calendar event via Calendar API: title
  `Consult — {name} (NLMA)`, attendees `[guest email]` (Google sends the invite),
  `conferenceData` request for a **Meet link** when medium=Meet, description packed with
  guest name/email/phone, medium, their request, and the AI summary.
- Return `{status:"booked", eventLink, meetLink?}`.

### 4.4 n8n `consult-checkout` (billable path, webhook)
- Re-validate slot; write a **hold** (§4.6) keyed to a generated `holdId`.
- Create a **Stripe Checkout session** (NLMA keys, mode=payment) for `price`, with
  `metadata` = {holdId, slot ISO, duration, name, email, phone, medium, summary},
  `success_url=/consults/confirmed?...`, `cancel_url=/consults?canceled=1`, and
  Checkout customer email prefilled. Return `{checkoutUrl}`.

### 4.5 n8n `consult-paid` (Stripe webhook)
- Verify the Stripe **signature** against the raw body (HMAC, Code node) using the
  NLMA **webhook signing secret**. Handle `checkout.session.completed`.
- Re-check the slot. **Happy path:** create the Calendar event (as §4.3), release the
  hold, let Stripe email the receipt.
- **Slot-lost inside hold window (rare):** issue a Stripe **refund**, email an apology +
  rebook link, release the hold. Never leave a paid-but-unbooked state.
- Idempotency: keyed on Stripe `session.id` so webhook retries don't double-book.

### 4.6 Hold store
- n8n **data table** `consult_holds`: `{holdId, slotStartISO, durationMin, expiresAt,
  status}`. Written on checkout, subtracted by intake/book availability checks, cleared
  on payment success, conflict, or expiry (a scheduled sweep or lazy on-read expiry).

### 4.7 nginx / CSP (VPS `sites-available/nlma.io`)
- CSP is server-level (confirmed: not in HTML). Extend so the `/consults` page can:
  - `connect-src` → the n8n webhook origin (`https://n8n.nlma.io`),
  - allow navigation / `form-action` to `https://checkout.stripe.com`,
  - keep everything else as-is (mind nginx `add_header` inheritance).
- Add a per-route `limit_req` for the consult webhooks (defense-in-depth alongside n8n).

## 5. Data captured on the calendar event
Guest name, email, phone (if phone consult), medium, verbatim request, AI summary, and
— for billable — the amount and Stripe `payment_intent`/`session` id. This makes the
event self-contained for prep.

## 6. Triage rule (encoded in the Claude prompt)
- **Free discovery** = a prospective client / new engagement for NLMA or FIDUM services
  (property management, STR, real-estate deals, automation/software buildouts).
- **Billable** = someone seeking Forrest's *advice or expertise* without becoming a
  managed client (e.g. attorneys, other investors, one-off strategy/advisory).
- The model returns a rationale. The guest **always sees the verdict** and can request a
  free intro instead — the AI never silently charges and never silently rejects a lead.
- `duration_min` is the model's estimate of time needed, snapped to {15,30,45,60}.

## 7. Edge cases
- **Timezone:** slots computed/stored in ET; rendered in the visitor's local tz (with ET
  shown) via `Intl.DateTimeFormat`.
- **Double-booking:** freebusy re-check at both booking entry points + hold subtraction;
  billable slot-lost → auto-refund.
- **Abuse / token cost:** honeypot + length cap + nginx rate-limit; optional Turnstile.
- **Webhook reachability:** widget degrades to email/phone CTAs.
- **Stripe webhook retries:** idempotent on session id.
- **No Meet for phone consults:** event holds the guest's number instead of a Meet link.

## 8. Security / secrets
- **NLMA Stripe keys** (secret key + webhook signing secret) live in the NLMA Stripe
  dashboard; they are injected into n8n credentials at implementation time (the Stripe
  MCP in-session is the *Finangle* account, so NLMA keys are supplied separately). No
  keys ever reach the browser.
- Google Calendar access uses an n8n Google credential authorized for `forrest@nlma.io`.

## 9. Out of scope (YAGNI)
- Reschedule/cancel self-service UI (guests use the Google invite's native controls;
  cancellations free the slot automatically via freebusy).
- Multiple consult *types* / routing, coupons, packages, recurring bookings.
- Storing guest data anywhere beyond the calendar event + Stripe.

## 10. Build order (feeds the implementation plan)
1. `/consults` page + widget with a **mocked** intake response (frontend first, no backend).
2. n8n `consult-intake` (triage + freebusy) → wire widget to it.
3. n8n `consult-book` (free path end-to-end) → book a real test event.
4. Hold store + n8n `consult-checkout` + `consult-paid` (Stripe) — **needs NLMA keys**;
   test in Stripe test mode first.
5. nginx CSP + rate-limit; nav/CTA wiring across all pages; deploy via VPS git-pull.
6. End-to-end verification (free + billable in Stripe test mode), then go live.
