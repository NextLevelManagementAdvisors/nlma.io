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

## n8n credentials used (ids on this instance)
- Google Calendar OAuth2 `kKPeZuvma85RLakQ` (forrest@nlma.io primary)
- cliproxy bearer (triage) `x9VGjLYXm7VB6GsE`  ·  Stripe restricted key `kKWma7ncblJi00xq`
- Gmail (refund apology) `Po71UEDidkAwWYqo`
