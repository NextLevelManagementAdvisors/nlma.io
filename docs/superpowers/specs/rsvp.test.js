const fs=require('fs');
// The two bodies are run the way an n8n Code node runs them: as a function whose only
// inputs are the $ helpers. That keeps the harness honest about what production sees.
const declinedSrc=fs.readFileSync('rsvp-declined.js','utf8');
const releasedSrc=fs.readFileSync('rsvp-released.js','utf8');
const runDeclined=(sweep,fetched)=>new Function('$','$input',declinedSrc)(
  (n)=>({all:()=>sweep}), {all:()=>fetched});
const runReleased=(decided,results)=>new Function('$','$input',releasedSrc)(
  (n)=>({all:()=>decided}), {all:()=>results});

let fail=0;
function t(label,fn,want){
  let got; try{ got=fn(); }catch(e){ got='THREW: '+e.message.slice(0,60); }
  const ok=(typeof want==='function')?want(got):JSON.stringify(got)===JSON.stringify(want);
  if(!ok) fail++;
  console.log((ok?'PASS':'FAIL')+'  '+label+(ok?'':'\n        got '+JSON.stringify(got)));
}

const bk=(o)=>Object.assign({token:'tk1',email:'Guest@Example.com',name:'Guest',
  eventId:'ev1',paymentIntent:'pi_1',startIso:'2026-09-01T14:00:00-04:00',amount:225},o);
const sw=(b)=>[{json:{booking:b||bk({}),whenLabel:'Tuesday, September 1 at 2:00 PM ET'}}];
const ev=(o)=>[{json:Object.assign({id:'ev1'},o)}];

console.log('--- RSVP Declined: only a real decline moves money ---');
t('declined guest, email case differs, is picked up',
  ()=>runDeclined(sw(),ev({attendees:[{email:'guest@example.com',responseStatus:'declined'}]})).length,1);
t('  and carries the booking through',
  ()=>runDeclined(sw(),ev({attendees:[{email:'guest@example.com',responseStatus:'declined'}]}))[0].json.booking.token,'tk1');
t('accepted is skipped',
  ()=>runDeclined(sw(),ev({attendees:[{email:'guest@example.com',responseStatus:'accepted'}]})).length,0);
t('tentative is skipped',
  ()=>runDeclined(sw(),ev({attendees:[{email:'guest@example.com',responseStatus:'tentative'}]})).length,0);
t('needsAction is skipped',
  ()=>runDeclined(sw(),ev({attendees:[{email:'guest@example.com',responseStatus:'needsAction'}]})).length,0);
t('no attendees at all is skipped',
  ()=>runDeclined(sw(),ev({})).length,0);
t('a different attendee declining is not the guest',
  ()=>runDeclined(sw(),ev({attendees:[{email:'someone@else.com',responseStatus:'declined'}]})).length,0);
t('a fetch that errored is skipped, not read as a decline',
  ()=>runDeclined(sw(),[{json:{error:{message:'401 unauthorized'}}}]).length,0);
t('a bare-string error is skipped too',
  ()=>runDeclined(sw(),[{json:{error:'request failed'}}]).length,0);
t('a deleted event is skipped, left to the capture sweep',
  ()=>runDeclined(sw(),ev({status:'cancelled',attendees:[{email:'guest@example.com',responseStatus:'declined'}]})).length,0);

console.log('\n--- RSVP Declined: zipping responses to bookings ---');
const twoSweep=[{json:{booking:bk({token:'a',eventId:'evA'}),whenLabel:'A'}},
                {json:{booking:bk({token:'b',eventId:'evB'}),whenLabel:'B'}}];
t('matches by event id even when the API returns them out of order',
  ()=>runDeclined(twoSweep,[
    {json:{id:'evB',attendees:[{email:'guest@example.com',responseStatus:'declined'}]}},
    {json:{id:'evA',attendees:[{email:'guest@example.com',responseStatus:'accepted'}]}}
  ]).map(x=>x.json.booking.token),['b']);
t('  and points pairedItem at the response it actually read',
  ()=>runDeclined(twoSweep,[
    {json:{id:'evB',attendees:[{email:'guest@example.com',responseStatus:'declined'}]}},
    {json:{id:'evA',attendees:[{email:'guest@example.com',responseStatus:'accepted'}]}}
  ])[0].pairedItem.item,0);
t('falls back to index when the error item has no id',
  ()=>runDeclined(twoSweep,[
    {json:{error:'boom'}},
    {json:{id:'evB',attendees:[{email:'guest@example.com',responseStatus:'declined'}]}}
  ]).map(x=>x.json.booking.token),['b']);

console.log('\n--- RSVP Released?: the guest is only told what is true ---');
const dec=[{json:{booking:bk({}),whenLabel:'W'}}];
t('a canceled intent passes',
  ()=>runReleased(dec,[{json:{id:'pi_1',status:'canceled'}}]).length,1);
t('already canceled, reported via payment_intent.status, passes',
  ()=>runReleased(dec,[{json:{error:{message:'You cannot cancel this PaymentIntent because it has a status of canceled.',payment_intent:{status:'canceled'}}}}]).length,1);
t('already canceled, message only, passes',
  ()=>runReleased(dec,[{json:{error:{message:'... it has a status of canceled.'}}}]).length,1);
t('n8n double-wrapped error object is unwrapped',
  ()=>runReleased(dec,[{json:{error:{error:{message:'has a status of canceled'}}}}]).length,1);
t('THE TRAP: an already-captured intent must NOT read as released',
  ()=>runReleased(dec,[{json:{error:{message:'You cannot cancel this PaymentIntent because it has a status of succeeded.',payment_intent:{status:'succeeded'}}}}]),
  (g)=>typeof g==='string'&&g.startsWith('THREW:'));
t('a transient failure throws rather than emailing a false release',
  ()=>runReleased(dec,[{json:{error:'502 bad gateway'}}]),
  (g)=>typeof g==='string'&&g.startsWith('THREW:'));
t('a requires_capture intent that would not cancel throws',
  ()=>runReleased(dec,[{json:{error:{message:'network error',payment_intent:{status:'requires_capture'}}}}]),
  (g)=>typeof g==='string'&&g.startsWith('THREW:'));
t('the surviving item is the booking payload, not the Stripe body',
  ()=>runReleased(dec,[{json:{id:'pi_1',status:'canceled'}}])[0].json.booking.token,'tk1');

console.log('\n'+(fail?fail+' FAILURES':'all checks pass'));
process.exit(fail?1:0);
