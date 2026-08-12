/* ==========================================================================
   Split Log — Running Training Tracker
   Application logic.

   Persistence is window.storage.get/set(key, value) — a key-value async API
   injected by the host page. NOT localStorage; do not substitute it.
   Integration points: loadAll(), savePlans(), saveSettings().

   Section order:
     1. State & constants
     2. Date helpers  (always local-component based — never toISOString)
     3. Format helpers — pace & duration
     4. Persistence
     5. Plan generators
     6. Zone calculation
     7. Rendering — Today
     8. Rendering — Plan list, archive, detail, ledger, editor
     9. Rendering — Settings
    10. Rendering — Charts
    11. Events & init
   ========================================================================== */

(function(){
'use strict';

const $ = (s,el)=> (el||document).querySelector(s);
const $$ = (s,el)=> Array.from((el||document).querySelectorAll(s));

/* --------------------------------------------------------------------------
   1. State & constants
   -------------------------------------------------------------------------- */

let PLANS = [];      // array of plan objects: {id, name, type, startDate, raceDate, days:{date:{...}}}
const ADHOC_ID = '__adhoc__';
// Illustrative starting values, not anyone's measurements: round numbers keyed
// to a 180 bpm all-out 5K HR. They exist so a first run has something sensible
// on screen -- set your real zones in Settings, which overwrites all of this.
const DEFAULT_ZONES = { z1:145, z2lo:146, z2hi:155, z3lo:156, z3hi:165, z4lo:166, z4hi:175, z5lo:176 };
let SETTINGS = { maxHr:null, restHr:null, vo2Log:[], manualZones:null, zoneMethod:'manual', race5kHr:null, zone2Pace:null, racePace:null, racePace10k:null };
let currentPlanId = null;
let loaded = false;

function defaultSettings(){
  return { maxHr:null, restHr:null, vo2Log:[], manualZones: DEFAULT_ZONES, zoneMethod:'5k', race5kHr:180, zone2Pace:7.0, racePace:6.0, racePace10k:null };
}

function genId(){ return 'p_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7); }

/* --------------------------------------------------------------------------
   2. Date helpers
   Always build date-only strings from local components. toISOString() converts
   to UTC and silently shifts the date back a day for UTC+ timezones.
   -------------------------------------------------------------------------- */

function toLocalISODate(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function todayStr(){ return toLocalISODate(new Date()); }
function addDays(dateStr,n){ const d=new Date(dateStr+"T00:00:00"); d.setDate(d.getDate()+n); return toLocalISODate(d); }
function fmtDate(dateStr){ const d=new Date(dateStr+"T00:00:00"); return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'}); }
function dow(dateStr){ const d=new Date(dateStr+"T00:00:00"); return d.toLocaleDateString('en-GB',{weekday:'short'}); }
function isoWeekLabel(dateStr){
  const d=new Date(dateStr+"T00:00:00");
  const first = new Date(d); first.setDate(d.getDate()-d.getDay()+1);
  return "Week of "+first.toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
}

function showToast(msg){
  const t=$("#toast"); t.textContent=msg; t.classList.add('show');
  clearTimeout(showToast._h); showToast._h=setTimeout(()=>t.classList.remove('show'),1800);
}

/* --------------------------------------------------------------------------
   3. Format helpers — pace & duration
   Both stored as decimal minutes (6.5 === 6:30).
   -------------------------------------------------------------------------- */

function fmtPace(p){
  if(p==null || isNaN(p)) return '';
  const mins = Math.floor(p);
  const secs = Math.round((p-mins)*60);
  const m = secs===60 ? mins+1 : mins;
  const s = secs===60 ? 0 : secs;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function parsePace(str){
  if(!str) return null;
  str = str.trim();
  if(str.includes(':')){
    const [m,s] = str.split(':').map(Number);
    if(isNaN(m)||isNaN(s)) return null;
    return m + s/60;
  }
  const v = parseFloat(str);
  return isNaN(v) ? null : v;
}

function fmtDuration(mins){
  if(mins==null || isNaN(mins)) return '';
  const totalSec = Math.round(mins*60);
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const s = totalSec%60;
  if(h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function parseDuration(str){
  if(!str) return null;
  str = str.trim();
  if(str.includes(':')){
    const parts = str.split(':').map(Number);
    if(parts.some(isNaN)) return null;
    if(parts.length===3) return parts[0]*60 + parts[1] + parts[2]/60;
    if(parts.length===2) return parts[0] + parts[1]/60;
    return null;
  }
  const v = parseFloat(str);
  return isNaN(v) ? null : v;
}

/* --------------------------------------------------------------------------
   4. Persistence
   -------------------------------------------------------------------------- */

function getAdhocPlan(){
  let p = PLANS.find(pl=>pl.id===ADHOC_ID);
  if(!p){ p = {id:ADHOC_ID, name:'Logged runs', type:'adhoc', startDate:null, raceDate:null, days:{}}; PLANS.push(p); }
  return p;
}

// The single lookup path for "what is on this date" — searches every plan,
// archived ones included. Don't add a parallel day store beside this.
function findDayEntry(date){
  for(const p of PLANS){ if(p.days[date]) return {plan:p, day:p.days[date]}; }
  return null;
}

async function loadAll(){
  try{
    const p = await window.storage.get('plans');
    if(p){
      PLANS = JSON.parse(p.value);
    } else {
      // migrate from the old flat 'plan-days' key if it exists
      let migrated = [];
      try{
        const old = await window.storage.get('plan-days');
        if(old){
          const days = JSON.parse(old.value);
          const dates = Object.keys(days).sort();
          if(dates.length){
            migrated.push({ id:genId(), name:'Imported plan', type:'legacy',
              startDate:dates[0], raceDate:dates[dates.length-1], days, archived:false });
          }
        }
      }catch(e){}
      PLANS = migrated;
      await savePlans();
    }
  }catch(e){ PLANS = []; }

  try{
    const s = await window.storage.get('settings');
    if(s){
      SETTINGS = JSON.parse(s.value);
      if(!SETTINGS.vo2Log) SETTINGS.vo2Log=[];
    } else {
      SETTINGS = defaultSettings();
      await saveSettings();
    }
  }catch(e){ SETTINGS = defaultSettings(); }
  loaded = true;
}

async function savePlans(){
  try{ await window.storage.set('plans', JSON.stringify(PLANS)); }
  catch(e){ showToast('Save failed — try again'); }
}
async function saveSettings(){
  try{ await window.storage.set('settings', JSON.stringify(SETTINGS)); }
  catch(e){ showToast('Save failed — try again'); }
}

/* --------------------------------------------------------------------------
   5. Plan generators — pure, return a new plan object without touching state
   -------------------------------------------------------------------------- */

function mkDay(type,title,detail,targetPace){
  return { type, title, detail, status:'planned', actual:null, targetPace: targetPace!=null ? targetPace : null };
}

function generate5kPlan(startDate, raceDate){
  const zone2Pace = SETTINGS.zone2Pace || null;
  const racePace = SETTINGS.racePace || null;
  const prep = [
    ['zone2','Zone 2 run','Easy aerobic pace, conversational effort.', zone2Pace],
    ['zone2','Zone 2 run','Easy aerobic pace, conversational effort.', zone2Pace],
    ['rest','Rest','Full rest or light cross-train.', null],
    ['hard','Intervals','5-6 x 3 min zone 4, 2-3 min jog/walk recovery.', null],
    ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
    ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
    ['rest','Rest','Full rest.', null],
    ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
    ['hard','Race-pace reps','3 x 1km at goal pace, 2-3 min jog recovery.', racePace],
    ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
    ['rest','Rest','Full rest.', null],
    ['hard','Tempo','15-20 min continuous at zone 3-4.', null],
    ['zone2','Easy zone 2','Shorter than usual, easy.', zone2Pace],
    ['rest','Rest','Full rest.', null],
    ['zone2','Easy zone 2 (taper)','~20 min, easy.', zone2Pace],
    ['hard','Tune-up reps','2 x 1km at goal pace, full recovery between.', racePace],
    ['rest','Rest','Rest or very light walk.', null],
    ['zone2','Shakeout jog','15 min easy, or full rest.', zone2Pace],
  ];
  const days = {};
  // Resample the 18-step pattern proportionally, so a 10-day gap and a 40-day
  // gap both produce a sensibly-paced block.
  const totalPrepDays = Math.max(1, Math.round((new Date(raceDate+"T00:00:00")-new Date(startDate+"T00:00:00"))/86400000));
  for(let i=0;i<totalPrepDays;i++){
    const srcIdx = Math.min(prep.length-1, Math.floor(i*prep.length/totalPrepDays));
    const p = prep[srcIdx];
    days[addDays(startDate,i)] = mkDay(p[0], p[1], p[2], p[3]);
  }
  days[raceDate] = mkDay('race', '5K Race', 'Race day. Start controlled, push the last 1-2km if you have room.', racePace);
  return { id:genId(), name:`5K — ${fmtDate(raceDate)}`, type:'5k', startDate, raceDate, days, archived:false };
}

function generate10kPlan(startDate){
  const zone2Pace = SETTINGS.zone2Pace || null;
  const racePace10k = SETTINGS.racePace10k || null;
  const days = {};
  let longRun = 5.5;
  let cursor = startDate;

  const recoveryPattern = [
    ['rest','Rest','Post-race recovery.', null],
    ['rest','Rest','Post-race recovery.', null],
    ['zone2','Easy zone 2','Short and slow.', zone2Pace],
    ['zone2','Easy zone 2','Short and slow.', zone2Pace],
    ['zone2','Easy zone 2','Short and slow.', zone2Pace],
    ['zone2','Zone 2 run','Back to normal easy volume.', zone2Pace],
    ['zone2','Zone 2 run','Back to normal easy volume.', zone2Pace],
  ];
  recoveryPattern.forEach((p,i)=> days[addDays(cursor,i)] = mkDay(p[0],p[1],p[2],p[3]));
  cursor = addDays(cursor,7);

  for(let w=0; w<5; w++){
    const ld = longRun.toFixed(1);
    const weekPattern = [
      ['rest','Rest','Full rest.', null],
      ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
      ['hard','Intervals or tempo','Keep intensity at 1 session/week — volume is the priority.', null],
      ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
      ['rest','Rest or easy cross-train','Optional light cross-train.', null],
      ['zone2','Long run', ld+'km — this is the anchor session of the week.', zone2Pace],
      ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
    ];
    weekPattern.forEach((p,i)=> days[addDays(cursor,i)] = mkDay(p[0],p[1],p[2],p[3]));
    cursor = addDays(cursor,7);
    longRun = longRun*1.10;
  }

  for(let w=0; w<2; w++){
    const ld = longRun.toFixed(1);
    const weekPattern = [
      ['rest','Rest','Full rest.', null],
      ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
      ['hard','10K goal-pace reps','4 x 1.5km at 10K goal pace, jog recovery.', racePace10k],
      ['zone2','Zone 2 run','Easy aerobic pace.', zone2Pace],
      ['rest','Rest or easy cross-train','Optional light cross-train.', null],
      ['zone2','Long run', ld+'km, most important session of the week.', zone2Pace],
      ['hard','Tempo','20-25 min continuous, comfortably hard.', null],
    ];
    weekPattern.forEach((p,i)=> days[addDays(cursor,i)] = mkDay(p[0],p[1],p[2],p[3]));
    cursor = addDays(cursor,7);
  }

  const taperPattern = [
    ['rest','Rest','Full rest.', null],
    ['zone2','Easy zone 2','Reduced volume, easy.', zone2Pace],
    ['hard','Short pace tune-up','Few reps at goal pace, full recovery, keep it light.', racePace10k],
    ['zone2','Easy zone 2','Short and easy.', zone2Pace],
    ['rest','Rest','Full rest.', null],
    ['zone2','Shakeout jog','15-20 min easy, or full rest.', zone2Pace],
    ['race','10K Race','Race day.', racePace10k],
  ];
  taperPattern.forEach((p,i)=> days[addDays(cursor,i)] = mkDay(p[0],p[1],p[2],p[3]));
  const raceDate = addDays(cursor,6);

  return { id:genId(), name:`10K — ${fmtDate(raceDate)}`, type:'10k', startDate, raceDate, days, archived:false };
}

/* --------------------------------------------------------------------------
   6. Zone calculation
   -------------------------------------------------------------------------- */

function computeZones(){
  const method = SETTINGS.zoneMethod || 'manual';

  if(method==='5k' && SETTINGS.race5kHr){
    const h = SETTINGS.race5kHr;
    const z1 = Math.round(h*0.85);
    const z2hi = Math.round(h*0.89);
    const z3hi = Math.round(h*0.94);
    const z4hi = Math.round(h*0.99);
    return [
      {n:1, lo:null, hi:z1},
      {n:2, lo:z1+1, hi:z2hi},
      {n:3, lo:z2hi+1, hi:z3hi},
      {n:4, lo:z3hi+1, hi:z4hi},
      {n:5, lo:z4hi+1, hi:null},
    ];
  }

  if(method==='manual' && SETTINGS.manualZones){
    const m = SETTINGS.manualZones;
    return [
      {n:1, lo:null, hi:m.z1},
      {n:2, lo:m.z2lo, hi:m.z2hi},
      {n:3, lo:m.z3lo, hi:m.z3hi},
      {n:4, lo:m.z4lo, hi:m.z4hi},
      {n:5, lo:m.z5lo, hi:null},
    ];
  }

  const max = SETTINGS.maxHr;
  if(!max) return null;
  const bounds = [0.50,0.60,0.70,0.80,0.90,1.0];
  const zones = [];
  for(let i=0;i<5;i++){
    zones.push({
      n:i+1,
      lo:Math.round(max*bounds[i]),
      hi:Math.round(max*bounds[i+1])
    });
  }
  return zones;
}

/* --------------------------------------------------------------------------
   7. Rendering — Today
   All renderers are full innerHTML re-renders, not incremental DOM patches.
   That means listeners must be re-attached after every render.
   -------------------------------------------------------------------------- */

function typeLabel(t){
  return {zone2:'Zone 2', hard:'Intensity', rest:'Rest', race:'Race'}[t] || t;
}

function renderToday(){
  const el = $('#view-today');
  const t = todayStr();
  const found = findDayEntry(t);
  const day = found ? found.day : null;

  // find next race across all plans
  let nextRace = null;
  PLANS.forEach(p=>{
    Object.keys(p.days).sort().forEach(d=>{
      if(p.days[d].type==='race' && d>=t && (!nextRace || d<nextRace)) nextRace = d;
    });
  });

  let countdownHtml = '';
  if(nextRace){
    const days = Math.round((new Date(nextRace)-new Date(t))/86400000);
    countdownHtml = days===0 ? 'Race day' : (days+' day'+(days===1?'':'s')+' to race');
  }

  if(!day){
    el.innerHTML = `
      <div class="bib">
        <div class="bib-top">
          <div class="bib-date">${fmtDate(t)} · ${dow(t)}</div>
          <div class="bib-countdown">${countdownHtml}</div>
        </div>
        <div class="bib-type type-none">No session planned</div>
        <div class="bib-detail">Head to the Plan tab to generate a training block, or log a run manually below.</div>
      </div>
      ${renderQuickLog(t)}
    `;
    attachQuickLog(t);
    return;
  }

  const doneBadge = day.status==='done' ? '<span class="badge status-done">Logged</span>'
                    : day.status==='skipped' ? '<span class="badge status-skipped">Skipped</span>' : '';
  const targetPaceHtml = day.targetPace!=null ? ` <span class="target-pace">Target ${fmtPace(day.targetPace)}/km</span>` : '';
  const loggedMetricsHtml = (day.status==='done' && day.actual) ? `
    <div class="metrics">
      <div><div class="metric-label">Distance</div><div class="metric-value">${day.actual.distance||'—'}km</div></div>
      <div><div class="metric-label">Duration</div><div class="metric-value">${day.actual.duration!=null?fmtDuration(day.actual.duration):'—'}</div></div>
      <div><div class="metric-label">Pace</div><div class="metric-value accent">${day.actual.pace!=null?fmtPace(day.actual.pace)+'/km':'—'}</div></div>
      ${day.actual.avgHr ? `<div><div class="metric-label">Avg HR</div><div class="metric-value">${day.actual.avgHr}bpm</div></div>` : ''}
    </div>` : '';

  el.innerHTML = `
    <div class="bib">
      <div class="bib-top">
        <div class="bib-date">${fmtDate(t)} · ${dow(t)}</div>
        <div class="bib-countdown">${countdownHtml}</div>
      </div>
      <div class="bib-type type-${day.type}">${day.title}</div>
      <div class="bib-detail">${day.detail}${targetPaceHtml} ${doneBadge}</div>
      ${loggedMetricsHtml}
      <div class="bib-actions">
        ${day.status!=='done' ? `<button class="ghost small" id="btnSkip">Mark skipped</button>` : ''}
      </div>
    </div>
    ${renderQuickLog(t, day)}
  `;
  $('#btnSkip')?.addEventListener('click', async ()=>{
    found.day.status='skipped'; await savePlans(); renderToday();
  });
  attachQuickLog(t);
}

function renderQuickLog(date, day){
  const actual = day && day.actual ? day.actual : {};
  const paceDisplay = actual.pace!=null ? fmtPace(actual.pace)+'/km' : '—';
  return `
    <div class="card">
      <h3>Log this run</h3>
      <div class="row3">
        <div class="field"><label for="qlDist">Distance (km)</label><input type="number" step="0.01" id="qlDist" value="${actual.distance||''}"></div>
        <div class="field"><label for="qlDur">Duration (min:sec)</label><input type="text" id="qlDur" value="${actual.duration!=null?fmtDuration(actual.duration):''}" placeholder="30:00"></div>
        <div class="field"><label for="qlHr">Avg HR</label><input type="number" id="qlHr" value="${actual.avgHr||''}"></div>
      </div>
      <div class="field"><label>Pace</label><div id="qlPaceDisplay" class="pace-display">${paceDisplay}</div></div>
      <div class="field"><label for="qlNotes">Notes</label><input type="text" id="qlNotes" value="${actual.notes||''}" placeholder="How it felt, terrain, weather..."></div>
      <button class="primary small" id="btnLog">Save &amp; mark done</button>
    </div>
  `;
}

function attachQuickLog(date){
  $('#qlDist')?.addEventListener('input', updateQlPaceDisplay);
  $('#qlDur')?.addEventListener('input', updateQlPaceDisplay);

  $('#btnLog')?.addEventListener('click', async ()=>{
    const btn = $('#btnLog');
    try{
      btn.disabled = true;
      const dist = parseFloat($('#qlDist').value)||0;
      const dur = parseDuration($('#qlDur').value)||0;
      const hr = parseFloat($('#qlHr').value)||null;
      const notes = $('#qlNotes').value||'';
      const pace = (dist>0 && dur>0) ? (dur/dist) : null;
      let found = findDayEntry(date);
      if(!found){
        const adhoc = getAdhocPlan();
        adhoc.days[date] = mkDay('zone2','Logged run','');
        found = { plan: adhoc, day: adhoc.days[date] };
      }
      found.day.status = 'done';
      found.day.actual = { distance:dist, duration:dur, avgHr:hr, notes, pace };

      const ok = await window.storage.set('plans', JSON.stringify(PLANS));
      if(!ok) throw new Error('storage.set returned no result');

      showToast('Run logged');
      renderToday();
      renderPlanList();
      try{ renderCharts(); }catch(chartErr){ console.error('Chart render failed (log still saved):', chartErr); }
    }catch(err){
      console.error('Failed to log run:', err);
      showToast('Could not save — '+(err.message||'try again'));
      if(btn) btn.disabled = false;
    }
  });
}

// Pace is always derived from distance + duration — there is no manual pace
// input, only these read-only displays.
function updateQlPaceDisplay(){
  const dist = parseFloat($('#qlDist').value)||0;
  const dur = parseDuration($('#qlDur').value)||0;
  const el = $('#qlPaceDisplay');
  if(el) el.textContent = (dist>0 && dur>0) ? fmtPace(dur/dist)+'/km' : '—';
}
function updateEdPaceDisplay(){
  const dist = parseFloat($('#edDist').value)||0;
  const dur = parseDuration($('#edDur').value)||0;
  const el = $('#edPaceDisplay');
  if(el) el.textContent = (dist>0 && dur>0) ? fmtPace(dur/dist)+'/km' : '—';
}

/* --------------------------------------------------------------------------
   8. Rendering — Plan list, archive, detail, ledger, editor
   -------------------------------------------------------------------------- */

function planTypeLabel(t){
  return {'5k':'5K plan','10k':'10K plan', legacy:'Imported plan', adhoc:'Logged runs'}[t] || t;
}

function renderPlanList(){
  const wrap = $('#planList');
  const real = PLANS.filter(p=> p.id!==ADHOC_ID && !p.archived);
  if(real.length===0){ wrap.innerHTML = '<div class="empty">No plan yet — generate one above.</div>'; return; }

  wrap.innerHTML = real.slice().sort((a,b)=> (a.startDate||'').localeCompare(b.startDate||'')).map(p=>{
    const dates = Object.keys(p.days);
    const done = dates.filter(d=> p.days[d].status==='done').length;
    const range = p.startDate && p.raceDate ? `${fmtDate(p.startDate)} → ${fmtDate(p.raceDate)}` : '';
    return `
      <div class="plan-card" data-planid="${p.id}">
        <div class="plan-card-main">
          <div class="plan-card-name">${p.name}</div>
          <div class="plan-card-range">${planTypeLabel(p.type)} · ${range}</div>
        </div>
        <div class="plan-card-progress"><span class="n">${done}</span>/${dates.length} logged</div>
        <button class="ghost small plan-archive-btn" data-planid="${p.id}" title="Archive plan">Archive</button>
        <div class="plan-card-chevron">›</div>
      </div>
    `;
  }).join('');

  $$('.plan-card').forEach(card=>{
    card.addEventListener('click', (e)=>{
      if(e.target.closest('.plan-archive-btn')) return;
      openPlanDetail(card.dataset.planid);
    });
  });
  $$('.plan-archive-btn').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const p = PLANS.find(pl=>pl.id===btn.dataset.planid);
      p.archived = true;
      await savePlans();
      showToast('Plan archived');
      renderPlanList();
    });
  });
}

// Deleting an archived plan is a two-step in-page confirm. The host blocks
// native confirm()/alert() silently, so destructive flows use this state
// machine instead: planId -> 0 (normal), 1 (confirm once), 2 (confirm twice).
let archiveDeleteStage = {};

function renderArchiveList(){
  const wrap = $('#archiveList');
  const archived = PLANS.filter(p=> p.id!==ADHOC_ID && p.archived);
  if(archived.length===0){ wrap.innerHTML = '<div class="empty">No archived plans.</div>'; return; }

  wrap.innerHTML = archived.slice().sort((a,b)=> (a.startDate||'').localeCompare(b.startDate||'')).map(p=>{
    const dates = Object.keys(p.days);
    const done = dates.filter(d=> p.days[d].status==='done').length;
    const range = p.startDate && p.raceDate ? `${fmtDate(p.startDate)} → ${fmtDate(p.raceDate)}` : '';
    const stage = archiveDeleteStage[p.id]||0;

    if(stage===1){
      return `
        <div class="archive-row confirming" data-planid="${p.id}">
          <div class="plan-card-main">
            <div class="plan-card-name">${p.name}</div>
            <div class="plan-card-range warn">Delete this plan? This can't be undone.</div>
          </div>
          <button class="ghost small archive-cancel-btn" data-planid="${p.id}">Cancel</button>
          <button class="small danger archive-confirm1-btn" data-planid="${p.id}">Delete</button>
        </div>
      `;
    }
    if(stage===2){
      return `
        <div class="archive-row confirming" data-planid="${p.id}">
          <div class="plan-card-main">
            <div class="plan-card-name">${p.name}</div>
            <div class="plan-card-range warn">Really sure? All ${dates.length} logged days go too, permanently.</div>
          </div>
          <button class="ghost small archive-cancel-btn" data-planid="${p.id}">Cancel</button>
          <button class="small danger-strong archive-confirm2-btn" data-planid="${p.id}">Delete forever</button>
        </div>
      `;
    }
    return `
      <div class="archive-row" data-planid="${p.id}">
        <div class="plan-card-main">
          <div class="plan-card-name">${p.name}</div>
          <div class="plan-card-range">${planTypeLabel(p.type)} · ${range} · ${done}/${dates.length} logged</div>
        </div>
        <button class="ghost small archive-unarchive-btn" data-planid="${p.id}">Unarchive</button>
        <button class="ghost small archive-delete-btn" data-planid="${p.id}">Delete</button>
      </div>
    `;
  }).join('');

  $$('.archive-unarchive-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const p = PLANS.find(pl=>pl.id===btn.dataset.planid);
      p.archived = false;
      await savePlans();
      showToast('Plan restored');
      renderArchiveList();
    });
  });
  $$('.archive-delete-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      archiveDeleteStage[btn.dataset.planid] = 1;
      renderArchiveList();
    });
  });
  $$('.archive-confirm1-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      archiveDeleteStage[btn.dataset.planid] = 2;
      renderArchiveList();
    });
  });
  $$('.archive-confirm2-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = btn.dataset.planid;
      PLANS = PLANS.filter(pl=> pl.id!==id);
      delete archiveDeleteStage[id];
      await savePlans();
      showToast('Plan deleted');
      renderArchiveList(); renderToday(); renderCharts();
    });
  });
  $$('.archive-cancel-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      delete archiveDeleteStage[btn.dataset.planid];
      renderArchiveList();
    });
  });
}

// The three Plan panels are toggled in place rather than being separate routes.
function showPlanPanel(which){
  $('#planListPanel').classList.toggle('is-hidden', which!=='list');
  $('#planDetailPanel').classList.toggle('is-hidden', which!=='detail');
  $('#planArchivePanel').classList.toggle('is-hidden', which!=='archive');
}

function openPlanDetail(planId){
  currentPlanId = planId;
  showPlanPanel('detail');
  const p = PLANS.find(pl=>pl.id===planId);
  const range = p.startDate && p.raceDate ? `${fmtDate(p.startDate)} → ${fmtDate(p.raceDate)}` : '';
  $('#planDetailHeader').innerHTML = `
    <div class="plan-detail-header">
      <div>
        <div class="plan-detail-title">${p.name}</div>
        <div class="plan-detail-range">${planTypeLabel(p.type)} · ${range}</div>
      </div>
      <button class="ghost small" id="btnArchivePlan">Archive plan</button>
    </div>
  `;
  $('#btnArchivePlan').addEventListener('click', async ()=>{
    p.archived = true;
    await savePlans();
    showToast('Plan archived');
    closePlanDetail();
  });
  renderPlanLedger(planId);
}

function closePlanDetail(){
  currentPlanId = null;
  showPlanPanel('list');
  renderPlanList();
}

function openArchive(){
  showPlanPanel('archive');
  renderArchiveList();
}

function renderPlanLedger(planId){
  const p = PLANS.find(pl=>pl.id===planId);
  const wrap = $('#ledger');
  if(!p){ wrap.innerHTML=''; return; }
  const dates = Object.keys(p.days).sort();
  if(dates.length===0){ wrap.innerHTML = '<div class="empty">No days in this plan.</div>'; return; }

  // Days already gone by collapse into "Previous runs" so the ledger opens on
  // today rather than on weeks of history. Purely date-based: a past rest day
  // needs no logging, so tidying it away loses nothing.
  const today = todayStr();
  const past = dates.filter(d=> d < today);
  const upcoming = dates.filter(d=> d >= today);

  // Each group starts its own week run — sharing one `lastWeek` across the
  // split would drop the first week label of the upcoming list.
  function daysHtml(list){
    let out = '';
    let lastWeek = null;
    list.forEach(d=>{
      const wl = isoWeekLabel(d);
      if(wl!==lastWeek){ out += `<div class="week-label">${wl}</div>`; lastWeek=wl; }
      const day = p.days[d];
      const isToday = d===today;
      const statusText = day.status==='done' ? 'Done' : day.status==='skipped' ? 'Skipped' : '';
      const subtitle = day.status==='done' && day.actual ?
        `${day.actual.distance||'—'}km · ${day.actual.duration!=null?fmtDuration(day.actual.duration):'—'}${day.actual.pace? ' · '+fmtPace(day.actual.pace)+'/km':''}${day.actual.avgHr? ' · '+day.actual.avgHr+'bpm':''}`
        : (day.detail||'') + (day.targetPace!=null ? ` (target ${fmtPace(day.targetPace)}/km)` : '');
      out += `
        <div class="day-row ${day.status==='done'?'done':''} ${isToday?'today':''}" data-date="${d}">
          <div class="day-date">${fmtDate(d)}<br><span class="day-dow">${dow(d)}</span></div>
          <span class="badge type-${day.type}">${typeLabel(day.type)}</span>
          <div class="day-main">
            <div class="day-title">${day.title}</div>
            <div class="day-sub">${subtitle||''}</div>
          </div>
          <div class="day-status">${statusText}</div>
        </div>
        <div class="editor-slot" data-slot="${d}"></div>
      `;
    });
    return out;
  }

  let html = '';
  if(past.length){
    html += `
      <button class="prev-runs-toggle" id="prevRunsToggle" aria-expanded="false" aria-controls="prevRuns">
        <span class="prev-runs-chevron">▸</span>
        Previous runs (${past.length})
      </button>
      <div id="prevRuns" class="is-hidden">${daysHtml(past)}</div>
    `;
  }
  html += upcoming.length ? daysHtml(upcoming)
    : '<div class="empty">Nothing left ahead — the whole plan is in the past.</div>';
  wrap.innerHTML = html;

  const toggle = $('#prevRunsToggle');
  toggle?.addEventListener('click', ()=>{
    const section = $('#prevRuns');
    const nowHidden = section.classList.toggle('is-hidden');
    toggle.setAttribute('aria-expanded', String(!nowHidden));
    toggle.classList.toggle('open', !nowHidden);
  });

  $$('.day-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      const d = row.dataset.date;
      const slot = $(`.editor-slot[data-slot="${d}"]`);
      // Opening or closing an editor drops any half-armed delete confirm, so
      // it cannot catch a later click on a different day.
      dayDeleteStage = {};
      if(slot.innerHTML){ slot.innerHTML=''; return; }
      $$('.editor-slot').forEach(s=>s.innerHTML='');
      slot.innerHTML = editorHtml(d, p.days[d]);
      attachEditor(planId, d);
    });
  });
}

function editorHtml(date, day){
  const a = day.actual || {};
  return `
    <div class="editor">
      <div class="row">
        <div class="field">
          <label for="edType">Session type</label>
          <select id="edType">
            <option value="zone2" ${day.type==='zone2'?'selected':''}>Zone 2</option>
            <option value="hard" ${day.type==='hard'?'selected':''}>Intensity</option>
            <option value="rest" ${day.type==='rest'?'selected':''}>Rest</option>
            <option value="race" ${day.type==='race'?'selected':''}>Race</option>
          </select>
        </div>
        <div class="field"><label for="edTitle">Title</label><input type="text" id="edTitle" value="${day.title||''}"></div>
      </div>
      <div class="row">
        <div class="field"><label for="edDetail">Detail</label><input type="text" id="edDetail" value="${day.detail||''}"></div>
        <div class="field"><label for="edTargetPace">Target pace (min/km)</label><input type="text" id="edTargetPace" value="${day.targetPace!=null?fmtPace(day.targetPace):''}" placeholder="6:00"></div>
      </div>
      <div class="row3">
        <div class="field"><label for="edDist">Distance (km)</label><input type="number" step="0.01" id="edDist" value="${a.distance||''}"></div>
        <div class="field"><label for="edDur">Duration (min:sec)</label><input type="text" id="edDur" value="${a.duration!=null?fmtDuration(a.duration):''}" placeholder="30:00"></div>
        <div class="field"><label for="edHr">Avg HR</label><input type="number" id="edHr" value="${a.avgHr||''}"></div>
      </div>
      <div class="field"><label>Pace</label><div id="edPaceDisplay" class="pace-display">${a.pace!=null?fmtPace(a.pace)+'/km':'—'}</div></div>
      <div class="field"><label for="edNotes">Notes</label><input type="text" id="edNotes" value="${a.notes||''}"></div>
      ${editorActionsHtml(date, day)}
    </div>
  `;
}

// Deleting a day asks first. confirm() is silently swallowed by the sandboxed
// host (gotcha #2), so this is an in-page state machine keyed by date, the
// same shape as archiveDeleteStage. One stage, not the archive's two — a
// single day is a smaller loss than a whole plan.
let dayDeleteStage = {};

// Only a day that actually carries a logged run can be cleared.
function dayIsLogged(day){
  return day.status==='done' || day.actual!=null;
}

function editorActionsHtml(date, day){
  if(dayDeleteStage[date]){
    return `
      <div class="close-row confirming">
        <div class="confirm-msg warn">Delete this day from the plan? This can't be undone.</div>
        <button class="ghost small" id="edDeleteCancel">Cancel</button>
        <button class="small danger" id="edDeleteConfirm">Delete day</button>
      </div>
    `;
  }
  return `
    <div class="close-row">
      <button class="ghost small" id="edDelete">Delete day</button>
      ${dayIsLogged(day) ? '<button class="ghost small" id="edClear">Clear day</button>' : ''}
      <button class="primary small" id="edSave">Save</button>
    </div>
  `;
}

function attachEditor(planId, date){
  const p = PLANS.find(pl=>pl.id===planId);
  $('#edDist')?.addEventListener('input', updateEdPaceDisplay);
  $('#edDur')?.addEventListener('input', updateEdPaceDisplay);

  $('#edSave')?.addEventListener('click', async ()=>{
    const btn = $('#edSave');
    try{
      btn.disabled = true;
      const dist = parseFloat($('#edDist').value)||0;
      const dur = parseDuration($('#edDur').value)||0;
      const hr = parseFloat($('#edHr').value)||null;
      const hasActual = dist>0 || dur>0;
      const pace = (dist>0&&dur>0)?(dur/dist):null;
      p.days[date] = {
        type: $('#edType').value,
        title: $('#edTitle').value,
        detail: $('#edDetail').value,
        targetPace: parsePace($('#edTargetPace').value),
        status: hasActual ? 'done' : (p.days[date].status==='skipped'?'skipped':'planned'),
        actual: hasActual ? { distance:dist, duration:dur, avgHr:hr, notes:$('#edNotes').value, pace } : null
      };
      const ok = await window.storage.set('plans', JSON.stringify(PLANS));
      if(!ok) throw new Error('storage.set returned no result');
      showToast('Saved');
      renderPlanLedger(planId); renderToday();
      try{ renderCharts(); }catch(chartErr){ console.error('Chart render failed (save still succeeded):', chartErr); }
    }catch(err){
      console.error('Failed to save day:', err);
      showToast('Could not save — '+(err.message||'try again'));
      btn.disabled = false;
    }
  });
  // Re-render only the button row, so arming or cancelling the confirm cannot
  // discard whatever is typed in the editor's fields. Rebuilding the whole
  // editor here would look tidier and would silently throw that input away.
  function refreshEditorActions(){
    const row = $('.editor .close-row');
    if(!row) return;
    row.outerHTML = editorActionsHtml(date, p.days[date]);
    attachEditorActions();
  }

  function attachEditorActions(){
    $('#edDelete')?.addEventListener('click', ()=>{
      dayDeleteStage[date] = 1;
      refreshEditorActions();
    });
    $('#edDeleteCancel')?.addEventListener('click', ()=>{
      delete dayDeleteStage[date];
      refreshEditorActions();
    });

    $('#edDeleteConfirm')?.addEventListener('click', async ()=>{
      const btn = $('#edDeleteConfirm');
      const removed = p.days[date];
      try{
        btn.disabled = true;
        delete p.days[date];
        const ok = await window.storage.set('plans', JSON.stringify(PLANS));
        if(!ok) throw new Error('storage.set returned no result');
      }catch(err){
        // The write never landed — put the day back so memory matches storage.
        p.days[date] = removed;
        console.error('Failed to delete day:', err);
        showToast('Could not delete — '+(err.message||'try again'));
        if(btn) btn.disabled = false;
        return;
      }
      delete dayDeleteStage[date];
      showToast('Day removed');
      renderPlanLedger(planId); renderToday();
      try{ renderCharts(); }catch(chartErr){ console.error('Chart render failed (delete still succeeded):', chartErr); }
    });

    // Clearing keeps the planned session (type, title, detail, target pace)
    // and drops only the logged run — the non-destructive counterpart to
    // deleting the day outright.
    $('#edClear')?.addEventListener('click', async ()=>{
      const btn = $('#edClear');
      const prevActual = p.days[date].actual;
      const prevStatus = p.days[date].status;
      try{
        btn.disabled = true;
        p.days[date].actual = null;
        p.days[date].status = 'planned';
        const ok = await window.storage.set('plans', JSON.stringify(PLANS));
        if(!ok) throw new Error('storage.set returned no result');
      }catch(err){
        p.days[date].actual = prevActual;
        p.days[date].status = prevStatus;
        console.error('Failed to clear day:', err);
        showToast('Could not clear — '+(err.message||'try again'));
        if(btn) btn.disabled = false;
        return;
      }
      showToast('Day cleared');
      renderPlanLedger(planId); renderToday();
      try{ renderCharts(); }catch(chartErr){ console.error('Chart render failed (clear still succeeded):', chartErr); }
    });
  }

  attachEditorActions();
}

/* --------------------------------------------------------------------------
   9. Rendering — Settings
   -------------------------------------------------------------------------- */

function renderSettings(){
  $('#maxHrInput').value = SETTINGS.maxHr||'';
  $('#restHrInput').value = SETTINGS.restHr||'';
  $('#race5kHrInput').value = SETTINGS.race5kHr||'';
  $('#zoneMethodSelect').value = SETTINGS.zoneMethod||'manual';
  const method = SETTINGS.zoneMethod || 'manual';
  $('#methodManual').classList.toggle('is-hidden', method!=='manual');
  $('#method5k').classList.toggle('is-hidden', method!=='5k');
  $('#methodMaxhr').classList.toggle('is-hidden', method!=='maxhr');

  $('#paceZone2Input').value = SETTINGS.zone2Pace!=null ? fmtPace(SETTINGS.zone2Pace) : '';
  $('#pace5kInput').value = SETTINGS.racePace!=null ? fmtPace(SETTINGS.racePace) : '';
  $('#pace10kInput').value = SETTINGS.racePace10k!=null ? fmtPace(SETTINGS.racePace10k) : '';

  const zones = computeZones();
  const grid = $('#zoneGrid');
  if(!zones){ grid.innerHTML = '<div class="zone-empty">Fill in the fields above to see zone ranges.</div>'; }
  else{
    grid.innerHTML = zones.map(z=>{
      const label = z.lo==null ? '<'+z.hi : z.hi==null ? z.lo+'+' : z.lo+'-'+z.hi;
      return `
      <div class="zone-cell">
        <div class="zn">Z${z.n}</div>
        <div class="zr">${label}</div>
      </div>
    `;}).join('');
  }
  if(SETTINGS.manualZones){
    const m = SETTINGS.manualZones;
    $('#mzZ1').value = m.z1??''; $('#mzZ2lo').value = m.z2lo??''; $('#mzZ2hi').value = m.z2hi??'';
    $('#mzZ3lo').value = m.z3lo??''; $('#mzZ3hi').value = m.z3hi??''; $('#mzZ4lo').value = m.z4lo??'';
    $('#mzZ4hi').value = m.z4hi??''; $('#mzZ5lo').value = m.z5lo??'';
  }
  const log = SETTINGS.vo2Log.slice().sort((a,b)=> a.date<b.date?1:-1);
  $('#vo2Log').innerHTML = log.length ? log.map((v)=>{
    const realIdx = SETTINGS.vo2Log.indexOf(v);
    return `<div class="vo2-log-row"><span>${fmtDate(v.date)}</span><span>${v.value}</span><button class="ghost small icon" data-vo2idx="${realIdx}">Delete</button></div>`;
  }).join('') : '<div class="hint">No entries yet.</div>';
  $$('[data-vo2idx]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      SETTINGS.vo2Log.splice(parseInt(btn.dataset.vo2idx),1);
      await saveSettings();
      showToast('Entry deleted');
      renderSettings();
    });
  });
}

/* --------------------------------------------------------------------------
   10. Rendering — Charts
   -------------------------------------------------------------------------- */

let chartPace, chartVo2, chartVolume;

// Colours here mirror the CSS custom properties — Chart.js can't read them
// from the stylesheet, so keep the two in sync if the theme changes.
const CHART_COLORS = { z2:'#c9e86a', gold:'#e7b84e', hard:'#ff6d47', muted:'#8ea79b', grid:'#2c4036' };

function renderCharts(){
  // Chart.js loads from a CDN; bail out quietly if it hasn't arrived yet.
  if(typeof Chart === 'undefined'){ console.warn('Chart.js not loaded yet, skipping chart render'); return; }
  const allDays = {};
  PLANS.forEach(p=> Object.keys(p.days).forEach(d=>{ allDays[d] = p.days[d]; }));

  const paceEntries = Object.keys(allDays)
    .filter(d=> allDays[d].type==='zone2' && allDays[d].status==='done' && allDays[d].actual && allDays[d].actual.pace)
    .sort()
    .map(d=> ({x:d, y:+allDays[d].actual.pace.toFixed(2)}));

  const vo2Entries = SETTINGS.vo2Log.slice().sort((a,b)=> a.date<b.date?-1:1)
    .map(v=>({x:v.date,y:v.value}));

  // weekly volume
  const volByWeek = {};
  Object.keys(allDays).filter(d=> allDays[d].status==='done' && allDays[d].actual && allDays[d].actual.distance).forEach(d=>{
    const wl = isoWeekLabel(d);
    volByWeek[wl] = (volByWeek[wl]||0) + allDays[d].actual.distance;
  });
  const volLabels = Object.keys(volByWeek).sort();
  const volData = volLabels.map(l=> +volByWeek[l].toFixed(1));

  const commonOpts = (yLabel)=>({
    responsive:true, maintainAspectRatio:false,
    plugins:{legend:{display:false}},
    scales:{
      x:{ticks:{color:CHART_COLORS.muted,font:{family:'IBM Plex Mono',size:10}},grid:{color:CHART_COLORS.grid}},
      y:{ticks:{color:CHART_COLORS.muted,font:{family:'IBM Plex Mono',size:10}},grid:{color:CHART_COLORS.grid},title:{display:!!yLabel,text:yLabel,color:CHART_COLORS.muted}}
    }
  });

  if(chartPace) chartPace.destroy();
  if(chartVo2) chartVo2.destroy();
  if(chartVolume) chartVolume.destroy();

  chartPace = new Chart($('#chartPace'), {
    type:'line',
    data:{ labels: paceEntries.map(e=>fmtDate(e.x)), datasets:[{data:paceEntries.map(e=>e.y), borderColor:CHART_COLORS.z2, backgroundColor:CHART_COLORS.z2, tension:0.3, pointRadius:3}]},
    options: {
      ...commonOpts('min/km'),
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(ctx)=> fmtPace(ctx.parsed.y)+'/km' } } },
      scales:{
        ...commonOpts('min/km').scales,
        y:{ ...commonOpts('min/km').scales.y, ticks:{ ...commonOpts().scales.y.ticks, callback:(v)=>fmtPace(v) } }
      }
    }
  });
  chartVo2 = new Chart($('#chartVo2'), {
    type:'line',
    data:{ labels: vo2Entries.map(e=>fmtDate(e.x)), datasets:[{data:vo2Entries.map(e=>e.y), borderColor:CHART_COLORS.gold, backgroundColor:CHART_COLORS.gold, tension:0.3, pointRadius:3}]},
    options: commonOpts('VO2max')
  });
  chartVolume = new Chart($('#chartVolume'), {
    type:'bar',
    data:{ labels: volLabels, datasets:[{data:volData, backgroundColor:CHART_COLORS.hard}]},
    options: commonOpts('km')
  });
}

/* --------------------------------------------------------------------------
   11. Events & init
   -------------------------------------------------------------------------- */

// Switching to the Plan tab always resets to the plan list. Do not "remember"
// the last open plan detail — that made the tab look permanently stuck.
function switchView(name){
  $$('.tab').forEach(t=> t.classList.toggle('active', t.dataset.view===name));
  $$('.view').forEach(v=> v.classList.toggle('active', v.id==='view-'+name));
  if(name==='trends') renderCharts();
  if(name==='settings') renderSettings();
  if(name==='plan') closePlanDetail();
  if(name==='today') renderToday();
}

function bindEvents(){
  $$('.tab').forEach(t=> t.addEventListener('click', ()=> switchView(t.dataset.view)));

  $('#btnBackToPlans').addEventListener('click', closePlanDetail);
  $('#btnShowArchive').addEventListener('click', openArchive);
  $('#btnBackFromArchive').addEventListener('click', closePlanDetail);

  $('#btnGen5k').addEventListener('click', async ()=>{
    const sd = $('#fivekStartInput').value;
    const rd = $('#raceDateInput').value;
    if(!sd || !rd){ showToast('Pick a start date and race date'); return; }
    if(sd > rd){ showToast('Start date must be before race date'); return; }
    const plan = generate5kPlan(sd, rd);
    PLANS.push(plan);
    await savePlans();
    showToast('5K plan generated');
    renderToday(); renderCharts();
    closePlanDetail();
    switchView('plan');
  });

  $('#btnGen10k').addEventListener('click', async ()=>{
    const sd = $('#tenkStartInput').value;
    if(!sd){ showToast('Pick a start date first'); return; }
    const plan = generate10kPlan(sd);
    PLANS.push(plan);
    await savePlans();
    showToast('10K plan generated');
    renderToday(); renderCharts();
    closePlanDetail();
    switchView('plan');
  });

  $('#zoneMethodSelect').addEventListener('change', async (e)=>{
    SETTINGS.zoneMethod = e.target.value;
    await saveSettings();
    renderSettings();
  });

  $('#btnSaveManualZones').addEventListener('click', async ()=>{
    SETTINGS.manualZones = {
      z1: parseFloat($('#mzZ1').value)||null,
      z2lo: parseFloat($('#mzZ2lo').value)||null,
      z2hi: parseFloat($('#mzZ2hi').value)||null,
      z3lo: parseFloat($('#mzZ3lo').value)||null,
      z3hi: parseFloat($('#mzZ3hi').value)||null,
      z4lo: parseFloat($('#mzZ4lo').value)||null,
      z4hi: parseFloat($('#mzZ4hi').value)||null,
      z5lo: parseFloat($('#mzZ5lo').value)||null,
    };
    SETTINGS.zoneMethod = 'manual';
    await saveSettings();
    showToast('Zone ranges saved');
    renderSettings();
  });

  $('#btnSave5kZones').addEventListener('click', async ()=>{
    const h = parseFloat($('#race5kHrInput').value);
    if(!h){ showToast('Enter your all-out 5K avg HR'); return; }
    SETTINGS.race5kHr = h;
    SETTINGS.zoneMethod = '5k';
    await saveSettings();
    showToast('Zones saved');
    renderSettings();
  });

  $('#btnSaveHr').addEventListener('click', async ()=>{
    SETTINGS.maxHr = parseFloat($('#maxHrInput').value)||null;
    SETTINGS.restHr = parseFloat($('#restHrInput').value)||null;
    SETTINGS.zoneMethod = 'maxhr';
    await saveSettings();
    showToast('Saved');
    renderSettings();
  });

  $('#btnSavePaces').addEventListener('click', async ()=>{
    SETTINGS.zone2Pace = parsePace($('#paceZone2Input').value);
    SETTINGS.racePace = parsePace($('#pace5kInput').value);
    SETTINGS.racePace10k = parsePace($('#pace10kInput').value);
    await saveSettings();
    showToast('Pace targets saved');
    renderSettings();
  });

  $('#btnAddVo2').addEventListener('click', async ()=>{
    const date = $('#vo2DateInput').value || todayStr();
    const value = parseFloat($('#vo2ValueInput').value);
    if(!value){ showToast('Enter a VO2max value'); return; }
    SETTINGS.vo2Log.push({date, value});
    await saveSettings();
    showToast('VO2max logged');
    $('#vo2ValueInput').value='';
    renderSettings();
  });
}

async function init(){
  bindEvents();
  await loadAll();
  $('#fivekStartInput').value = todayStr();
  $('#raceDateInput').value = addDays(todayStr(), 19);
  $('#tenkStartInput').value = addDays(todayStr(), 25);
  $('#vo2DateInput').value = todayStr();
  renderToday();
  renderPlanList();
  renderSettings();
}

// The script is deferred, so the DOM may already be parsed by the time it runs.
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
