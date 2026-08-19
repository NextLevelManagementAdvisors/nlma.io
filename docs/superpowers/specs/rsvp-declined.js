// A calendar RSVP is the only positive signal in this branch, and the only thing here
// allowed to move money. Everything else is a deliberate no-op: a fetch that errored,
// an event that was deleted, a guest who has not answered, a guest who accepted. If the
// event really is gone the capture sweep releases the hold once the call time passes,
// so nothing is lost by staying quiet.
const sweep=$('RSVP Sweep').all();
const fetched=$input.all();
const out=[];
for(let i=0;i<sweep.length;i++){
  const p=sweep[i].json;
  // Match a response to its booking by event id. Error items from
  // continueRegularOutput carry no id, so the index fallback is really used.
  let idx=fetched.findIndex(f=>f.json && f.json.id && f.json.id===p.booking.eventId);
  if(idx<0) idx=i;
  const ev=(fetched[idx]&&fetched[idx].json)||{};
  if(ev.error) continue;
  if(ev.status==='cancelled') continue;
  const want=String(p.booking.email||'').trim().toLowerCase();
  const guest=(ev.attendees||[]).find(a=>String(a.email||'').trim().toLowerCase()===want);
  if(!guest) continue;
  if(guest.responseStatus!=='declined') continue;
  out.push({json:{booking:p.booking, whenLabel:p.whenLabel, declinedBy:guest.email},
    pairedItem:{item:idx}});
}
return out;
