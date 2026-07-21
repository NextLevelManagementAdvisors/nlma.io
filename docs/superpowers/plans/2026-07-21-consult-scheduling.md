# Consult Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI-triaged consult booking flow to nlma.io that lands events on `forrest@nlma.io`'s Google Calendar — free discovery books directly, billable advice books only after Stripe payment.

**Architecture:** A static, on-brand widget on a new `/consults` page runs a 3-step state machine (intake → verdict + slot picker → confirm/pay). All stateful logic lives in four n8n workflows on `n8n.nlma.io` (intake+triage, free book, checkout, Stripe-paid). Google Calendar and Stripe are called only from n8n. The site is deployed via the VPS git-pull-of-`main` pattern; n8n is built with the `build-n8n-workflow` skill.

**Tech Stack:** Static HTML/CSS/vanilla-JS (no framework, mirror existing `var`-style inline scripts); n8n (webhook + HTTP Request + Code nodes, luxon for tz math, one n8n Data Table); Anthropic Messages API (`claude-sonnet-5`); Google Calendar API v3 (`freeBusy.query`, `events.insert` w/ Meet); Stripe Checkout (NLMA account); nginx on the Hostinger VPS.

## Global Constraints

- Target calendar: `forrest@nlma.io` primary. Timezone anchor: **America/New_York**.
- Bookable slot template: **Tue & Thu at 11:00, 14:00, 16:00 ET**, recurring.
- Min notice **24h**; booking horizon **21 days**; buffer **15 min** after each call.
- AI duration ∈ **{15, 30, 45, 60}** minutes. Medium: guest picks **Google Meet** or **phone**.
- Billable rate **$450/hr, prorated** → 15m=$112.50, 30m=$225, 45m=$337.50, 60m=$450.
- Payment: **Stripe Checkout, pay-to-book**, **NLMA** Stripe account; slot **hold TTL 15 min**.
- Triage: **cliproxy `gemini-2.5-pro`** (`127.0.0.1:8317`, OpenAI format) — one call returns `{duration_min, billable, rationale, summary}`. (Superseded `claude-sonnet-5`: the on-instance Anthropic cred is dead; cliproxy is free/OAuth-backed and follows JSON-function prompts.)
- Hold store: **workflow `staticData`** (`$getWorkflowStaticData('global')`), NOT an n8n Data Table (the Data Tables API is dead on this instance).
- Frontend never sees any secret. No new client PII store beyond the calendar event + Stripe.
- Follow site conventions: nav/footer duplicated per file (no includes); brand palette + fonts inherited from the page skeleton; CSP is **nginx-level**, not in HTML.
- Never fabricate n8n credential IDs or webhook base URLs — discover them (Task 2, Step 1).
- Deploy only by pushing `main`; nothing goes live until Task 6. Work on branch `feat/consult-scheduling`.

---

## Infra addendum (verified live on n8n.nlma.io, 2026-07-21) — OVERRIDES stale plan details

- **Anthropic triage cred is DEAD.** Do triage via **cliproxy**: `POST http://127.0.0.1:8317/v1/chat/completions`, header `Authorization: Bearer <key from /opt/cliproxy/config.yaml>`, OpenAI body `{model:"gemini-2.5-pro", max_tokens:400, messages:[{role:"system",...},{role:"user",...}]}`; read `$json.choices[0].message.content`. Frame the system prompt as a "JSON triage FUNCTION" (not "you are a person"). This replaces every "Anthropic Messages API / claude-sonnet-5" reference in Task 2.
- **Google Calendar credential EXISTS:** `googleCalendarOAuth2Api` id **`kKPeZuvma85RLakQ`** name "Google Calendar account" (used by live wf `fQ4UEkVkiJdSfXCx`). **MUST verify** it can read/write `forrest@nlma.io`'s **primary** calendar before relying on it (it's currently only pointed at the room calendar `c_7736…@group.calendar.google.com`). Verification = a throwaway freeBusy call on `forrest@nlma.io` with this cred; if 403/404, mint a new Calendar OAuth2 cred (Forrest signs in — Claude never types passwords).
- **Webhook + CORS pattern (mirror the live `nlma-contact` webhook):** `n8n-nodes-base.webhook`, `httpMethod:POST`, `responseMode:"responseNode"`, `options.allowedOrigins:"https://nlma.io,https://www.nlma.io"` (native CORS — no manual header nodes), paired with `respondToWebhook` nodes (responseCode 200/400). Use this for all four consult webhooks.
- **Hold store = `staticData`.** In each workflow that reads/writes holds, use `const s=$getWorkflowStaticData('global'); s.holds = (s.holds||[]).filter(h=>h.expiresAt>nowISO)`; a hold = `{holdId, slotStartISO, durationMin, expiresAt, status}`. `consult-intake` and `consult-checkout` are separate workflows, so the shared hold list must live where both can see it — put the checkout+paid+intake availability logic that touches holds in a design where holds are readable across them: simplest is a **single "consult-availability" helper** OR store holds in the `consult-checkout` workflow's global staticData and have `consult-intake` read them via a sub-call. DECISION for build: keep holds in **`consult-checkout` staticData**, and have `consult-intake` subtract holds by calling a lightweight internal `GET` on checkout's hold list (or accept a tiny race — holds are 15 min and slots are re-checked at booking, so an unsubtracted hold only risks showing a soon-to-expire slot that the freebusy re-check + hold-insert will catch). Re-evaluate during Task 4 build.
- **Stripe:** no direct-Stripe-API node exists to copy (FSBT proxies through its own app), so build the Stripe HTTP calls per Task 4 as speced with NLMA keys.

---

## File / workflow structure

**Frontend (repo `NextLevelManagementAdvisors/nlma.io`, local clone `C:\Users\forre\Source\nlma.io`):**
- Create: `consults.html` — the booking page + widget (built from the `contact.html` skeleton).
- Create: `consults/confirmed.html` — post-Stripe return page (billable path).
- Modify (Task 5, nav/CTA): `index.html`, `about.html`, `services.html`, `portfolio.html`, `referrals.html`, `contact.html`, `resume.html` — add "Book a consult" CTA + `/consults` nav/footer link.

**Backend (n8n on `n8n.nlma.io`, built via `build-n8n-workflow` skill):**
- Workflow `consult-intake` — webhook `POST /webhook/consult-intake`.
- Workflow `consult-book` — webhook `POST /webhook/consult-book` (free path).
- Workflow `consult-checkout` — webhook `POST /webhook/consult-checkout` (billable path).
- Workflow `consult-paid` — webhook `POST /webhook/consult-paid` (Stripe events).
- n8n Data Table `consult_holds`.

**Infra (VPS `root@178.16.141.166`):**
- Modify: `/etc/nginx/sites-available/nlma.io` — CSP `connect-src`/`form-action` + per-route `limit_req`.

---

## Task 1: `/consults` page + widget against a mocked backend

Build the entire UI and state machine with a local mock so the frontend is fully verifiable before any backend exists.

**Files:**
- Create: `consults.html`
- Create: `consults/confirmed.html`

**Interfaces:**
- Consumes: nothing (mock).
- Produces: the widget contract later tasks must satisfy —
  - Intake POST body: `{name, email, phone, medium: "meet"|"phone", request, company_website}` (last = honeypot, must be empty).
  - Intake response: `{duration_min:number, billable:boolean, price:number, summary:string, rationale:string, slots:[{startIso:string /*ET, offset-aware ISO*/}]}`.
  - Book POST body: `{name, email, phone, medium, request, duration_min, startIso}` → response `{status:"booked", meetLink?:string}`.
  - Checkout POST body: same as Book → response `{checkoutUrl:string}`.

- [ ] **Step 1: Create `consults.html` from the skeleton**

Copy `contact.html` to `consults.html` to inherit the exact `<head>` (icons/OG/manifest), CSS variables, `.site-head` desktop nav, `.mobile-nav`, and footer. Then change only:
- `<title>` → `Book a consult · NLMA · Next Level Management Advisors`
- `<meta name="description">` → `Book a consult with NLMA — describe what you need and pick a time.`
- Add `<link rel="canonical" href="https://nlma.io/consults" />`
- Set the Contact nav item's `aria-current` off and add a Consults `aria-current="page"` (nav link itself added site-wide in Task 5; for now hardcode the current-page marker on this file's own nav).

- [ ] **Step 2: Replace the `<main>` content with the widget markup**

Replace everything inside `<main>…</main>` with:

```html
<main id="main">
  <section class="wrap booking">
    <p class="eyebrow">Consult</p>
    <h1 class="display">Book time with NLMA</h1>
    <p class="lede">Tell us what you need. We size the call, and if it’s a paid advisory session you’ll see the price before you book. Free intro calls book instantly.</p>

    <!-- STEP 1: intake -->
    <form id="intakeForm" class="card" novalidate>
      <div class="field"><label for="f-name">Your name</label>
        <input id="f-name" type="text" autocomplete="name" required placeholder="Jane Smith" /></div>
      <div class="field"><label for="f-email">Email</label>
        <input id="f-email" type="email" autocomplete="email" required placeholder="jane@company.com" /></div>
      <div class="field"><span class="label">How should we meet?</span>
        <div class="seg" role="radiogroup" aria-label="Meeting medium">
          <label><input type="radio" name="medium" value="meet" checked /> Google Meet</label>
          <label><input type="radio" name="medium" value="phone" /> Phone</label>
        </div></div>
      <div class="field" id="phoneField" hidden><label for="f-phone">Phone number</label>
        <input id="f-phone" type="tel" autocomplete="tel" placeholder="+1 555 123 4567" /></div>
      <div class="field"><label for="f-request">What do you need?</label>
        <textarea id="f-request" rows="5" maxlength="2000" required placeholder="Describe your situation, question, or project."></textarea></div>
      <input id="f-company" name="company_website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" />
      <button class="btn btn-primary" id="intakeBtn" type="submit"><span class="dot"></span>Continue</button>
      <p class="formnote" id="intakeNote" hidden></p>
    </form>

    <!-- STEP 2: verdict + slots -->
    <div id="resultStep" class="card" hidden>
      <div id="verdict" class="verdict"></div>
      <p id="summary" class="muted"></p>
      <p id="freeSwitch" hidden><button type="button" class="linkbtn" id="requestFree">Request a free intro instead →</button></p>
      <h2 class="sub">Pick a time <span class="muted" id="tzNote"></span></h2>
      <div id="slots" class="slots" aria-live="polite"></div>
      <div class="rowbtns">
        <button type="button" class="btn btn-ghost" id="backBtn">← Edit request</button>
        <button type="button" class="btn btn-primary" id="confirmBtn" disabled><span class="dot"></span><span id="confirmLabel">Confirm</span></button>
      </div>
      <p class="formnote" id="resultNote" hidden></p>
    </div>

    <!-- STEP 3: done (free path inline; billable returns to /consults/confirmed) -->
    <div id="doneStep" class="card" hidden>
      <h2 class="sub">You’re booked ✓</h2>
      <p id="doneMsg" class="muted"></p>
      <p><a class="btn btn-ghost" href="/">← Back to nlma.io</a></p>
    </div>

    <p class="fallback muted" id="fallback" hidden>Booking is temporarily unavailable — email <a href="mailto:info@nlma.io?subject=Consult%20request">info@nlma.io</a> or call <a href="tel:+15712002032">+1 571 200 2032</a> and we’ll set it up.</p>
  </section>
</main>
```

- [ ] **Step 3: Add widget-specific CSS**

Append to the page’s inline `<style>` (reuse existing tokens `--signal`, `--muted`, `--paper`, `--line`, `--f-display`):

```css
.booking{max-width:760px;padding-block:clamp(48px,9vw,110px)}
.booking .card{background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:16px;padding:clamp(20px,3vw,34px);margin-top:26px}
.field{margin-bottom:18px;display:flex;flex-direction:column;gap:7px}
.field .label,.field label{font-size:14px;color:var(--muted)}
.field input,.field textarea{background:rgba(0,0,0,.25);border:1px solid var(--line);border-radius:10px;color:var(--paper);padding:12px 14px;font:inherit}
.field input:focus,.field textarea:focus{outline:none;border-color:var(--signal)}
.seg{display:flex;gap:10px}.seg label{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:10px;padding:10px 14px;cursor:pointer;color:var(--paper)}
.verdict{font-family:var(--f-display);font-size:clamp(1.3rem,3vw,1.7rem);margin-bottom:10px}
.verdict .price{color:var(--signal)}
.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:14px 0 22px}
.slots button{background:rgba(0,0,0,.25);border:1px solid var(--line);border-radius:10px;color:var(--paper);padding:11px;cursor:pointer;font:inherit}
.slots button[aria-pressed="true"]{border-color:var(--signal);background:rgba(79,194,149,.12)}
.slots .empty{color:var(--muted);grid-column:1/-1}
.rowbtns{display:flex;gap:12px;flex-wrap:wrap}
.btn-ghost{border:1px solid var(--line);color:var(--paper)}
.linkbtn{background:none;border:none;color:var(--signal);cursor:pointer;font:inherit;padding:0}
.formnote{margin-top:12px;color:#ff9b9b;font-size:14px}
.sub{font-family:var(--f-display);font-size:1.15rem;margin:18px 0 4px}
```

- [ ] **Step 4: Add the widget script (mocked backend)**

Replace the page’s existing inline `<script>` (the contact composer) with this. `MOCK=true` returns canned data so the UI is fully exercisable offline.

```html
<script>
(function(){
  var CONFIG={
    intake:"/webhook/consult-intake", book:"/webhook/consult-book", checkout:"/webhook/consult-checkout",
    MOCK:true
  };
  var $=function(id){return document.getElementById(id)};
  var state={data:null, slot:null};

  // medium toggle reveals phone
  Array.prototype.forEach.call(document.getElementsByName("medium"),function(r){
    r.addEventListener("change",function(){ $("phoneField").hidden = (r.value!=="phone")||!r.checked; });
  });

  function tzLabel(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"local time"}catch(e){return "local time"}}
  function fmtSlot(iso){
    var d=new Date(iso);
    var local=d.toLocaleString([], {weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
    var et=d.toLocaleString([], {timeZone:"America/New_York",hour:"numeric",minute:"2-digit"});
    return {local:local, et:et};
  }

  async function callBackend(url, body){
    if(CONFIG.MOCK){ return mock(url, body); }
    var res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!res.ok) throw new Error("HTTP "+res.status);
    return res.json();
  }
  function mock(url, body){
    if(url===CONFIG.intake){
      return Promise.resolve({duration_min:45, billable:true, price:337.5,
        summary:"Advisory session on structuring a distressed-property acquisition.",
        rationale:"Advice-only request from a non-managed party.",
        slots:[isoInDays(2,11),isoInDays(2,14),isoInDays(4,16),isoInDays(7,11)]});
    }
    if(url===CONFIG.book) return Promise.resolve({status:"booked", meetLink:"https://meet.google.com/xxx-mock"});
    if(url===CONFIG.checkout) return Promise.resolve({checkoutUrl:"https://checkout.stripe.com/mock"});
  }
  function isoInDays(days,hourET){ // crude mock ET slot
    var d=new Date(); d.setDate(d.getDate()+days); d.setHours(hourET,0,0,0); return d.toISOString();
  }

  function val(id){return ($(id).value||"").trim()}
  function medium(){var r=document.querySelector('input[name="medium"]:checked');return r?r.value:"meet"}

  $("intakeForm").addEventListener("submit",async function(e){
    e.preventDefault();
    $("intakeNote").hidden=true;
    if(val("f-company")!==""){return;} // honeypot: silently drop
    if(!val("f-name")||!val("f-email")||!val("f-request")){ note("intakeNote","Please fill in your name, email, and request."); return; }
    setBusy("intakeBtn",true,"Analyzing…");
    try{
      var data=await callBackend(CONFIG.intake,{name:val("f-name"),email:val("f-email"),phone:val("f-phone"),medium:medium(),request:val("f-request"),company_website:val("f-company")});
      state.data=data; renderResult(data);
    }catch(err){ showFallback(); }
    finally{ setBusy("intakeBtn",false,"Continue"); }
  });

  function renderResult(data){
    $("intakeForm").hidden=true; $("resultStep").hidden=false; $("doneStep").hidden=true;
    var mins=data.duration_min;
    var v = data.billable
      ? '~'+mins+'-min paid consult — <span class="price">$'+data.price.toFixed(2)+'</span>'
      : 'Free intro call — ~'+mins+' min';
    $("verdict").innerHTML=v;
    $("summary").textContent=data.summary?("What we’ll cover: "+data.summary):"";
    $("freeSwitch").hidden=!data.billable;
    $("confirmLabel").textContent = data.billable ? ("Pay $"+data.price.toFixed(2)+" & book") : "Confirm booking";
    $("tzNote").textContent="(times shown in "+tzLabel()+")";
    renderSlots(data.slots||[]);
  }
  function renderSlots(slots){
    var wrap=$("slots"); wrap.innerHTML=""; state.slot=null; $("confirmBtn").disabled=true;
    if(!slots.length){ wrap.innerHTML='<p class="empty">No open times in the next few weeks — email info@nlma.io and we’ll find one.</p>'; return; }
    slots.forEach(function(s){
      var f=fmtSlot(s.startIso||s);
      var b=document.createElement("button"); b.type="button";
      b.innerHTML=f.local+'<br><span class="muted">'+f.et+' ET</span>';
      b.setAttribute("aria-pressed","false");
      b.addEventListener("click",function(){
        Array.prototype.forEach.call(wrap.children,function(c){c.setAttribute&&c.setAttribute("aria-pressed","false")});
        b.setAttribute("aria-pressed","true"); state.slot=(s.startIso||s); $("confirmBtn").disabled=false;
      });
      wrap.appendChild(b);
    });
  }

  $("backBtn").addEventListener("click",function(){ $("resultStep").hidden=true; $("intakeForm").hidden=false; });
  $("requestFree").addEventListener("click",function(){
    state.data.billable=false; state.data.price=0; renderResult(state.data);
  });

  $("confirmBtn").addEventListener("click",async function(){
    if(!state.slot) return;
    $("resultNote").hidden=true; setBusy("confirmBtn",true,"Working…");
    var body={name:val("f-name"),email:val("f-email"),phone:val("f-phone"),medium:medium(),request:val("f-request"),duration_min:state.data.duration_min,startIso:state.slot};
    try{
      if(state.data.billable){
        var c=await callBackend(CONFIG.checkout,body); window.location.href=c.checkoutUrl;
      }else{
        var r=await callBackend(CONFIG.book,body);
        $("resultStep").hidden=true; $("doneStep").hidden=false;
        $("doneMsg").innerHTML="Check your email for the calendar invite"+(r.meetLink?', including your Google Meet link.':'.');
      }
    }catch(err){ note("resultNote","Something went wrong — please try another time or email info@nlma.io."); setBusy("confirmBtn",false, state.data.billable?("Pay $"+state.data.price.toFixed(2)+" & book"):"Confirm booking"); }
  });

  function setBusy(id,busy,label){var b=$(id);b.disabled=busy;b.innerHTML='<span class="dot"></span>'+label;}
  function note(id,msg){var n=$(id);n.textContent=msg;n.hidden=false;}
  function showFallback(){$("fallback").hidden=false;}
})();
</script>
```

- [ ] **Step 5: Create `consults/confirmed.html`**

Copy `consults.html`’s skeleton (head/nav/footer) into `consults/confirmed.html`; replace `<main>` with a confirmation panel and a script that reads Stripe’s return params:

```html
<main id="main"><section class="wrap booking">
  <p class="eyebrow">Consult</p>
  <h1 class="display" id="cfTitle">Confirming your booking…</h1>
  <p class="lede" id="cfMsg">One moment while we finalize your session.</p>
  <p><a class="btn btn-ghost" href="/">← Back to nlma.io</a></p>
</section></main>
<script>
(function(){
  var q=new URLSearchParams(location.search);
  if(q.get("canceled")){document.getElementById("cfTitle").textContent="Payment canceled";document.getElementById("cfMsg").textContent="No charge was made. You can pick another time on the booking page.";return;}
  document.getElementById("cfTitle").textContent="You’re booked ✓";
  document.getElementById("cfMsg").innerHTML="Payment received. Your calendar invite"+ " (with a Google Meet link if you chose video) is on its way to your email. See you then.";
})();
</script>
```

- [ ] **Step 6: Verify the UI locally**

Run: `cd /c/Users/forre/Source/nlma.io && python -m http.server 8099`
Open `http://localhost:8099/consults.html`. Confirm:
- Medium=Phone reveals the phone field.
- Submitting with empty required fields shows the inline note; filling them advances to the verdict (mock: "~45-min paid consult — $337.50") with 4 slots in local time + ET.
- "Request a free intro instead" flips the verdict to free and the button to "Confirm booking".
- Selecting a slot enables the button; free-path confirm shows the "You’re booked ✓" panel; billable-path would redirect (mock URL).
- Filling the hidden `company_website` field (via devtools) makes submit silently no-op (honeypot).
- Open `http://localhost:8099/consults/confirmed.html?canceled=1` → "Payment canceled"; without params → "You’re booked ✓".

Expected: all pass; no console errors.

- [ ] **Step 7: Commit**

```bash
cd /c/Users/forre/Source/nlma.io
git add consults.html consults/confirmed.html
git commit -m "feat(consults): booking widget UI against mocked backend"
```

---

## Task 2: n8n `consult-intake` (triage + freebusy) and wire the widget to it

**Files/workflows:**
- Create n8n workflow `consult-intake` (webhook).
- Modify: `consults.html` (flip `MOCK` off, point at the real base URL).

**Interfaces:**
- Consumes: intake POST body from Task 1.
- Produces: intake response shape from Task 1 (`duration_min, billable, price, summary, rationale, slots[]`).

- [ ] **Step 1: Discover infra (no fabrication)**

Invoke the `build-n8n-workflow` skill. From it / the n8n instance, record: the **Anthropic API credential** id, the **Google Calendar OAuth2 credential** id authorized for `forrest@nlma.io` (create one if absent — it must have calendar read/write), and the **public webhook base URL** (`https://n8n.nlma.io/webhook`). Confirm luxon `DateTime` is available in Code nodes. Write these into the plan’s working notes; use them verbatim below.

- [ ] **Step 2: Build the `consult-intake` workflow**

Nodes in order:

1. **Webhook** — `POST`, path `consult-intake`, Respond = "Using Respond to Webhook node", **Raw Body off** (JSON).
2. **Code: guard** — reject abuse before spending tokens:
```js
const b = $json.body || $json;
if ((b.company_website||"").trim() !== "") return [{json:{__drop:true}}]; // honeypot
const request = (b.request||"").slice(0,2000).trim();
if (!b.name || !b.email || !request) throw new Error("missing_fields");
return [{json:{name:String(b.name).slice(0,120), email:String(b.email).slice(0,160), phone:String(b.phone||"").slice(0,40), medium: b.medium==="phone"?"phone":"meet", request}}];
```
3. **IF** `{{$json.__drop}}` is true → dead-end (Respond 204). Else continue.
4. **HTTP Request: Claude triage** — `POST https://api.anthropic.com/v1/messages`, auth = Anthropic credential, headers `anthropic-version: 2023-06-01`, JSON body:
```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 400,
  "system": "You triage inbound consult requests for Forrest Surprenant, Managing Partner of NLMA (Next Level Management Advisors) and agent for FIDUM property management. Classify each request and size the meeting. Return ONLY minified JSON: {\"duration_min\":15|30|45|60,\"billable\":true|false,\"rationale\":\"<=140 chars\",\"summary\":\"<=160 chars, what the call will cover\"}. Rules: billable=false when the requester is a PROSPECTIVE CLIENT for NLMA/FIDUM services (property management, short-term rentals, real-estate deals, or software/AI automation buildouts) — a sales/discovery call. billable=true when they seek Forrest's ADVICE or EXPERTISE without becoming a managed client (e.g., attorneys, other investors, one-off strategy or advisory). duration_min = your estimate of time needed, snapped to the nearest allowed value.",
  "messages": [{"role":"user","content":"{{ JSON.stringify($json.request) }}"}]
}
```
5. **Code: parse + price** —
```js
const t = $json; // Anthropic response
let txt = (t.content && t.content[0] && t.content[0].text) || "{}";
let j; try { j = JSON.parse(txt); } catch(e){ j = {duration_min:30, billable:false, rationale:"", summary:""}; }
const allowed=[15,30,45,60];
let d = allowed.includes(j.duration_min) ? j.duration_min : allowed.reduce((a,b)=>Math.abs(b-(j.duration_min||30))<Math.abs(a-(j.duration_min||30))?b:a,30);
const RATE=450;
const price = j.billable ? Math.round((RATE*d/60)*100)/100 : 0;
const p = $items(0).map(x=>x.json); // carry name/email/etc from guard via merge if needed
return [{json:{duration_min:d, billable:!!j.billable, price, rationale:String(j.rationale||"").slice(0,140), summary:String(j.summary||"").slice(0,160)}}];
```
   > Wire the guard output into this node too (via a Merge or by referencing `$('Code: guard').item.json`) so `duration_min` etc. travel with `name/email/medium`.
6. **Code: build available slots** — luxon ET template minus freebusy minus <24h:
```js
const { DateTime } = require ? require('luxon') : {DateTime: DateTime};
const ZONE="America/New_York", HOURS=[11,14,16], DOW=[2,4]; // Tue,Thu
const dur = $json.duration_min, BUFFER=15, HORIZON=21, MINH=24;
const now = DateTime.now().setZone(ZONE);
const min = now.plus({hours:MINH});
const cand=[];
for(let i=0;i<=HORIZON;i++){
  const day=now.plus({days:i});
  if(!DOW.includes(day.weekday)) continue;
  for(const h of HOURS){
    const start=day.set({hour:h,minute:0,second:0,millisecond:0});
    if(start < min) continue;
    cand.push(start);
  }
}
// stash for the freebusy node
return [{json:{...$json, _candidates:cand.map(c=>c.toISO()), _timeMin:now.toISO(), _timeMax:now.plus({days:HORIZON+1}).toISO()}}];
```
7. **HTTP Request: freeBusy** — `POST https://www.googleapis.com/calendar/v3/freeBusy`, auth = Google Calendar OAuth2 cred, JSON body:
```json
{"timeMin":"={{$json._timeMin}}","timeMax":"={{$json._timeMax}}","timeZone":"America/New_York","items":[{"id":"forrest@nlma.io"}]}
```
8. **Code: filter candidates** — drop any candidate whose `[start, start+dur+buffer)` overlaps a busy block or an active hold:
```js
const { DateTime, Interval } = require('luxon');
const busy = (($json.calendars && $json.calendars['forrest@nlma.io'] && $json.calendars['forrest@nlma.io'].busy)||[])
  .map(b=>Interval.fromDateTimes(DateTime.fromISO(b.start), DateTime.fromISO(b.end)));
const prev = $('Code: build available slots').item.json;
const dur = prev.duration_min, BUFFER=15;
// active holds from the data table (read in a prior node or here via a Data Table node output merged in as $json._holds)
const holds = (prev._holds||[]).map(h=>Interval.fromDateTimes(DateTime.fromISO(h.slotStartISO), DateTime.fromISO(h.slotStartISO).plus({minutes:h.durationMin+BUFFER})));
const open = prev._candidates.filter(iso=>{
  const s=DateTime.fromISO(iso), e=s.plus({minutes:dur+BUFFER});
  const iv=Interval.fromDateTimes(s,e);
  return !busy.some(b=>b.overlaps(iv)) && !holds.some(h=>h.overlaps(iv));
}).map(iso=>({startIso:iso}));
return [{json:{duration_min:dur, billable:prev.billable, price:prev.price, summary:prev.summary, rationale:prev.rationale, slots:open}}];
```
   > Read active `consult_holds` (status=held, not expired) via a **Data Table: get** node before this and merge as `_holds` (the table is created in Task 4; until then `_holds` is empty — the code already tolerates that).
9. **Respond to Webhook** — JSON `{{ $json }}`, plus permissive CORS for now (`Access-Control-Allow-Origin: https://nlma.io`).

- [ ] **Step 3: Validate the workflow**

Use `n8n_validate_workflow` on `consult-intake`. Expected: no errors (warnings about the not-yet-existing holds table are acceptable — `_holds` defaults empty).

- [ ] **Step 4: Test intake via curl**

Run:
```bash
curl -sS -X POST https://n8n.nlma.io/webhook/consult-intake \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Atty","email":"atty@example.com","medium":"meet","request":"I am an attorney and need 40 minutes of your advice structuring a subject-to deal for a client.","company_website":""}' | jq .
```
Expected: JSON with `billable:true`, a sensible `duration_min` (likely 45), `price` matching `450*duration/60`, a non-empty `summary`, and a `slots` array of future Tue/Thu 11/14/16 ET times (empty is acceptable if the calendar is fully busy — verify by widening a test window). Then run a "prospective client" request and expect `billable:false, price:0`.

- [ ] **Step 5: Wire the widget to the live endpoint**

In `consults.html`, set `CONFIG.MOCK=false` and set the three URLs to absolute: `https://n8n.nlma.io/webhook/consult-intake|consult-book|consult-checkout`.
Re-serve locally (Step 6 of Task 1) and submit the form; expected: real triage + real slots render. (CSP isn’t enforced on localhost, so cross-origin fetch to n8n works in this local test.)

- [ ] **Step 6: Commit**

```bash
git add consults.html
git commit -m "feat(consults): wire intake widget to n8n triage + freebusy"
```
(Export the n8n workflow JSON to `n8n/consult-intake.json` in the repo for versioning and commit it too, if the n8n backup convention is in use.)

---

## Task 3: n8n `consult-book` (free path, end-to-end)

**Workflows:** Create `consult-book`.

**Interfaces:**
- Consumes: Book POST body from Task 1.
- Produces: `{status:"booked", meetLink?:string}` and a real Google Calendar event on `forrest@nlma.io`.

- [ ] **Step 1: Build the `consult-book` workflow**

1. **Webhook** — `POST` path `consult-book`, Respond via Respond node.
2. **Code: validate input** —
```js
const b=$json.body||$json;
const allowed=[15,30,45,60];
if(!b.email||!b.startIso||!allowed.includes(b.duration_min)) throw new Error("bad_request");
if((b.company_website||"").trim()!=="") throw new Error("dropped");
return [{json:{name:String(b.name||"").slice(0,120),email:String(b.email).slice(0,160),phone:String(b.phone||"").slice(0,40),medium:b.medium==="phone"?"phone":"meet",request:String(b.request||"").slice(0,2000),duration_min:b.duration_min,startIso:b.startIso}}];
```
3. **HTTP Request: freeBusy re-check** — same as Task 2 node 7 but `timeMin=startIso`, `timeMax=startIso+dur+buffer`. 
4. **Code: race guard** — throw `slot_taken` if the single window overlaps any returned busy block (reuse the luxon overlap check). On throw, the Respond-error branch returns `{status:"slot_taken"}` with HTTP 409.
5. **HTTP Request: create event** — `POST https://www.googleapis.com/calendar/v3/calendars/forrest@nlma.io/events?conferenceDataVersion=1&sendUpdates=all`, Google cred, JSON:
```json
{
  "summary": "Consult — {{$json.name}} (NLMA)",
  "description": "Medium: {{$json.medium}}\nGuest: {{$json.name}} <{{$json.email}}>{{ $json.phone ? '\\nPhone: '+$json.phone : '' }}\n\nRequest:\n{{$json.request}}",
  "start": {"dateTime":"{{$json.startIso}}","timeZone":"America/New_York"},
  "end":   {"dateTime":"={{ DateTime.fromISO($json.startIso).plus({minutes:$json.duration_min}).toISO() }}","timeZone":"America/New_York"},
  "attendees": [{"email":"{{$json.email}}"}],
  "conferenceData": { "createRequest": { "requestId": "={{ $json.email + '-' + $json.startIso }}", "conferenceSolutionKey": {"type":"hangoutsMeet"} } }
}
```
   > For `medium=phone`, omit `conferenceData` (branch with an IF, or set `conferenceDataVersion=0` and drop the field). Put the guest phone in the description (already there).
6. **Code: shape response** — `return [{json:{status:"booked", meetLink: $json.hangoutLink || ($json.conferenceData && $json.conferenceData.entryPoints && $json.conferenceData.entryPoints[0] && $json.conferenceData.entryPoints[0].uri) || null}}];`
7. **Respond to Webhook** — JSON, CORS origin `https://nlma.io`.

- [ ] **Step 2: Validate**

`n8n_validate_workflow` on `consult-book`. Expected: no errors.

- [ ] **Step 3: Test the free path via curl (books a REAL event)**

Pick an open slot returned by intake, then:
```bash
curl -sS -X POST https://n8n.nlma.io/webhook/consult-book -H 'Content-Type: application/json' \
 -d '{"name":"Test Free","email":"YOUR_TEST_EMAIL","medium":"meet","request":"prospective STR client","duration_min":30,"startIso":"<OPEN_ET_ISO>"}' | jq .
```
Expected: `{"status":"booked","meetLink":"https://meet.google.com/..."}`. Verify: the event appears on `forrest@nlma.io`’s calendar at the right ET time with a Meet link, and the test email received a Google invite. Re-POST the same slot → expect `409 slot_taken`. **Delete the test event afterward.**

- [ ] **Step 4: End-to-end free booking in the browser**

Local-serve `consults.html` (MOCK off). Submit a request the triage will mark free (e.g. "I want you to manage my short-term rental"), pick a slot, Confirm → "You’re booked ✓" and a real invite. Delete the test event.

- [ ] **Step 5: Commit**

```bash
git add consults.html n8n/consult-book.json 2>/dev/null; git commit -m "feat(consults): free-path booking to Google Calendar"
```

---

## Task 4: Hold store + `consult-checkout` + `consult-paid` (Stripe, test mode)

**Requires NLMA Stripe TEST keys** (secret + webhook signing secret) — obtain from the NLMA Stripe dashboard and store as n8n credentials/vars. Do all of Task 4 in Stripe **test mode**.

**Workflows/stores:** Data Table `consult_holds`; workflows `consult-checkout`, `consult-paid`.

**Interfaces:**
- `consult-checkout` consumes the Book body → produces `{checkoutUrl}` and writes a hold.
- `consult-paid` consumes Stripe `checkout.session.completed` → creates the event, releases the hold.

- [ ] **Step 1: Create the `consult_holds` Data Table**

Via `n8n_manage_datatable`: columns `holdId (string)`, `slotStartISO (string)`, `durationMin (number)`, `expiresAt (string ISO)`, `status (string: held|done|expired)`. Then edit `consult-intake`’s "Data Table: get" node (Task 2, Step 2.8) to fetch `status=held AND expiresAt > now` and merge as `_holds`.

- [ ] **Step 2: Build `consult-checkout`**

1. **Webhook** `POST consult-checkout`, Respond node.
2. **Code: validate** (same as Task 3 Step 1.2) + generate `holdId` (`crypto.randomUUID()`), reject non-billable (`price<=0` → error `not_billable`; billable is decided by re-deriving price = `450*dur/60`, do **not** trust a client price).
3. **HTTP Request: freeBusy re-check** + **race guard** (as Task 3) → 409 if taken.
4. **Data Table: insert** hold `{holdId, slotStartISO:startIso, durationMin:duration_min, expiresAt: now+15min, status:"held"}`.
5. **HTTP Request: Stripe Checkout** — `POST https://api.stripe.com/v1/checkout/sessions`, `Authorization: Bearer <NLMA test secret>`, `Content-Type: application/x-www-form-urlencoded`, body (form-encoded):
```
mode=payment
customer_email={{$json.email}}
line_items[0][price_data][currency]=usd
line_items[0][price_data][product_data][name]=NLMA consult ({{$json.duration_min}} min)
line_items[0][price_data][unit_amount]={{ Math.round(450*$json.duration_min/60*100) }}
line_items[0][quantity]=1
success_url=https://nlma.io/consults/confirmed?ok=1
cancel_url=https://nlma.io/consults?canceled=1
metadata[holdId]={{$json.holdId}}
metadata[slotStartISO]={{$json.startIso}}
metadata[durationMin]={{$json.duration_min}}
metadata[name]={{$json.name}}
metadata[email]={{$json.email}}
metadata[phone]={{$json.phone}}
metadata[medium]={{$json.medium}}
metadata[request]={{ $json.request.slice(0,450) }}
```
6. **Respond** — `{checkoutUrl: {{$json.url}}}`.

- [ ] **Step 3: Build `consult-paid` (Stripe webhook)**

1. **Webhook** `POST consult-paid`, **Raw Body ON** (needed for signature), Respond node.
2. **Code: verify signature** —
```js
const crypto=require('crypto');
const sig=$json.headers['stripe-signature'];
const raw=$json.body; // raw string (Raw Body on)
const secret=$vars.STRIPE_WH_SECRET; // NLMA test signing secret
const parts=Object.fromEntries(sig.split(',').map(kv=>kv.split('=')));
const expected=crypto.createHmac('sha256',secret).update(parts.t+'.'+raw).digest('hex');
if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(parts.v1))) throw new Error("bad_signature");
const evt=JSON.parse(raw);
if(evt.type!=='checkout.session.completed') return [{json:{__ignore:true}}];
return [{json:{__ignore:false, sessionId:evt.data.object.id, meta:evt.data.object.metadata}}];
```
3. **IF** `__ignore` → Respond 200 `{received:true}` (Stripe needs 2xx).
4. **Data Table: get** hold by `holdId=meta.holdId`. **IF** already `status=done` (idempotency on Stripe retries) → Respond 200.
5. **HTTP: freeBusy re-check** on `meta.slotStartISO`.
   - **Race guard branch — slot free:** create the Calendar event (Task 3 node 5, values from `meta`), set hold `status=done`, Respond 200.
   - **slot taken:** **HTTP: Stripe refund** `POST https://api.stripe.com/v1/refunds` with `payment_intent={{evt.data.object.payment_intent}}`; **Gmail/SMTP** apology to `meta.email` with a `/consults` rebook link; set hold `status=expired`; Respond 200.

- [ ] **Step 4: Point Stripe test webhook at n8n**

In the Stripe (test) dashboard → Developers → Webhooks → add endpoint `https://n8n.nlma.io/webhook/consult-paid`, event `checkout.session.completed`; copy the signing secret into the n8n `STRIPE_WH_SECRET` var.

- [ ] **Step 5: Validate both workflows**

`n8n_validate_workflow` on `consult-checkout` and `consult-paid`. Expected: no errors.

- [ ] **Step 6: Test the billable path with a Stripe test card**

Local-serve `consults.html` (MOCK off). Submit an advice-only request → billable verdict → pick slot → "Pay $X & book" → redirected to Stripe Checkout → pay with `4242 4242 4242 4242`, any future expiry/CVC → redirected to `/consults/confirmed?ok=1`. Verify: the `consult-paid` execution ran, the event was created on the calendar with the guest + Meet link, the hold flipped to `done`, and the test email got the invite. Then verify the **race path** by manually inserting a conflicting event before paying and confirming a refund is issued. **Delete test events afterward.**

- [ ] **Step 7: Commit**

```bash
git add consults.html n8n/consult-checkout.json n8n/consult-paid.json 2>/dev/null
git commit -m "feat(consults): billable path — holds, Stripe Checkout, paid webhook (test mode)"
```

---

## Task 5: nginx CSP + rate-limit, nav/CTA wiring across all pages, deploy

**Files:** VPS `/etc/nginx/sites-available/nlma.io`; repo pages `index.html, about.html, services.html, portfolio.html, referrals.html, contact.html, resume.html` (+ the two consults files already created).

- [ ] **Step 1: Inspect the current CSP**

Run: `ssh root@178.16.141.166 "grep -n 'Content-Security-Policy\|limit_req\|server_name' /etc/nginx/sites-available/nlma.io"`
Record the exact current `Content-Security-Policy` value.

- [ ] **Step 2: Extend CSP + add a rate-limit zone**

Edit the vhost so the policy includes (merge into existing directives, don’t duplicate):
- `connect-src 'self' https://n8n.nlma.io;`
- `form-action 'self' https://checkout.stripe.com;`
- keep all existing sources.
Add near the top of the file: `limit_req_zone $binary_remote_addr zone=consult:10m rate=20r/m;` and, in a `location = /consults` (and the webhook proxy if n8n is fronted here), `limit_req zone=consult burst=5 nodelay;`
Then: `ssh root@178.16.141.166 "nginx -t && systemctl reload nginx"`. Expected: `syntax is ok` / `test is successful`.

- [ ] **Step 3: Verify headers live**

Run: `curl -sI https://nlma.io/consults.html | grep -i content-security-policy`
Expected: the policy now shows `connect-src` including `https://n8n.nlma.io` and `form-action` including `https://checkout.stripe.com`.

- [ ] **Step 4: Wire nav + CTA across every page**

In each of the 7 pages, make three identical edits (copy the exact anchor markup from `contact.html`’s existing structures):
1. Desktop `.nav`: add `<a href="/consults">Consults</a>` (place after Services or before Contact — match existing order site-wide).
2. `.mobile-nav`: add the same `<a href="/consults">Consults</a>`.
3. Header `.head-cta` primary button + the mobile-nav primary button: change label/href from `Start a project` (mailto) to **`Book a consult`** → `href="/consults"` (keep the `<span class="dot"></span>` and `.btn-primary` classes). Footer "Company" `<ul>`: add `<li><a href="/consults">Consults</a></li>`.
On `consults.html`/`consults/confirmed.html`, ensure the Consults nav item carries `aria-current="page"`.

- [ ] **Step 5: Verify pages locally**

Local-serve; on each page confirm the header CTA now reads "Book a consult" and links to `/consults`, the nav shows Consults, and no layout breaks on mobile width (≤960px) — the mobile menu shows the new item.

- [ ] **Step 6: Merge to main and deploy**

```bash
cd /c/Users/forre/Source/nlma.io
git add index.html about.html services.html portfolio.html referrals.html contact.html resume.html consults.html consults/confirmed.html
git commit -m "feat(consults): site-wide Book-a-consult CTA + /consults nav"
git checkout main && git merge --no-ff feat/consult-scheduling -m "feat: consult scheduling"
git push origin main
```
Then confirm the VPS pulled (git-pull cron/reconciler) or trigger it per the deploy pattern; verify the working tree on the VPS updated.

- [ ] **Step 7: Verify live (still Stripe TEST)**

Open `https://nlma.io/consults`. Confirm the page loads over the real CSP, intake works (real triage + slots), and there are **no CSP violations** in the browser console for the fetch to n8n or the Stripe redirect.

---

## Task 6: Go live (switch Stripe to live keys) + final verification

- [ ] **Step 1: Swap in NLMA LIVE Stripe keys**

Replace the n8n Stripe secret var and the `STRIPE_WH_SECRET` with the NLMA **live** values; add a **live** webhook endpoint in the Stripe live dashboard → `https://n8n.nlma.io/webhook/consult-paid`, event `checkout.session.completed`.

- [ ] **Step 2: Full production smoke test**

- Free path: book a real free consult end-to-end from `https://nlma.io/consults`; confirm invite + Meet link; delete the event.
- Billable path: book a real billable consult; **use a real card for the smallest slot ($112.50) or Stripe’s live-mode test**; confirm the charge in the NLMA dashboard, the event + invite, and the hold → done. Refund the real charge if it was a genuine test.

- [ ] **Step 3: Confirm anti-abuse**

- Rapid-fire >20 intake POSTs/min → nginx returns 429.
- Honeypot-filled POST → silent no-op, no Anthropic call.

- [ ] **Step 4: Final commit / notes**

```bash
git add -A && git commit -m "chore(consults): production notes" 2>/dev/null || true
```
Record the live webhook secret location and the four workflow ids in the repo `n8n/README` or the project memory.

---

## Self-Review notes (author)

- **Spec coverage:** §2 config → Global Constraints + Task 2/3/4 nodes. §3 architecture → Tasks 1–4 diagram parity. §4.1 page → Task 1. §4.2 intake → Task 2. §4.3 book → Task 3. §4.4/4.5/4.6 checkout/paid/holds → Task 4. §4.7 nginx/CSP → Task 5. §5 event data → Task 3 node 5 description. §6 triage rule → Task 2 system prompt. §7 edge cases → race guards (T3/T4), tz (T1 fmtSlot), abuse (T2 guard + T5 limit_req), idempotency (T4 paid step 4), refund (T4 paid step 5). §8 secrets → Task 4 preamble + Task 6. §9 out-of-scope → not built. §10 build order → Task order.
- **Placeholder scan:** the only lookup-not-literal items are the n8n credential IDs and webhook base URL, resolved by the explicit discovery step (Task 2 Step 1) — real lookups, not TODOs.
- **Type consistency:** intake/book/checkout body + response shapes match between Task 1 (mock contract) and Tasks 2–4 (implementations); `duration_min`, `startIso`, `price`, `holdId`, `slotStartISO`, `status` used consistently.
