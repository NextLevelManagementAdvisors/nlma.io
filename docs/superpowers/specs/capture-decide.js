// ============================================================================
// Capture Decide. One item per booking due for capture, carrying the booking
// record, the Gemini notes doc already flattened per tab, and the judge verdict.
// Returns exactly one of capture / release, never both, plus a reason string
// that is safe to put in front of a guest who disputes the charge.
//
// Two rails from terms.html that have to hold on every path:
//   1. never capture more than the amount authorized
//   2. inconclusive analysis releases rather than captures
// ============================================================================
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

function decide(input){
  const b = input.booking || {};
  const doc = input.doc || null;
  const judge = input.judge || null;
  const authorized = Number(b.amount || 0);

  function release(reason, talk){
    return { action:'release', amount:0, authorized:authorized, reason:reason,
             talkSeconds: (talk === undefined ? null : talk) };
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

  // A missing summary is Gemini declining to summarise, not evidence that nothing happened.
  if (doc.summaryMissing)
    return release('The notes record that no summary could be produced, so the nature of the call is inconclusive.', talk);
  if (!judge || typeof judge.advisory !== 'boolean')
    return release('The transcript could not be assessed, so the nature of the call is inconclusive.', talk);
  if (Number(judge.confidence || 0) < JUDGE_MIN_CONFIDENCE)
    return release('The assessment of the call was not confident enough to bill against.', talk);

  // A free intro captures nothing unless it turned into advisory work.
  if (!b.billable && !judge.advisory)
    return release('This was an introductory conversation, so the hold is released as promised.', talk);

  // A paid consult that read as introductory still bills the time booked and attended:
  // the guest asked for advisory time and it was held for them.
  const increments = Math.max(1, Math.ceil(talk / (INCREMENT_MIN * 60)));
  const computed   = Math.round(increments * INCREMENT_AMOUNT * 100) / 100;
  const amount     = Math.min(computed, authorized);      // rail 1
  const capped     = computed > authorized;

  return {
    action:'capture', amount:amount, authorized:authorized, computed:computed,
    increments:increments, talkSeconds:talk, capped:capped,
    reason: (b.billable ? 'Advisory consult' : 'Introductory call that became advisory work')
      + ': ' + Math.round(talk/60) + ' min of talk time billed as ' + increments
      + ' x ' + INCREMENT_MIN + ' min at ' + DOLLAR + RATE_PER_HOUR + '/hr'
      + (capped ? ', capped at the amount authorized.' : '.')
  };
}
