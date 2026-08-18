const fs = require('fs');
// eval is deliberate and safe here: the argument is a local scratchpad file written by
// this same session, and eval is precisely how an n8n Code node runs its body, so the
// harness exercises the code the way production will. No untrusted input reaches it.
eval(fs.readFileSync(process.argv[2], 'utf8'));

let fail = 0;
function t(label, got, want){
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label +
    (ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)));
}

const intro  = { amount: 112.50, billable: false, status: 'confirmed', durationMin: 15 };
const paid30 = { amount: 225.00, billable: true,  status: 'confirmed', durationMin: 30 };
const paid60 = { amount: 450.00, billable: true,  status: 'confirmed', durationMin: 60 };
const yes = (c) => ({ advisory: true,  confidence: c === undefined ? 0.9 : c });
const no  = (c) => ({ advisory: false, confidence: c === undefined ? 0.9 : c });

console.log('--- rail 2: every inconclusive path releases ---');
t('no notes doc at all',             decide({booking:intro, doc:null}).action, 'release');
t('doc with no transcription time',  decide({booking:intro, doc:{talkTime:null}, judge:yes()}).action, 'release');
t('49-second call (the real 8/14 doc)', decide({booking:intro, doc:{talkTime:'00:00:49'}, judge:yes()}).action, 'release');
t('summary could not be produced',   decide({booking:intro, doc:{talkTime:'00:16:57', summaryMissing:true}, judge:yes()}).action, 'release');
t('no judge verdict',                decide({booking:intro, doc:{talkTime:'00:16:57'}, judge:null}).action, 'release');
t('judge unsure at 0.5',             decide({booking:intro, doc:{talkTime:'00:16:57'}, judge:yes(0.5)}).action, 'release');
t('booking never confirmed',         decide({booking:Object.assign({},intro,{status:'pending'}), doc:{talkTime:'00:16:57'}, judge:yes()}).action, 'release');
t('no authorization on record',      decide({booking:Object.assign({},intro,{amount:0}), doc:{talkTime:'00:16:57'}, judge:yes()}).action, 'release');
t('malformed talk time',             decide({booking:paid30, doc:{talkTime:'banana'}, judge:yes()}).action, 'release');

console.log('\n--- free intro: captures nothing unless it became advisory work ---');
t('intro stayed an intro', decide({booking:intro, doc:{talkTime:'00:13:25'}, judge:no()}).action, 'release');
const became = decide({booking:intro, doc:{talkTime:'00:16:57'}, judge:yes()});
t('intro became advisory', became.action, 'capture');
t('  16:57 is 2 increments', became.increments, 2);
t('  computed would be 225', became.computed, 225);
t('  RAIL 1: capped to the 112.50 authorized', became.amount, 112.50);
t('  flagged as capped', became.capped, true);

console.log('\n--- paid consult: billed on measured time, still capped ---');
const p1 = decide({booking:paid30, doc:{talkTime:'00:13:25'}, judge:yes()});
t('13:25 on a 225 auth is 1 increment', p1.increments, 1);
t('  captures 112.50, under the auth',  p1.amount, 112.50);
t('  not capped',                       p1.capped, false);
const p2 = decide({booking:paid30, doc:{talkTime:'00:15:48'}, judge:yes()});
t('15:48 rolls to 2 increments',        p2.increments, 2);
t('  captures the full 225 authorized', p2.amount, 225);
const p3 = decide({booking:paid30, doc:{talkTime:'01:12:00'}, judge:yes()});
t('72 min on a 225 auth is 5 increments', p3.increments, 5);
t('  computed 562.50 but captures 225',   [p3.computed, p3.amount], [562.5, 225]);
const p4 = decide({booking:paid60, doc:{talkTime:'00:58:10'}, judge:yes()});
t('58:10 on a 450 auth is 4 increments',  p4.increments, 4);
t('  captures the full 450',              p4.amount, 450);
t('paid consult that read as intro still bills the time held',
  decide({booking:paid30, doc:{talkTime:'00:13:25'}, judge:no()}).action, 'capture');

console.log('\n--- boundaries ---');
t('exactly 120s is a real call',      decide({booking:paid30, doc:{talkTime:'00:02:00'}, judge:yes()}).action, 'capture');
t('119s is not',                      decide({booking:paid30, doc:{talkTime:'00:01:59'}, judge:yes()}).action, 'release');
t('exactly 15:00 stays 1 increment',  decide({booking:paid30, doc:{talkTime:'00:15:00'}, judge:yes()}).increments, 1);
t('15:01 rolls to 2',                 decide({booking:paid30, doc:{talkTime:'00:15:01'}, judge:yes()}).increments, 2);
t('mm:ss form parses',                decide({booking:paid30, doc:{talkTime:'16:57'}, judge:yes()}).talkSeconds, 1017);

console.log('\n--- invariants across a wide sweep ---');
const times = ['00:00:30','00:02:00','00:07:30','00:13:25','00:15:48','00:16:57','00:45:00','01:12:00','03:00:00'];
let bad = 0, captures = 0, releases = 0;
for (const bk of [intro, paid30, paid60])
  for (const tt of times)
    for (const j of [yes(), no(), yes(0.4), null]) {
      const r = decide({booking:bk, doc:{talkTime:tt}, judge:j});
      if (r.action === 'capture') {
        captures++;
        if (!(r.amount > 0 && r.amount <= bk.amount)) { bad++; console.log('  RAIL 1 VIOLATION', bk.amount, tt, JSON.stringify(r)); }
      } else if (r.action === 'release') {
        releases++;
        if (r.amount !== 0) { bad++; console.log('  RELEASE CARRYING AN AMOUNT', JSON.stringify(r)); }
      } else { bad++; console.log('  NEITHER capture NOR release', JSON.stringify(r)); }
    }
t(captures + ' captures + ' + releases + ' releases: never over the authorization, releases always zero', bad, 0);

console.log('\nexample guest-facing reason:\n  ' + became.reason);
console.log('\n' + (fail ? fail + ' FAILURES' : 'all checks pass'));
process.exit(fail ? 1 : 0);
