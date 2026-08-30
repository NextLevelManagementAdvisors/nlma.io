#!/bin/bash
# Warns before a TLS certificate lapses. Runs daily; silent when healthy, so any
# output at all is a real finding that cron mails to MAILTO.
#
# Why this exists (nlma.io issue #17): on 2026-08-29 nothing had been renewing
# certificates on this box for months. hostlane.nlma.io had already expired and
# nlma.io itself was 23 days out. Nothing noticed.
#
# nginx-tls-canary.sh did not catch it, by design rather than by bug:
#   1. it probes 4 hardcoded hosts, and neither hostlane.nlma.io nor nlma.io is one
#   2. it only asserts that a handshake completes and the subject is not TRAEFIK.
#      An EXPIRED cert still completes a handshake and still prints a subject, so an
#      expiry lapse passes that check even for the hosts it does watch.
# This script covers the gap: every cert on disk, checked on time remaining.
set -u

WARN_DAYS=${WARN_DAYS:-14}
now=$(date +%s)
expired=()
soon=()
unreadable=()

# Both trees are in use: certbot lineages and hand-placed certs referenced by nginx.
shopt -s nullglob
for pem in /etc/letsencrypt/live/*/fullchain.pem /etc/nginx/ssl/*/fullchain.pem; do
  name=$(basename "$(dirname "$pem")")
  [[ "$name" == "README" ]] && continue

  end=$(openssl x509 -in "$pem" -noout -enddate 2>/dev/null | cut -d= -f2)
  if [[ -z "$end" ]]; then
    unreadable+=("$name ($pem)")
    continue
  fi

  end_ts=$(date -d "$end" +%s 2>/dev/null) || { unreadable+=("$name (unparseable date: $end)"); continue; }
  days=$(( (end_ts - now) / 86400 ))

  if (( days < 0 )); then
    expired+=("$(printf '%-34s expired %s days ago (%s)' "$name" "$(( -days ))" "$end")")
  elif (( days < WARN_DAYS )); then
    soon+=("$(printf '%-34s %3s days left (%s)' "$name" "$days" "$end")")
  fi
done

(( ${#expired[@]} + ${#soon[@]} + ${#unreadable[@]} == 0 )) && exit 0

echo "cert-expiry-check on $(hostname) at $(date -u +%FT%TZ)"
echo

if (( ${#expired[@]} )); then
  echo "EXPIRED (clients are seeing TLS errors right now):"
  printf '  %s\n' "${expired[@]}"
  echo
fi
if (( ${#soon[@]} )); then
  echo "Expiring within ${WARN_DAYS} days:"
  printf '  %s\n' "${soon[@]}"
  echo
fi
if (( ${#unreadable[@]} )); then
  echo "Could not read:"
  printf '  %s\n' "${unreadable[@]}"
  echo
fi

# A renewal that is not running is the usual root cause, and it is invisible
# otherwise: certbot dies during import before it opens its log, so the log stays
# 0 bytes and no error is recorded anywhere. Surface that alongside the symptom.
echo "Renewal health:"
log=/var/log/letsencrypt/letsencrypt.log
if [[ ! -s "$log" ]]; then
  echo "  WARNING: $log is empty. certbot may be crashing before it can log."
else
  echo "  last certbot log write: $(date -r "$log" -u +%FT%TZ)"
fi
if [[ -x /opt/certbot/bin/certbot ]]; then
  echo "  certbot: $(/opt/certbot/bin/certbot --version 2>&1 | head -1) at /opt/certbot"
else
  echo "  WARNING: /opt/certbot/bin/certbot is missing. See nlma.io issue #17."
fi
echo "  renew cron: $(grep -c 'certbot -q renew' /etc/cron.d/certbot-venv 2>/dev/null || echo 0) entry in /etc/cron.d/certbot-venv"
echo
echo "To renew now:  /opt/certbot/bin/certbot renew"

exit 1
