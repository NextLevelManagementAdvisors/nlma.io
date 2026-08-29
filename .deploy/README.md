# Consult-scheduling backend/infra (VPS-only artifacts)

Backup of the VPS-side pieces of the **/consults** booking feature that live outside this
repo's static files. Kept under `.deploy/` (a dotfile dir) so the site's existing nginx
rule `location ~ /\.(?!well-known) { return 404; }` **blocks it from the web** — it is
version-controlled but never served. Host: `root@178.16.141.166`.

**Secrets are NOT here.** The Stripe webhook signing secret lives only in
`/opt/consult-stripe-verify/.env` on the VPS (`STRIPE_WHSEC=whsec_…`, chmod 600).

## Architecture

```
Browser (/consults widget)
  → n8n webhooks (consult-intake / consult-book / consult-checkout)   [gpt-5.5 triage, freebusy, Stripe Checkout]
Stripe (checkout.session.completed)
  → nginx  (n8n.nlma.io, exact match /webhook/consult-paid)
  → verify sidecar 127.0.0.1:3071  (HMAC-SHA256 signature check)
  → n8n webhook /webhook/consult-paid  (re-fetches session from Stripe, books only if payment_status=paid)
```

The n8n workflow itself ("NLMA Consults", id `R0cMmqeBshPYpdqt`) is backed up separately in
the **`n8n-workflow-backups`** repo (`workflows/R0cMmqeBshPYpdqt.json`).

## Files

- `consult-stripe-verify/verify.py` — stdlib Python Stripe signature-verification sidecar.
  Verifies the `Stripe-Signature` HMAC over the raw body (600s tolerance, constant-time
  compare) and forwards only verified events to n8n; 400 on bad/missing sig, 5xx on n8n
  failure (so Stripe retries a verified event). → `/opt/consult-stripe-verify/verify.py`
- `consult-stripe-verify/consult-stripe-verify.service` — systemd unit. → `/etc/systemd/system/`
- `nginx/conf.d-limit-req-consult.conf` — rate-limit zone. → `/etc/nginx/conf.d/limit-req-consult.conf`
- `nginx/n8n.nlma.io.consult-locations.conf` — the two consult location blocks (rate-limited
  intake/checkout; consult-paid → sidecar) to paste into `/etc/nginx/sites-available/n8n.nlma.io`
  **before** `location / {`.
- `nginx/nlma.io.consults-location.conf` — the exact-match `/consults` route (fixes the
  `consults/` directory shadowing `consults.html`) → paste into `/etc/nginx/sites-available/nlma.io`
  before `location / {`.
- `nginx/nlma.io.headers-and-redirects.conf` — SEO/perf hardening for `nlma.io` (issue #6):
  301 `*.html` → extensionless, HSTS `includeSubDomains; preload`, and tiered Cache-Control
  (short for HTML, long+immutable for static assets). See the comments in the file for exact
  paste locations — it touches three different spots in the server block, not just one.

## Redeploy after a VPS rebuild

1. `mkdir -p /opt/consult-stripe-verify` and copy `verify.py` there.
2. Create `/opt/consult-stripe-verify/.env` with `STRIPE_WHSEC=<secret>` (chmod 600). Get the
   secret from the Stripe dashboard (NLMA acct) → the `consult-paid` webhook endpoint's signing
   secret. **If the Stripe webhook endpoint is recreated, its whsec rotates — update this .env
   and `systemctl restart consult-stripe-verify`.**
3. Copy the systemd unit → `/etc/systemd/system/`; `systemctl daemon-reload && systemctl enable --now consult-stripe-verify`.
4. Copy `conf.d-limit-req-consult.conf` → `/etc/nginx/conf.d/`; paste the two nginx location
   files' blocks into their vhosts before `location / {`; `nginx -t && systemctl reload nginx`.
   (Note: after a reload the first request can race the old route — re-test after it settles.)
5. Verify: `curl -o /dev/null -w '%{http_code}' -X POST https://n8n.nlma.io/webhook/consult-paid`
   with a bad `Stripe-Signature` → **400**; with no header → **400**.

## Deploying the SEO/perf hardening (issue #6)

1. Paste the three pieces of `nginx/nlma.io.headers-and-redirects.conf` into
   `/etc/nginx/sites-available/nlma.io` per the comments in that file (rewrite rules at the
   top of the server block, HSTS line replaces the existing one, the two Cache-Control
   pieces go with the other `add_header`s / before `location /`).
2. `nginx -t && systemctl reload nginx`.
3. The IndexNow key file (`<key>.txt` at the repo root, e.g. `687da19aec9ab452a2bab512b3b8470a.txt`)
   ships with the rest of the static site — no separate VPS step needed beyond the normal
   site deploy/sync.
4. Verify:
   - `curl -sI https://nlma.io/about.html` → `301` with `Location: https://nlma.io/about`
   - `curl -sI https://nlma.io/index.html` → `301` with `Location: https://nlma.io/` (not `/index`)
   - `curl -sI https://nlma.io/` → `Cache-Control` with a nonzero `max-age`
   - `curl -sI https://nlma.io/` → `Strict-Transport-Security` includes `includeSubDomains` and `preload`
   - `curl -sI https://nlma.io/og-image.png` → `Cache-Control: public, max-age=31536000, immutable`
     **and** still carries `Strict-Transport-Security`/CSP/etc. (catches the add_header-inheritance gotcha)
   - `curl -sI https://nlma.io/consults` and `.../referrals` → still `200` (unaffected — the
     rewrite only fires on `.html` URLs, and both are already `200` today with no `.html` suffix)

## n8n credentials used (ids on this instance)
- Google Calendar OAuth2 `kKPeZuvma85RLakQ` (forrest@nlma.io primary)
- cliproxy bearer (triage) `x9VGjLYXm7VB6GsE`  ·  Stripe restricted key `kKWma7ncblJi00xq`
- Gmail (refund apology) `Po71UEDidkAwWYqo`
