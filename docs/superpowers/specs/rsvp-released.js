// A cancel that did not actually happen must never be reported to the guest as released.
// Two shapes count as released: Stripe returning the intent in status canceled, and
// Stripe refusing because it is already canceled, which is the same end state and is
// exactly what a retry of a successful cancel looks like.
// Anything else throws. settledAt is written downstream, so the booking stays due, the
// next hourly sweep tries again, and the error workflow tells Forrest in the meantime.
// The match is on the terminal state, never on the word canceled appearing in the
// message: Stripe's refusal for an already-captured intent reads 'has a status of
// succeeded', and a loose match would tell a guest who was charged that nothing was.
const decided=$('RSVP Declined').all();
const results=$input.all();
const out=[];
for(let i=0;i<results.length;i++){
  const r=(results[i]&&results[i].json)||{};
  const p=(decided[i]&&decided[i].json)||{};
  if(r.status==='canceled'){ out.push({json:p, pairedItem:{item:i}}); continue; }
  const raw=r.error;
  const eo=(raw && typeof raw==='object')
    ? ((raw.error && typeof raw.error==='object') ? raw.error : raw) : {};
  const msg=(typeof raw==='string') ? raw : String(eo.message||'');
  const piStatus=(eo.payment_intent && eo.payment_intent.status) || '';
  if(piStatus==='canceled' || /status of canceled/i.test(msg)){
    out.push({json:p, pairedItem:{item:i}}); continue;
  }
  throw new Error('Could not release the hold on '+((p.booking&&p.booking.token)||'a booking')+
    ' after the guest declined the invite. Refusing to tell them it was released: '+
    (msg||JSON.stringify(r).slice(0,300)));
}
return out;
