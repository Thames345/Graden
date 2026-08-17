/* ===================================================================
   สวนอัจฉริยะ — App Logic (vanilla JS, no build step, offline-first)
   Persistence: localStorage only. All data stays on this device.
   =================================================================== */

"use strict";

/* ============================== STORAGE ============================== */
const STORE_KEY = "sag_v1";

function defaultState(){
  return {
    meta:{ onboarded:false, createdAt: Date.now(), version:1 },
    user:{ name:"", role:"" },
    garden:{ name:"", lat:null, lng:null, area:"", areaUnit:"ไร่", startYear:"" },
    plots:[],
    products:[],   // {id,name,type:'fertilizer'|'spray'|'other'}
    buyers:[],     // {id,name,phone,note}
    careEvents:[], // {id,date,plotId,type,items:[{name,qty,unitCost}],otherCost,totalCost,note}
    healthIssues:[], // {id,date,plotId,issueType,description,severity,affectedTreeCountEst,status,resolvedDate}
    harvests:[],   // {id,date,plotId,fruitType,weightKg,count,pricePerKg,buyerId,laborCost,fuelCost,note}
    tasks:[],      // {id,title,plotId,type,dueDate,recurrenceDays,done,doneDate}
    settings:{ notifEnabled:false, lastNotifDate:null },
    weatherCache:null, // {fetchedAt, current:{}, daily:{}}
    tombstones:[],     // {table,id,updated_at,dirty} — deletes waiting to sync
    cloud:{ gardenId:'', lastPull:'', lastSyncAt:'' } // connection details live in code, not here
  };
}

let STATE = null;

function loadState(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) { STATE = defaultState(); return STATE; }
    const parsed = JSON.parse(raw);
    STATE = Object.assign(defaultState(), parsed);
    // shallow-merge nested defaults for forward compatibility
    STATE.meta = Object.assign(defaultState().meta, parsed.meta||{});
    STATE.user = Object.assign(defaultState().user, parsed.user||{});
    STATE.garden = Object.assign(defaultState().garden, parsed.garden||{});
    STATE.settings = Object.assign(defaultState().settings, parsed.settings||{});
    STATE.cloud = Object.assign(defaultState().cloud, parsed.cloud||{});
    STATE.tombstones = Array.isArray(parsed.tombstones)? parsed.tombstones : [];
  }catch(e){
    console.error("load error", e);
    STATE = defaultState();
  }
  return STATE;
}

function saveState(){
  // Synchronous write — callers (e.g. finishWizard) may immediately re-render
  // from STATE right after saving, so the store must never lag behind memory.
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(STATE)); }
  catch(e){ console.error("save error", e); toast("บันทึกข้อมูลไม่สำเร็จ (พื้นที่จัดเก็บเต็ม?)"); }
  if(typeof scheduleSync === 'function') scheduleSync();
}

function uid(){
  if(window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,10);
}

/* Sync bookkeeping. Every local write stamps updated_at and marks the row dirty
   so the cloud layer knows what still needs pushing; deletes leave a tombstone
   behind so the delete can travel to other devices too. */
function touch(obj){
  obj.updated_at = new Date().toISOString();
  obj.dirty = true;
  return obj;
}
function tombstone(table, id){
  STATE.tombstones = STATE.tombstones || [];
  const existing = STATE.tombstones.find(t=>t.table===table && t.id===id);
  if(existing){ existing.updated_at = new Date().toISOString(); existing.dirty = true; return existing; }
  const t = { table, id, updated_at:new Date().toISOString(), dirty:true };
  STATE.tombstones.push(t);
  return t;
}

/* ============================== UTILS ============================== */
const THAI_MONTHS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
const THAI_DOW = ["อา","จ","อ","พ","พฤ","ศ","ส"];

function todayISO(){ return new Date().toISOString().slice(0,10); }
function fmtDate(iso){
  if(!iso) return "-";
  const d = new Date(iso+"T00:00:00");
  if(isNaN(d)) return iso;
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear()+543}`;
}
function fmtDateShort(iso){
  const d = new Date(iso+"T00:00:00");
  if(isNaN(d)) return iso;
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]}`;
}
function daysBetween(iso1, iso2){
  const a = new Date(iso1+"T00:00:00"), b = new Date(iso2+"T00:00:00");
  return Math.round((b-a)/86400000);
}
function fmtMoney(n){
  n = Number(n)||0;
  return n.toLocaleString('th-TH',{minimumFractionDigits:0, maximumFractionDigits:0});
}
function fmtNum(n){
  n = Number(n)||0;
  return n.toLocaleString('th-TH',{maximumFractionDigits:1});
}

let toastTimer=null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove('show'), 2400);
}

/* In-app confirm card. Replaces window.confirm(), which renders as a browser
   chrome dialog showing the raw host ("127.0.0.1:5500 says") and looks nothing
   like the app. Returns a Promise<boolean>. */
function confirmDialog(opts){
  opts = opts || {};
  const danger = opts.danger !== false;
  return new Promise(resolve=>{
    const root = document.getElementById('confirmRoot');
    if(!root){ resolve(true); return; }
    root.innerHTML = `
      <div class="cdlg-back"></div>
      <div class="cdlg-card" role="alertdialog" aria-modal="true">
        <div class="cdlg-icon ${danger?'danger':'info'}">
          ${danger
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>`}
        </div>
        <div class="cdlg-title">${escapeHtml(opts.title||'ยืนยันการทำรายการ')}</div>
        ${opts.message?`<div class="cdlg-msg">${escapeHtml(opts.message)}</div>`:'<div style="height:8px"></div>'}
        <div class="cdlg-actions">
          <button class="btn btn-ghost btn-block" id="cdlgCancel">${escapeHtml(opts.cancelText||'ยกเลิก')}</button>
          <button class="btn ${danger?'btn-danger':'btn-primary'} btn-block" id="cdlgOk">${escapeHtml(opts.confirmText||'ลบ')}</button>
        </div>
      </div>`;
    root.classList.add('open');

    function close(v){
      root.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(()=>{ if(!root.classList.contains('open')) root.innerHTML=''; }, 220);
      resolve(v);
    }
    function onKey(e){
      if(e.key==='Escape') close(false);
      // Enter must not fire a destructive action — a stray keypress shouldn't
      // be able to delete a plot. It only confirms the harmless variants.
      if(e.key==='Enter' && !danger) close(true);
    }
    root.querySelector('.cdlg-back').addEventListener('click', ()=>close(false));
    document.getElementById('cdlgCancel').addEventListener('click', ()=>close(false));
    document.getElementById('cdlgOk').addEventListener('click', ()=>close(true));
    document.addEventListener('keydown', onKey);
    // focus lands on the safe choice for destructive prompts
    setTimeout(()=>{
      const b = document.getElementById(danger ? 'cdlgCancel' : 'cdlgOk');
      if(b && b.focus) b.focus();
    }, 60);
  });
}

function escapeHtml(s){
  return String(s==null?"":s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function plotById(id){ return STATE.plots.find(p=>p.id===id); }
function buyerById(id){ return STATE.buyers.find(b=>b.id===id); }

function plotHealthStatus(plotId){
  const open = STATE.healthIssues.filter(h=>h.plotId===plotId && h.status==='open');
  if(open.some(h=>h.severity==='urgent')) return 'urgent';
  if(open.length) return 'watch';
  return 'ok';
}

/* generic overlay/sheet helpers */
function openOverlay(){ document.getElementById('overlay').classList.add('open'); }
function closeOverlay(){ document.getElementById('overlay').classList.remove('open'); document.querySelectorAll('.sheet.open').forEach(s=>s.classList.remove('open')); }
document.addEventListener('DOMContentLoaded', ()=>{
  const ov = document.getElementById('overlay');
  if(ov) ov.addEventListener('click', closeOverlay);
});

function openSheet(id){
  document.getElementById(id).classList.add('open');
  openOverlay();
}
function closeSheet(id){
  document.getElementById(id).classList.remove('open');
  closeOverlay();
}

window.__SAG = { loadState, saveState, get STATE(){ return STATE; }, uid, toast, fmtDate, fmtDateShort, fmtMoney, fmtNum, todayISO, daysBetween, escapeHtml, plotById, buyerById, plotHealthStatus, openSheet, closeSheet, openOverlay, closeOverlay };

/* ============================== ICONS ============================== */
const ICONS = {
  home:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>`,
  plots:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c3 2 5 5 5 8.5A5 5 0 0 1 7 11.5C7 8 9 5 12 3Z"/><path d="M12 13v8"/></svg>`,
  calendar:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>`,
  chart:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>`,
  menu:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`,
  plus:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  spray:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9V5a2 2 0 0 1 2-2h1"/><rect x="6" y="9" width="8" height="12" rx="2"/><path d="M17 6l2-2M19 9h3M16 3l1.5-1.5"/></svg>`,
  health:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.5c0 4-8 8-8 8s-8-4-8-8a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 12.5Z"/><path d="M9 12h2l1-2 2 4 1-2h2"/></svg>`,
  harvest:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="15" r="4"/><circle cx="16" cy="9" r="4"/></svg>`,
  weather:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17.5a4 4 0 1 1 .8-7.93A5 5 0 0 1 17 11a3.5 3.5 0 0 1-1 6.5H7Z"/></svg>`,
  settings:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/></svg>`,
  buyers:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16.5 9.5A3 3 0 1 0 16 3.6"/><path d="M21 20c0-2.6-1.7-4.8-4-5.6"/></svg>`,
  back:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19l-7-7 7-7"/></svg>`,
  close:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  edit:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>`,
  pin:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/></svg>`,
  check:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  drop:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5s6.5 7.2 6.5 12A6.5 6.5 0 1 1 5.5 14.5c0-4.8 6.5-12 6.5-12Z"/></svg>`,
  arrowR:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  download:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13m0 0-4-4m4 4 4-4"/><path d="M4 19h16"/></svg>`,
  upload:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V7m0 0-4 4m4-4 4 4"/><path d="M4 20h16" transform="translate(0 0)"/></svg>`,
  bell:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`
};
window.__ICONS = ICONS;

/* ============================== COMBO (freetext-addable dropdown) ============================== */
/*
  Renders an input + suggestion list. Options come from getOptions() (array of strings).
  onPick(value) fires when user selects/confirms a value (existing or newly typed).
  Usage: mountCombo(containerEl, {placeholder, getOptions, value, onPick})
*/
function mountCombo(container, opts){
  const value = opts.value || "";
  container.classList.add('combo');
  container.innerHTML = `
    <input type="text" class="combo-input" placeholder="${escapeHtml(opts.placeholder||'พิมพ์เพื่อค้นหาหรือเพิ่มใหม่')}" value="${escapeHtml(value)}" autocomplete="off">
    <div class="combo-list"></div>
  `;
  const input = container.querySelector('.combo-input');
  const list = container.querySelector('.combo-list');

  function render(q){
    const options = opts.getOptions();
    const qq = (q||"").trim().toLowerCase();
    let matches = qq ? options.filter(o=>o.toLowerCase().includes(qq)) : options.slice(0,8);
    let html = "";
    matches.slice(0,8).forEach(m=>{
      // show which category an existing entry belongs to, so picking is unambiguous
      const meta = opts.getOptionMeta ? opts.getOptionMeta(m) : '';
      html += `<div class="combo-item" data-v="${escapeHtml(m)}">
        <span>${escapeHtml(m)}</span>${meta||''}</div>`;
    });
    const exact = options.some(o=>o.toLowerCase()===qq);
    if(qq && !exact){
      if(opts.addOptions && opts.addOptions.length){
        // adding something new asks what it is, right at the moment of adding
        html += `<div class="combo-addhead">เพิ่ม "${escapeHtml(q.trim())}" เป็น...</div>`;
        opts.addOptions.forEach(a=>{
          html += `<div class="combo-item add-new" data-v="${escapeHtml(q.trim())}" data-add="${escapeHtml(a.key)}">
            <span class="add-plus">+</span>${a.tag || escapeHtml(a.label)}</div>`;
        });
      } else {
        html += `<div class="combo-item add-new" data-v="${escapeHtml(q.trim())}">+ เพิ่ม "${escapeHtml(q.trim())}"</div>`;
      }
    }
    if(!html){ html = `<div class="combo-item" style="color:var(--text-faint)">ไม่มีตัวเลือก พิมพ์เพื่อเพิ่มใหม่</div>`; }
    list.innerHTML = html;
  }

  input.addEventListener('focus', ()=>{ render(input.value); list.classList.add('open'); });
  input.addEventListener('input', ()=>{ render(input.value); list.classList.add('open'); });
  input.addEventListener('blur', ()=>{ setTimeout(()=>list.classList.remove('open'), 180); });
  list.addEventListener('mousedown', (e)=>{
    const item = e.target.closest('.combo-item[data-v]');
    if(!item) return;
    const v = item.getAttribute('data-v');
    input.value = v;
    list.classList.remove('open');
    if(opts.onPick) opts.onPick(v, item.getAttribute('data-add') || null);
  });
  return { getValue: ()=>input.value.trim(), setValue:(v)=>{ input.value=v; } };
}
window.__mountCombo = mountCombo;

/* ============================== SIMPLE PLOT SELECT (chip group) ============================== */
function plotChipsHtml(selectedId){
  if(!STATE.plots.length) return `<div class="empty" style="padding:16px 10px">
      <div class="desc" style="margin-bottom:10px">ยังไม่มีแปลง — ต้องเพิ่มแปลงก่อนจึงจะบันทึกได้</div>
      <button class="btn btn-soft btn-sm js-add-plot" type="button">+ เพิ่มแปลงตอนนี้</button>
    </div>`;
  return `<div class="chip-group" id="plotChips">` + STATE.plots.map(p=>
    `<div class="chip ${p.id===selectedId?'active':''}" data-plot="${p.id}">${escapeHtml(p.name)}</div>`
  ).join('') + `</div>`;
}
function wirePlotChips(container, onChange){
  container.querySelectorAll('.chip[data-plot]').forEach(ch=>{
    ch.addEventListener('click', ()=>{
      container.querySelectorAll('.chip[data-plot]').forEach(c=>c.classList.remove('active'));
      ch.classList.add('active');
      onChange(ch.getAttribute('data-plot'));
    });
  });
}
window.__plotChipsHtml = plotChipsHtml;
window.__wirePlotChips = wirePlotChips;

/* Any form showing the "no plots yet" empty state offers a way straight into
   the plot form, so the user isn't left at a dead end mid-entry. */
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('.js-add-plot');
  if(!btn) return;
  closeSheet('sheetGeneric');
  setTimeout(()=>openPlotForm(), 220);
});

/* ---- care-log item helpers (an entry can hold several products) ---- */
/* Fertiliser and chemical are tracked as separate categories on each line,
   because one round routinely mixes both and the split is what the cost
   breakdown is actually asked to answer. */
const CARE_CATS = [
  { key:'fertilizer', label:'ปุ๋ย',  product:'fertilize', color:'#2F6BFF' },
  { key:'pesticide',  label:'ยา',    product:'spray',     color:'#8B5CF6' },
  { key:'other',      label:'อื่นๆ', product:'other',     color:'#7A8AA8' }
];
function catTagHtml(key){
  const c = catByKey(key);
  return `<span class="cat-tag cat-${c.key}">${c.label}</span>`;
}
function catByKey(k){ return CARE_CATS.find(c=>c.key===k) || CARE_CATS[2]; }
function catFromProductType(t){
  const c = CARE_CATS.find(x=>x.product===t);
  return c ? c.key : 'other';
}
/* The category is a property of the product, set once in Settings — so the
   registry wins. Fixing a mis-filed product there also fixes past reports.
   Falls back to whatever the entry stored, then to the work type for records
   made before categories existed. */
function itemCategoryOf(item, ev){
  if(item && item.name){
    const known = productCategory(item.name);
    if(known) return known;
  }
  if(item && item.cat) return item.cat;
  if(ev && ev.type==='fertilize') return 'fertilizer';
  if(ev && ev.type==='spray') return 'pesticide';
  return 'other';
}
function productCategory(name){
  const p = STATE.products.find(x=>x.name===name);
  return p ? catFromProductType(p.type) : null;
}

function careItemsOf(ev){
  if(Array.isArray(ev.items) && ev.items.length) return ev.items;
  if(ev.productName || ev.qtyBottles || ev.unitCost){
    return [{ name: ev.productName||'', qty: Number(ev.qtyBottles)||0, unitCost: Number(ev.unitCost)||0 }];
  }
  return [];
}
function careItemsSummary(ev){
  const items = careItemsOf(ev).filter(i=>i.name);
  if(!items.length) return '';
  if(items.length===1) return items[0].name;
  return `${items[0].name} +อีก ${items.length-1} รายการ`;
}
/* e.g. "ปุ๋ย 2 · ยา 1" — a quick read of what the round consisted of */
function careCatCounts(ev){
  const counts = {};
  careItemsOf(ev).filter(i=>i.name).forEach(i=>{
    const k = itemCategoryOf(i, ev);
    counts[k] = (counts[k]||0) + 1;
  });
  return counts;
}
function careCatSummary(ev){
  const counts = careCatCounts(ev);
  return CARE_CATS.filter(c=>counts[c.key])
    .map(c=>`${c.label} ${counts[c.key]}`).join(' · ');
}
/* coloured version for lists */
function careCatTags(ev){
  const counts = careCatCounts(ev);
  return CARE_CATS.filter(c=>counts[c.key])
    .map(c=>`<span class="cat-tag cat-${c.key}">${c.label} ${counts[c.key]}</span>`).join('');
}

/* Cost split by category for a period, used by the analysis breakdown. */
function categoryCostTotals(matchFn){
  const t = { fertilizer:0, pesticide:0, other:0, labor:0, fuel:0 };
  STATE.careEvents.filter(e=>matchFn(e.date)).forEach(e=>{
    let itemsSum = 0;
    careItemsOf(e).forEach(it=>{
      const cost = (Number(it.qty)||0) * (Number(it.unitCost)||0);
      t[itemCategoryOf(it, e)] += cost;
      itemsSum += cost;
    });
    // otherCost, plus anything a legacy entry recorded only as a total
    const rest = (Number(e.totalCost)||0) - itemsSum;
    if(rest > 0) t.other += rest;
  });
  STATE.harvests.filter(h=>matchFn(h.date)).forEach(h=>{
    t.labor += Number(h.laborCost)||0;
    t.fuel  += Number(h.fuelCost)||0;
  });
  return t;
}

/* ============================== ROUTER ============================== */
const VIEWS = ['dashboard','plots','calendar','analysis','menu','plotDetail','buyers','weather','settings'];
let currentView = 'dashboard';

function updateTopbar(){
  const nameEl = document.getElementById('gardenNameTop');
  const metaEl = document.getElementById('gardenMetaTop');
  if(nameEl) nameEl.textContent = STATE.garden.name || 'สวนอัจฉริยะ';
  if(metaEl){
    const plots = STATE.plots.length;
    const trees = STATE.plots.reduce((s,p)=>s+(Number(p.treeCount)||0),0);
    metaEl.textContent = plots ? `${plots} แปลง · ${trees} ต้น` : '';
  }
}

function showView(name, opts){
  opts = opts || {};
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  const el = document.getElementById('view-'+name);
  if(el) el.classList.add('active');
  currentView = name;
  document.querySelectorAll('.nav-btn').forEach(b=>{
    b.classList.toggle('active', b.getAttribute('data-view')===name);
  });
  updateTopbar();
  window.scrollTo(0,0);
  if(window.__renderView) window.__renderView(name, opts);
}
window.__showView = showView;
window.__getCurrentView = ()=>currentView;

/* ============================== ANALYTICS HELPERS ============================== */
function monthKey(iso){ return iso.slice(0,7); }
function thisMonthKey(){ return todayISO().slice(0,7); }

function careCostOf(ev){ return Number(ev.totalCost)||0; }
function harvestRevenueOf(h){ return (Number(h.weightKg)||0) * (Number(h.pricePerKg)||0); }
function harvestCostOf(h){ return (Number(h.laborCost)||0) + (Number(h.fuelCost)||0); }

function monthStats(mk){
  const careCost = STATE.careEvents.filter(e=>monthKey(e.date)===mk).reduce((s,e)=>s+careCostOf(e),0);
  const hInMonth = STATE.harvests.filter(h=>monthKey(h.date)===mk);
  const harvestCost = hInMonth.reduce((s,h)=>s+harvestCostOf(h),0);
  const revenue = hInMonth.reduce((s,h)=>s+harvestRevenueOf(h),0);
  const totalCost = careCost + harvestCost;
  return { careCost, harvestCost, totalCost, revenue, profit: revenue-totalCost };
}

function yearStats(y){
  const inYear = (d)=> d.slice(0,4)===String(y);
  const careCost = STATE.careEvents.filter(e=>inYear(e.date)).reduce((s,e)=>s+careCostOf(e),0);
  const hInYear = STATE.harvests.filter(h=>inYear(h.date));
  const harvestCost = hInYear.reduce((s,h)=>s+harvestCostOf(h),0);
  const revenue = hInYear.reduce((s,h)=>s+harvestRevenueOf(h),0);
  const totalCost = careCost + harvestCost;
  return { careCost, harvestCost, totalCost, revenue, profit: revenue-totalCost };
}

/* ---- unit economics ----
   Turning totals into per-kilo numbers is what makes the figures usable:
   "this plot costs ฿18/kg to run and sells at ฿35" answers whether a price
   from a buyer is worth taking, which a monthly total never does. */
function economicsFor(rows, matchFn){
  const cost = STATE.careEvents
      .filter(e=>rows.includes(e.plotId) && matchFn(e.date))
      .reduce((s,e)=>s+careCostOf(e),0)
    + STATE.harvests
      .filter(h=>rows.includes(h.plotId) && matchFn(h.date))
      .reduce((s,h)=>s+harvestCostOf(h),0);
  const hs = STATE.harvests.filter(h=>rows.includes(h.plotId) && matchFn(h.date));
  const kg = hs.reduce((s,h)=>s+(Number(h.weightKg)||0),0);
  const revenue = hs.reduce((s,h)=>s+harvestRevenueOf(h),0);
  return {
    cost, revenue, kg,
    profit: revenue-cost,
    costPerKg: kg>0 ? cost/kg : null,
    pricePerKg: kg>0 ? revenue/kg : null,
    profitPerKg: kg>0 ? (revenue-cost)/kg : null,
    // at the price actually achieved, how many kilos cover the spending
    breakEvenKg: (kg>0 && revenue>0) ? cost/(revenue/kg) : null
  };
}

function plotEconomics(matchFn){
  return STATE.plots.map(p=>{
    const e = economicsFor([p.id], matchFn);
    e.plot = p;
    e.profitPerTree = (Number(p.treeCount)||0) > 0 ? e.profit/Number(p.treeCount) : null;
    return e;
  });
}

function fruitEconomics(matchFn){
  const byFruit = {};
  STATE.plots.forEach(p=>{
    const f = p.fruitType || 'ไม่ระบุชนิด';
    (byFruit[f] = byFruit[f] || []).push(p.id);
  });
  return Object.keys(byFruit).map(f=>{
    const e = economicsFor(byFruit[f], matchFn);
    e.fruit = f;
    return e;
  });
}

function last6Months(){
  const arr=[];
  const d = new Date();
  for(let i=5;i>=0;i--){
    const dd = new Date(d.getFullYear(), d.getMonth()-i, 1);
    arr.push(dd.getFullYear()+"-"+String(dd.getMonth()+1).padStart(2,'0'));
  }
  return arr;
}

function upcomingTasks(days){
  const today = todayISO();
  const limit = new Date(); limit.setDate(limit.getDate()+days);
  const limitISO = limit.toISOString().slice(0,10);
  return STATE.tasks.filter(t=>!t.done && t.dueDate <= limitISO).sort((a,b)=>a.dueDate<b.dueDate?-1:1);
}
function overdueTasks(){
  const today = todayISO();
  return STATE.tasks.filter(t=>!t.done && t.dueDate < today);
}
function dueTodayTasks(){
  const today = todayISO();
  return STATE.tasks.filter(t=>!t.done && t.dueDate === today);
}

function taskTypeMeta(type){
  const map = {
    spray:{ label:'พ่นยา', icon:ICONS.spray, cls:'tint-lavender', color:'var(--lavender-deep)'},
    fertilize:{ label:'ใส่ปุ๋ย', icon:ICONS.spray, cls:'tint-peach', color:'var(--peach-deep)'},
    water:{ label:'รดน้ำ', icon:ICONS.drop, cls:'tint-blue', color:'var(--blue-deep)'},
    other:{ label:'งานดูแล', icon:ICONS.check, cls:'tint-blue', color:'var(--blue-deep)'}
  };
  return map[type]||map.other;
}

/* ============================== SVG CHARTS (no external lib) ============================== */
function barChart(container, data, opts){
  // data: [{label, value, value2?}]  opts:{h, colorA, colorB, money}
  opts = opts||{};
  const h = opts.h||140, pad=26, barW = 22, gap = (data.length>1)? undefined:0;
  const w = Math.max(data.length * 56, 220);
  const maxV = Math.max(1, ...data.map(d=>Math.max(d.value, d.value2||0)));
  let bars = "";
  data.forEach((d,i)=>{
    const cx = pad + i*((w-pad*2)/data.length) + ((w-pad*2)/data.length)/2;
    const bh1 = (d.value/maxV) * (h-30);
    bars += `<rect x="${cx-barW/2 - (d.value2!=null?9:0)}" y="${h-20-bh1}" width="${barW*0.62}" height="${bh1}" rx="6" fill="${opts.colorA||'var(--blue)'}"></rect>`;
    if(d.value2!=null){
      const bh2 = (d.value2/maxV) * (h-30);
      bars += `<rect x="${cx+2}" y="${h-20-bh2}" width="${barW*0.62}" height="${bh2}" rx="6" fill="${opts.colorB||'var(--peach)'}"></rect>`;
    }
    bars += `<text x="${cx}" y="${h-4}" font-size="9.5" fill="var(--text-faint)" text-anchor="middle" font-family="var(--font-thai)">${escapeHtml(d.label)}</text>`;
  });
  container.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="xMidYMid meet">${bars}</svg></div>`;
}

function donutChart(container, data, opts){
  // data: [{label,value,color}]
  opts = opts||{};
  const total = data.reduce((s,d)=>s+d.value,0) || 1;
  const size = opts.size||150, r=60, cx=75, cy=75, sw=20;
  let acc = 0, segs = "";
  const circ = 2*Math.PI*r;
  if(total<=0){
    segs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}"/>`;
  } else {
    data.forEach(d=>{
      const frac = d.value/total;
      const dash = frac*circ;
      segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="${sw}" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-acc}" transform="rotate(-90 ${cx} ${cy})"/>`;
      acc += dash;
    });
  }
  const legend = data.map(d=>`<span><span class="dot" style="background:${d.color}"></span>${escapeHtml(d.label)} · ${Math.round(d.value/total*100)||0}%</span>`).join('');
  container.innerHTML = `<div class="chart-wrap center"><svg viewBox="0 0 150 150" width="${size}" height="${size}">${segs}</svg><div class="chart-legend center" style="justify-content:center">${legend}</div></div>`;
}

/* ============================== RENDER: DASHBOARD ============================== */
function renderDashboard(){
  const root = document.getElementById('view-dashboard');
  const overdue = overdueTasks(), dueToday = dueTodayTasks();
  const openHealth = STATE.healthIssues.filter(h=>h.status==='open');
  const urgentHealth = openHealth.filter(h=>h.severity==='urgent');
  const mk = thisMonthKey();
  const ms = monthStats(mk);

  let banners = "";
  if(overdue.length){
    banners += `<div class="banner urgent"><div class="b-icon">⏰</div><div><div class="b-title">มีงานค้าง ${overdue.length} รายการ</div><div class="b-desc">${overdue.slice(0,2).map(t=>escapeHtml(t.title)).join(', ')}${overdue.length>2?' และอื่นๆ':''}</div></div></div>`;
  }
  if(dueToday.length){
    banners += `<div class="banner"><div class="b-icon">🔔</div><div><div class="b-title">วันนี้มีงานต้องทำ ${dueToday.length} รายการ</div><div class="b-desc">${dueToday.slice(0,2).map(t=>escapeHtml(t.title)).join(', ')}</div></div></div>`;
  }
  if(urgentHealth.length){
    banners += `<div class="banner urgent"><div class="b-icon">🌿</div><div><div class="b-title">ต้นไม้ต้องดูแลด่วน ${urgentHealth.length} แปลง</div><div class="b-desc">ตรวจสอบในเมนู "สุขภาพต้นไม้"</div></div></div>`;
  }

  const greetName = STATE.user.name ? `สวัสดีคุณ${escapeHtml(STATE.user.name)}` : 'สวัสดี';
  // The garden name already sits in the topbar, so the dashboard leads with the
  // period the figures below actually cover instead of repeating it.
  const nowD = new Date();
  const periodLabel = `${THAI_MONTHS[nowD.getMonth()]} ${nowD.getFullYear()+543}`;

  let recent = [];
  STATE.careEvents.forEach(e=>recent.push({date:e.date, type:'care', d:e}));
  STATE.healthIssues.forEach(h=>recent.push({date:h.date, type:'health', d:h}));
  STATE.harvests.forEach(h=>recent.push({date:h.date, type:'harvest', d:h}));
  recent.sort((a,b)=> a.date<b.date?1:-1);
  recent = recent.slice(0,5);

  function recentRow(r){
    const p = plotById(r.d.plotId);
    const pname = p?p.name:'-';
    let cls='', title='', sub='', end='';
    if(r.type==='care'){
      const meta = taskTypeMeta(r.d.type);
      cls = 'hot';
      title = `${meta.label} · ${escapeHtml(pname)}`;
      sub = escapeHtml(careItemsSummary(r.d));
      end = `<div class="tl-amt">฿${fmtMoney(r.d.totalCost)}</div>`;
    } else if(r.type==='health'){
      cls = r.d.severity==='urgent' ? 'bad' : 'warn';
      title = `ปัญหา · ${escapeHtml(pname)}`;
      sub = escapeHtml(r.d.issueType||r.d.description||'');
      end = `<span class="badge ${r.d.severity==='urgent'?'badge-urgent':'badge-watch'}">${r.d.status==='open'?'ยังไม่แก้':'แก้แล้ว'}</span>`;
    } else {
      cls = 'warn';
      title = `เก็บเกี่ยว · ${escapeHtml(pname)}`;
      sub = `${fmtNum(r.d.weightKg)} กก. · ${escapeHtml(r.d.fruitType||'')}`;
      end = `<div class="tl-amt">฿${fmtMoney(harvestRevenueOf(r.d))}</div>`;
    }
    return `<div class="tl-item ${cls}" data-rec="${r.type}" data-rec-id="${r.d.id}">
      <div class="tl-rail"><span class="tl-dot"></span><span class="tl-line"></span></div>
      <div class="tl-body">
        <div style="min-width:0"><div class="tl-title">${title}</div><div class="tl-sub">${sub}</div></div>
        <div class="tl-end">${end}<div class="tl-time">${fmtDateShort(r.date)}</div></div>
      </div>
    </div>`;
  }

  // today's plan ring: share of tasks due today (or overdue) already ticked off
  const dueSet = STATE.tasks.filter(t=>t.dueDate <= todayISO());
  const doneToday = dueSet.filter(t=>t.done).length;
  const planPct = dueSet.length ? Math.round(doneToday/dueSet.length*100) : 100;
  const ringC = 2*Math.PI*34;
  const ringOffset = ringC * (1 - planPct/100);

  root.innerHTML = `
    <div style="margin-bottom:14px">
      <div class="muted">${greetName} 👋</div>
      <h2 style="font-size:19px;margin-top:2px">${periodLabel}</h2>
    </div>

    <div class="hero">
      <div class="h-left">
        <div class="h-eyebrow">แผนงานวันนี้</div>
        <div class="h-title">${dueSet.length? (planPct===100?'ทำครบแล้ว 🎉':'ยังเหลืออีก '+(dueSet.length-doneToday)+' งาน') : 'วันนี้ไม่มีงานค้าง'}</div>
        <div class="h-meta">${doneToday} จาก ${dueSet.length} งาน</div>
      </div>
      <div class="h-ring">
        <svg width="86" height="86" viewBox="0 0 86 86">
          <circle cx="43" cy="43" r="34" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="9"/>
          <circle cx="43" cy="43" r="34" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${ringC.toFixed(1)}" stroke-dashoffset="${ringOffset.toFixed(1)}"
            transform="rotate(-90 43 43)"/>
        </svg>
        <div class="pct">${planPct}%</div>
      </div>
    </div>

    ${banners}
    <div class="bento">
      <div class="card stat-card tint-blue">
        <div class="label">ต้นทุนเดือนนี้</div>
        <div class="value mono num">฿${fmtMoney(ms.totalCost)}</div>
      </div>
      <div class="card stat-card tint-peach">
        <div class="label">รายได้เดือนนี้</div>
        <div class="value mono num">฿${fmtMoney(ms.revenue)}</div>
      </div>
      <div class="card stat-card span2 ${ms.profit>=0?'tint-lavender':'tint-pink'}">
        <div class="label">กำไรสุทธิเดือนนี้</div>
        <div class="value mono num">${ms.profit>=0?'':'-'}฿${fmtMoney(Math.abs(ms.profit))}</div>
      </div>
    </div>

    <div class="section-title"><h2>ภาพรวมแปลง</h2><span class="link" data-go="plots">ดูทั้งหมด</span></div>
    <div id="dashPlotPreview" class="plot-grid"></div>

    <div class="section-title"><h2>แนวโน้ม 6 เดือน</h2></div>
    <div class="card" id="dashTrendChart"></div>
    <div class="chart-legend" style="padding:0 4px">
      <span><span class="dot" style="background:var(--blue)"></span>ต้นทุน</span>
      <span><span class="dot" style="background:var(--peach)"></span>รายได้</span>
    </div>

    <div class="section-title"><h2>กิจกรรมล่าสุด</h2></div>
    <div class="card timeline">
      ${recent.length? recent.map(recentRow).join('') : `<div class="empty"><span class="emoji">🌱</span><div class="title">ยังไม่มีกิจกรรม</div><div class="desc">แตะปุ่ม + เพื่อเริ่มบันทึกการดูแลสวน</div></div>`}
    </div>
  `;

  wireRecordRows(root);   // กิจกรรมล่าสุด rows open the record they came from

  // plot preview
  const prev = document.getElementById('dashPlotPreview');
  const plotsShow = STATE.plots.slice(0,4);
  if(!plotsShow.length){
    prev.innerHTML = `<div class="empty" style="grid-column:span 2"><span class="emoji">🌳</span><div class="title">ยังไม่มีแปลง</div><div class="desc">เพิ่มแปลงแรกของคุณได้ที่เมนู "แปลง/ต้นไม้"</div></div>`;
  } else {
    prev.innerHTML = plotsShow.map(p=>plotCardHtml(p)).join('');
    prev.querySelectorAll('.plot-card').forEach(c=>c.addEventListener('click', ()=>{
      openPlotDetail(c.getAttribute('data-id'));
    }));
  }

  // trend chart
  const months = last6Months();
  const chartData = months.map(mkk=>{
    const st = monthStats(mkk);
    const d = new Date(mkk+"-01");
    return { label: THAI_MONTHS[d.getMonth()], value: Math.round(st.totalCost), value2: Math.round(st.revenue) };
  });
  barChart(document.getElementById('dashTrendChart'), chartData, {h:150, colorA:'var(--blue)', colorB:'var(--peach)'});

  root.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click', ()=>showView(el.getAttribute('data-go'))));
}

function plotCardHtml(p){
  const status = plotHealthStatus(p.id);
  const ringCls = status==='urgent'?'plot-ring-urgent':(status==='watch'?'plot-ring-watch':'plot-ring-ok');
  const badge = status==='urgent'?'<span class="badge badge-urgent">ด่วน</span>':(status==='watch'?'<span class="badge badge-watch">เฝ้าระวัง</span>':'<span class="badge badge-ok">ปกติ</span>');
  return `<div class="plot-card" data-id="${p.id}">
    <div class="plot-leaf ${ringCls}">🌳</div>
    <div class="p-name">${escapeHtml(p.name)}</div>
    <div class="p-meta">${escapeHtml(p.fruitType||'')} · ${p.treeCount||0} ต้น</div>
    <div style="margin-top:8px">${badge}</div>
  </div>`;
}

/* ============================== RENDER: PLOTS (registry) ============================== */
function renderPlots(){
  const root = document.getElementById('view-plots');
  root.innerHTML = `
    <div class="flex-between" style="margin-bottom:14px">
      <h2 style="font-size:19px">แปลง / ต้นไม้</h2>
      <button class="btn btn-primary btn-sm" id="btnAddPlot">${ICONS.plus} เพิ่มแปลง</button>
    </div>
    <div id="plotsGrid" class="plot-grid"></div>
  `;
  const grid = document.getElementById('plotsGrid');
  if(!STATE.plots.length){
    grid.innerHTML = `<div class="empty" style="grid-column:span 2"><span class="emoji">🌳</span><div class="title">ยังไม่มีแปลง</div><div class="desc">เพิ่มแปลงแรกเพื่อเริ่มบันทึกข้อมูลสวน</div></div>`;
  } else {
    grid.innerHTML = STATE.plots.map(plotCardHtml).join('');
    grid.querySelectorAll('.plot-card').forEach(c=>c.addEventListener('click', ()=>openPlotDetail(c.getAttribute('data-id'))));
  }
  document.getElementById('btnAddPlot').addEventListener('click', ()=>openPlotForm());
}

function openPlotForm(existing){
  const isEdit = !!existing;
  const sheet = document.getElementById('sheetGeneric');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${isEdit?'แก้ไขแปลง':'เพิ่มแปลงใหม่'}</h3><button class="icon-btn" id="sgClose">${ICONS.close}</button></div>
    <div class="field"><label>ชื่อแปลง</label><input type="text" id="pfName" value="${existing?escapeHtml(existing.name):''}" placeholder="เช่น แปลงหน้าบ้าน, แปลงริมคลอง"></div>
    <div class="field"><label>ชนิดผลไม้หลัก</label><div id="pfFruitCombo"></div></div>
    <div class="field"><label>พันธุ์ (ถ้ามี)</label><input type="text" id="pfVariety" value="${existing?escapeHtml(existing.variety||''):''}" placeholder="เช่น พันธุ์น้ำดอกไม้, หมอนทอง"></div>
    <div class="row2">
      <div class="field"><label>จำนวนต้น</label><input type="number" id="pfCount" value="${existing?existing.treeCount||'':''}" placeholder="0"></div>
      <div class="field"><label>ปีที่ปลูก (พ.ศ.)</label><input type="number" id="pfYear" value="${existing?existing.plantingYear||'':''}" placeholder="เช่น 2560"></div>
    </div>
    <div class="field"><label>หมายเหตุ</label><textarea id="pfNote" placeholder="บันทึกเพิ่มเติม (ถ้ามี)">${existing?escapeHtml(existing.notes||''):''}</textarea></div>
    <div style="display:flex; gap:10px; margin-top:6px">
      ${isEdit?`<button class="btn btn-danger" id="pfDelete">${ICONS.trash}</button>`:''}
      <button class="btn btn-primary btn-block" id="pfSave">${isEdit?'บันทึกการแก้ไข':'เพิ่มแปลง'}</button>
    </div>
  `;
  const fruitOptions = ()=>{
    const s = new Set(STATE.plots.map(p=>p.fruitType).filter(Boolean));
    ['มะม่วง','ทุเรียน','เงาะ','ลำไย','มังคุด','ลองกอง'].forEach(f=>s.add(f));
    return Array.from(s);
  };
  mountCombo(document.getElementById('pfFruitCombo'), { placeholder:'เลือกหรือพิมพ์ชนิดผลไม้', value: existing?existing.fruitType||'':'', getOptions:fruitOptions });

  document.getElementById('sgClose').addEventListener('click', ()=>closeSheet('sheetGeneric'));
  document.getElementById('pfSave').addEventListener('click', ()=>{
    const name = document.getElementById('pfName').value.trim();
    if(!name){ toast('กรุณาใส่ชื่อแปลง'); return; }
    const fruitType = document.getElementById('pfFruitCombo').querySelector('.combo-input').value.trim();
    const variety = document.getElementById('pfVariety').value.trim();
    const treeCount = Number(document.getElementById('pfCount').value)||0;
    const plantingYear = document.getElementById('pfYear').value.trim();
    const notes = document.getElementById('pfNote').value.trim();
    if(isEdit){
      touch(Object.assign(existing, {name, fruitType, variety, treeCount, plantingYear, notes}));
    } else {
      STATE.plots.push(touch({ id:uid(), name, fruitType, variety, treeCount, plantingYear, notes }));
    }
    saveState(); closeSheet('sheetGeneric'); toast(isEdit?'แก้ไขแปลงแล้ว':'เพิ่มแปลงแล้ว');
    if(currentView==='plotDetail') renderPlotDetail(existing?existing.id:null);
    if(currentView==='plots') renderPlots();
    if(currentView==='dashboard') renderDashboard();
  });
  if(isEdit){
    document.getElementById('pfDelete').addEventListener('click', async ()=>{
      const ok = await confirmDialog({ title:'ลบแปลงนี้?',
        message:'บันทึกการดูแลและการเก็บเกี่ยวที่ผูกกับแปลงนี้จะยังอยู่ แต่จะไม่มีชื่อแปลงอ้างอิงแล้ว',
        confirmText:'ลบแปลง' });
      if(!ok) return;
      STATE.plots = STATE.plots.filter(p=>p.id!==existing.id); tombstone('plots', existing.id);
      saveState(); closeSheet('sheetGeneric'); toast('ลบแปลงแล้ว');
      showView('plots');
    });
  }
  openSheet('sheetGeneric');
}

/* ============================== RENDER: PLOT DETAIL ============================== */
let activePlotId = null;
let pdShowAll = { care:false, health:false, harvest:false };
function openPlotDetail(id){
  if(activePlotId !== id) pdShowAll = { care:false, health:false, harvest:false };
  activePlotId = id;
  showView('plotDetail');
}
function renderPlotDetail(id){
  id = id || activePlotId;
  const root = document.getElementById('view-plotDetail');
  const p = plotById(id);
  if(!p){ root.innerHTML = `<div class="empty"><div class="title">ไม่พบแปลงนี้</div></div>`; return; }
  const status = plotHealthStatus(p.id);
  const badge = status==='urgent'?'<span class="badge badge-urgent">ต้องดูแลด่วน</span>':(status==='watch'?'<span class="badge badge-watch">เฝ้าระวัง</span>':'<span class="badge badge-ok">สุขภาพดี</span>');

  // Lists are capped for readability, but nothing may be unreachable — every
  // capped list gets a "show all" toggle so any record can still be opened.
  const PD_CAP = 6;
  const careAll = STATE.careEvents.filter(e=>e.plotId===p.id).sort((a,b)=>a.date<b.date?1:-1);
  const healthAll = STATE.healthIssues.filter(h=>h.plotId===p.id).sort((a,b)=>a.date<b.date?1:-1);
  const harvestAll = STATE.harvests.filter(h=>h.plotId===p.id).sort((a,b)=>a.date<b.date?1:-1);
  const careHist = pdShowAll.care ? careAll : careAll.slice(0,PD_CAP);
  const healthHist = pdShowAll.health ? healthAll : healthAll.slice(0,PD_CAP);
  const harvestHist = pdShowAll.harvest ? harvestAll : harvestAll.slice(0,PD_CAP);
  const moreBtn = (key, shown, total)=> total>shown
    ? `<button class="btn btn-ghost btn-block btn-sm" data-more="${key}">ดูทั้งหมด (${total} รายการ)</button>`
    : (pdShowAll[key] && total>PD_CAP ? `<button class="btn btn-ghost btn-block btn-sm" data-more="${key}">ย่อรายการ</button>` : '');
  const totalHarvestKg = STATE.harvests.filter(h=>h.plotId===p.id).reduce((s,h)=>s+(Number(h.weightKg)||0),0);
  const totalRevenue = STATE.harvests.filter(h=>h.plotId===p.id).reduce((s,h)=>s+harvestRevenueOf(h),0);
  const totalCost = STATE.careEvents.filter(e=>e.plotId===p.id).reduce((s,e)=>s+careCostOf(e),0) + STATE.harvests.filter(h=>h.plotId===p.id).reduce((s,h)=>s+harvestCostOf(h),0);

  root.innerHTML = `
    <div class="flex-between" style="margin-bottom:6px">
      <button class="icon-btn" id="pdBack">${ICONS.back}</button>
      <button class="icon-btn" id="pdEdit">${ICONS.edit}</button>
    </div>
    <div style="margin:10px 0 16px">
      <h2 style="font-size:20px">${escapeHtml(p.name)}</h2>
      <div class="muted">${escapeHtml(p.fruitType||'')}${p.variety?(' · '+escapeHtml(p.variety)):''} · ${p.treeCount||0} ต้น${p.plantingYear?(' · ปลูก พ.ศ. '+escapeHtml(p.plantingYear)):''}</div>
      <div style="margin-top:8px">${badge}</div>
    </div>
    <div class="bento">
      <div class="card stat-card tint-blue"><div class="label">ต้นทุนสะสม</div><div class="value mono num">฿${fmtMoney(totalCost)}</div></div>
      <div class="card stat-card tint-peach"><div class="label">รายได้สะสม</div><div class="value mono num">฿${fmtMoney(totalRevenue)}</div></div>
      <div class="card stat-card span2 tint-lavender"><div class="label">ผลผลิตสะสม</div><div class="value mono num">${fmtNum(totalHarvestKg)} กก.</div></div>
    </div>
    ${p.notes? `<div class="card" style="margin-bottom:14px"><div class="muted" style="margin-bottom:4px">หมายเหตุ</div>${escapeHtml(p.notes)}</div>`:''}

    <div class="section-title"><h2>สุขภาพต้นไม้</h2><span class="link" data-add="health">+ บันทึก</span></div>
    <div class="list">
      ${healthHist.length? healthHist.map(h=>healthRowHtml(h)).join('') : `<div class="empty"><div class="desc">ยังไม่มีบันทึกปัญหาสุขภาพ</div></div>`}
      ${moreBtn('health', healthHist.length, healthAll.length)}
    </div>

    <div class="section-title"><h2>ประวัติการดูแล</h2><span class="link" data-add="care">+ บันทึก</span></div>
    <div class="list">
      ${careHist.length? careHist.map(e=>careRowHtml(e)).join('') : `<div class="empty"><div class="desc">ยังไม่มีบันทึกการดูแล</div></div>`}
      ${moreBtn('care', careHist.length, careAll.length)}
    </div>

    <div class="section-title"><h2>ประวัติการเก็บเกี่ยว</h2><span class="link" data-add="harvest">+ บันทึก</span></div>
    <div class="list">
      ${harvestHist.length? harvestHist.map(h=>harvestRowHtml(h)).join('') : `<div class="empty"><div class="desc">ยังไม่มีบันทึกการเก็บเกี่ยว</div></div>`}
      ${moreBtn('harvest', harvestHist.length, harvestAll.length)}
    </div>
  `;
  root.querySelectorAll('[data-more]').forEach(b=>b.addEventListener('click', ()=>{
    const k = b.getAttribute('data-more');
    pdShowAll[k] = !pdShowAll[k];
    renderPlotDetail(p.id);
  }));
  document.getElementById('pdBack').addEventListener('click', ()=>showView('plots'));
  document.getElementById('pdEdit').addEventListener('click', ()=>openPlotForm(p));
  root.querySelectorAll('[data-add]').forEach(el=>el.addEventListener('click', ()=>{
    const t = el.getAttribute('data-add');
    if(t==='health') openHealthForm(null, p.id);
    if(t==='care') openCareForm(null, p.id);
    if(t==='harvest') openHarvestForm(null, p.id);
  }));
  root.querySelectorAll('[data-edit-health]').forEach(el=>el.addEventListener('click', ()=>{
    const h = STATE.healthIssues.find(x=>x.id===el.getAttribute('data-edit-health'));
    openHealthForm(h);
  }));
  root.querySelectorAll('[data-edit-care]').forEach(el=>el.addEventListener('click', ()=>{
    const e = STATE.careEvents.find(x=>x.id===el.getAttribute('data-edit-care'));
    openCareForm(e);
  }));
  root.querySelectorAll('[data-edit-harvest]').forEach(el=>el.addEventListener('click', ()=>{
    const h = STATE.harvests.find(x=>x.id===el.getAttribute('data-edit-harvest'));
    openHarvestForm(h);
  }));
}

function healthRowHtml(h){
  const badge = h.status==='open' ? (h.severity==='urgent'?'badge-urgent':'badge-watch') : 'badge-ok';
  const badgeText = h.status==='open' ? (h.severity==='urgent'?'ด่วน':'เฝ้าระวัง') : 'แก้ไขแล้ว';
  return `<div class="row-card" data-edit-health="${h.id}"><div class="row-icon tint-pink" style="color:var(--pink-deep)">${ICONS.health}</div>
    <div class="row-main"><div class="row-title">${escapeHtml(h.issueType||'ปัญหาสุขภาพ')}</div><div class="row-sub">${escapeHtml(h.description||'')} ${h.affectedTreeCountEst?('· ประมาณ '+h.affectedTreeCountEst+' ต้น'):''}</div></div>
    <div class="row-end"><span class="badge ${badge}">${badgeText}</span><div class="muted" style="margin-top:4px">${fmtDateShort(h.date)}</div></div></div>`;
}
function careRowHtml(e){
  const meta = taskTypeMeta(e.type);
  const items = careItemsOf(e).filter(i=>i.name);
  const tags = careCatTags(e);
  const sub = items.length>1
    ? items.map(i=>i.name).join(', ')
    : (items.length===1 && items[0].qty ? fmtNum(items[0].qty)+' ขวด' : '');
  return `<div class="row-card" data-edit-care="${e.id}"><div class="row-icon ${meta.cls}" style="color:${meta.color}">${meta.icon}</div>
    <div class="row-main"><div class="row-title">${meta.label}${items.length===1?(' · '+escapeHtml(items[0].name)):(items.length>1?(' · '+items.length+' รายการ'):'')}</div>
      ${tags?`<div class="tag-row" style="margin-top:5px">${tags}</div>`:''}
      ${sub?`<div class="row-sub">${escapeHtml(sub)}</div>`:''}</div>
    <div class="row-end"><div class="num">฿${fmtMoney(e.totalCost)}</div><div class="muted">${fmtDateShort(e.date)}</div></div></div>`;
}
function harvestRowHtml(h){
  const rev = harvestRevenueOf(h);
  return `<div class="row-card" data-edit-harvest="${h.id}"><div class="row-icon tint-peach" style="color:var(--peach-deep)">${ICONS.harvest}</div>
    <div class="row-main"><div class="row-title">${fmtNum(h.weightKg)} กก. ${h.count?('· '+h.count+' ลูก'):''}</div><div class="row-sub">${escapeHtml(h.fruitType||'')}${h.pricePerKg?(' · ฿'+fmtMoney(h.pricePerKg)+'/กก.'):''}</div></div>
    <div class="row-end"><div class="num">฿${fmtMoney(rev)}</div><div class="muted">${fmtDateShort(h.date)}</div></div></div>`;
}

/* ============================== FORM: CARE LOG (spray/fertilize/water) ============================== */
/* One care entry can cover several products (a single spray round often mixes
   two or three), so products are entered as a repeatable list and the entry's
   total is the sum of the lines plus any other cost. */
function openCareForm(existing, presetPlotId){
  const isEdit = !!existing;
  const plotId = existing? existing.plotId : presetPlotId;
  const type = existing? existing.type : 'spray';
  let items = existing
    ? careItemsOf(existing).map(i=>({ name:i.name||'', qty:i.qty||'', unitCost:i.unitCost||'',
        cat: itemCategoryOf(i, existing) }))
    : [];
  items.forEach(it=>{ if(it.name) it.cat = productCategory(it.name) || it.cat || 'other'; });
  const defaultCat = ()=>{
    const t = sheet.querySelector('#careType .chip.active');
    const v = t ? t.getAttribute('data-t') : type;
    return v==='fertilize' ? 'fertilizer' : (v==='spray' ? 'pesticide' : 'other');
  };
  if(!items.length) items = [{name:'', qty:'', unitCost:'', cat:'other'}];

  const sheet = document.getElementById('sheetGeneric');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${isEdit?'แก้ไขบันทึกการดูแล':'บันทึกการดูแล'}</h3><button class="icon-btn" id="sgClose">${ICONS.close}</button></div>
    <div class="field"><label>ประเภทงาน</label>
      <div class="chip-group" id="careType">
        <div class="chip ${type==='spray'?'active':''}" data-t="spray">พ่นยา</div>
        <div class="chip ${type==='fertilize'?'active':''}" data-t="fertilize">ใส่ปุ๋ย</div>
        <div class="chip ${type==='water'?'active':''}" data-t="water">รดน้ำ</div>
        <div class="chip ${type==='other'?'active':''}" data-t="other">อื่นๆ</div>
      </div>
    </div>
    <div class="field"><label>แปลง</label>${plotChipsHtml(plotId)}</div>
    <div class="field"><label>วันที่</label><input type="date" id="cfDate" value="${existing?existing.date:todayISO()}"></div>

    <div class="field">
      <label>ปุ๋ย/ยาที่ใช้รอบนี้</label>
      <div id="cfItems"></div>
      <button class="btn btn-soft btn-block btn-sm" id="cfAddItem" type="button">${ICONS.plus} เพิ่มปุ๋ย/ยาอีกรายการ</button>
    </div>

    <div class="field"><label>ค่าใช้จ่ายอื่นๆ (ค่าแรง, ค่าน้ำมัน ฯลฯ)</label>
      <input type="number" id="cfOther" value="${existing&&existing.otherCost?existing.otherCost:''}" placeholder="0"></div>

    <div class="total-bar"><span class="tb-l">ค่าใช้จ่ายรวม</span><span class="tb-v" id="cfTotalPreview">฿0</span></div>

    <div class="field"><label>หมายเหตุ</label><textarea id="cfNote">${existing?escapeHtml(existing.note||''):''}</textarea></div>
    <button class="btn btn-primary btn-block" id="cfSave">${isEdit?'บันทึกการแก้ไข':'บันทึก'}</button>
    ${isEdit?`<button class="btn btn-danger btn-block" style="margin-top:8px" id="cfDelete">ลบรายการนี้</button>`:''}
  `;

  let selectedPlot = plotId;
  wirePlotChips(sheet, (v)=>{ selectedPlot=v; });
  sheet.querySelectorAll('#careType .chip').forEach(ch=>ch.addEventListener('click', ()=>{
    sheet.querySelectorAll('#careType .chip').forEach(c=>c.classList.remove('active')); ch.classList.add('active');
  }));

  const productOptions = ()=>{
    const s = new Set(STATE.products.map(p=>p.name));
    STATE.careEvents.forEach(e=>careItemsOf(e).forEach(i=>{ if(i.name) s.add(i.name); }));
    return Array.from(s);
  };

  const itemsWrap = document.getElementById('cfItems');
  const otherEl = document.getElementById('cfOther');
  const totalEl = document.getElementById('cfTotalPreview');

  function readItemsFromDOM(){
    itemsWrap.querySelectorAll('.item-row').forEach((row,i)=>{
      if(!items[i]) return;
      items[i].name = row.querySelector('.combo-input').value.trim();
      items[i].qty = row.querySelector('.ir-qty').value;
      items[i].unitCost = row.querySelector('.ir-unit').value;
      const known = productCategory(items[i].name);
      if(known) items[i].cat = known;
    });
  }
  function grandTotal(){
    let sum = 0;
    itemsWrap.querySelectorAll('.item-row').forEach(row=>{
      sum += (Number(row.querySelector('.ir-qty').value)||0) * (Number(row.querySelector('.ir-unit').value)||0);
    });
    return sum + (Number(otherEl.value)||0);
  }
  function refreshTotals(){
    itemsWrap.querySelectorAll('.item-row').forEach(row=>{
      const line = (Number(row.querySelector('.ir-qty').value)||0) * (Number(row.querySelector('.ir-unit').value)||0);
      row.querySelector('.ir-line b').textContent = '฿' + fmtMoney(line);
    });
    totalEl.textContent = '฿' + fmtMoney(grandTotal());
  }
  function renderItems(){
    itemsWrap.innerHTML = items.map((it,i)=>`
      <div class="item-row cat-edge cat-${it.cat||'other'}" data-i="${i}">
        <div class="ir-head">
          <span class="ir-num">รายการที่ ${i+1}</span>
          <span class="ir-right">
            <span class="ir-cat">${it.name ? catTagHtml(it.cat||'other') : '<span class="cat-tag cat-none">ยังไม่ได้เลือก</span>'}</span>
            ${items.length>1?`<button class="mini-remove" data-rm="${i}" type="button">ลบ</button>`:''}
          </span>
        </div>
        <div class="field"><div class="ir-combo"></div></div>
        <div class="row2">
          <div class="field"><label>จำนวน (ขวด/ถุง)</label><input type="number" class="ir-qty" step="0.1" value="${it.qty}" placeholder="0"></div>
          <div class="field"><label>ราคาต่อหน่วย</label><input type="number" class="ir-unit" value="${it.unitCost}" placeholder="0"></div>
        </div>
        <div class="line-total ir-line">รวมรายการนี้ <b>฿0</b></div>
      </div>
    `).join('');
    itemsWrap.querySelectorAll('.item-row').forEach((row,i)=>{
      // repaint the colour band + tag whenever the chosen product changes
      const setCat = (k)=>{
        items[i].cat = k;
        CARE_CATS.forEach(c=>row.classList.toggle('cat-'+c.key, c.key===k));
        row.querySelector('.ir-cat').innerHTML = catTagHtml(k);
      };
      mountCombo(row.querySelector('.ir-combo'), {
        placeholder:'เช่น ปุ๋ยสูตร 15-15-15, ยาฆ่าแมลง...',
        value: items[i].name,
        getOptions: productOptions,
        getOptionMeta: (name)=>{ const k = productCategory(name); return k ? catTagHtml(k) : ''; },
        addOptions: CARE_CATS.map(c=>({key:c.key, label:c.label, tag:catTagHtml(c.key)})),
        onPick:(v, addCat)=>{
          if(!v) return;
          // a name that isn't in Settings yet still needs a category, so the
          // list offers to file it on the spot rather than blocking the entry
          if(addCat){
            if(!STATE.products.some(p=>p.name===v)){
              STATE.products.push(touch({ id:uid(), name:v, type: catByKey(addCat).product }));
              saveState();
            }
            setCat(addCat);
            return;
          }
          setCat(productCategory(v) || 'other');
        }
      });
      row.querySelectorAll('.ir-qty, .ir-unit').forEach(inp=>inp.addEventListener('input', refreshTotals));
      const rm = row.querySelector('[data-rm]');
      if(rm) rm.addEventListener('click', ()=>{
        readItemsFromDOM();
        items.splice(Number(rm.getAttribute('data-rm')),1);
        renderItems();
      });
    });
    refreshTotals();
  }
  renderItems();

  document.getElementById('cfAddItem').addEventListener('click', ()=>{
    readItemsFromDOM();
    items.push({name:'', qty:'', unitCost:'', cat:'other'});
    renderItems();
    const last = itemsWrap.lastElementChild;
    if(last && typeof last.scrollIntoView === 'function') last.scrollIntoView({block:'nearest', behavior:'smooth'});
  });
  otherEl.addEventListener('input', refreshTotals);

  document.getElementById('sgClose').addEventListener('click', ()=>closeSheet('sheetGeneric'));
  document.getElementById('cfSave').addEventListener('click', ()=>{
    if(!selectedPlot){ toast('กรุณาเลือกแปลง'); return; }
    readItemsFromDOM();
    const cleanItems = items
      .filter(it=>it.name || Number(it.qty) || Number(it.unitCost))
      .map(it=>({ name: it.name, cat: it.cat || 'other',
                  qty: Number(it.qty)||0, unitCost: Number(it.unitCost)||0 }));
    // categories are owned by Settings; just make sure the product exists there
    cleanItems.forEach(it=>{
      if(!it.name) return;
      if(!STATE.products.some(x=>x.name===it.name)){
        STATE.products.push(touch({ id:uid(), name:it.name, type: catByKey(it.cat||'other').product }));
      }
    });
    const otherCost = Number(otherEl.value)||0;
    const total = cleanItems.reduce((s,it)=>s + it.qty*it.unitCost, 0) + otherCost;
    const data = {
      date: document.getElementById('cfDate').value || todayISO(),
      plotId: selectedPlot,
      type: sheet.querySelector('#careType .chip.active').getAttribute('data-t'),
      items: cleanItems,
      otherCost: otherCost,
      totalCost: total,
      // kept so entries saved before multi-item support still read correctly
      productName: cleanItems.length? cleanItems[0].name : '',
      qtyBottles: cleanItems.length? cleanItems[0].qty : 0,
      unitCost: cleanItems.length? cleanItems[0].unitCost : 0,
      note: document.getElementById('cfNote').value.trim()
    };
    if(isEdit){ touch(Object.assign(existing, data)); } else { STATE.careEvents.push(touch(Object.assign({id:uid()}, data))); }
    saveState(); closeSheet('sheetGeneric'); toast('บันทึกแล้ว');
    refreshCurrentView();
  });
  if(isEdit){
    document.getElementById('cfDelete').addEventListener('click', async ()=>{
      const ok = await confirmDialog({ title:'ลบบันทึกการดูแลนี้?', message:'ค่าใช้จ่ายของรายการนี้จะถูกหักออกจากยอดรวมด้วย' });
      if(!ok) return;
      STATE.careEvents = STATE.careEvents.filter(x=>x.id!==existing.id); tombstone('care_events', existing.id);
      saveState(); closeSheet('sheetGeneric'); toast('ลบแล้ว'); refreshCurrentView();
    });
  }
  openSheet('sheetGeneric');
}

/* ============================== FORM: HEALTH ISSUE ============================== */
function openHealthForm(existing, presetPlotId){
  const isEdit = !!existing;
  const plotId = existing? existing.plotId : presetPlotId;
  const severity = existing? existing.severity : 'watch';
  const sheet = document.getElementById('sheetGeneric');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${isEdit?'แก้ไขบันทึกสุขภาพ':'บันทึกปัญหาสุขภาพต้นไม้'}</h3><button class="icon-btn" id="sgClose">${ICONS.close}</button></div>
    <div class="field"><label>แปลง</label>${plotChipsHtml(plotId)}</div>
    <div class="field"><label>วันที่พบ</label><input type="date" id="hfDate" value="${existing?existing.date:todayISO()}"></div>
    <div class="field"><label>ประเภทปัญหา</label><div id="hfTypeCombo"></div></div>
    <div class="field"><label>รายละเอียด</label><textarea id="hfDesc" placeholder="อาการที่พบ เช่น ใบเหลือง มีแมลง ราน้ำค้าง">${existing?escapeHtml(existing.description||''):''}</textarea></div>
    <div class="field"><label>จำนวนต้นที่ได้รับผลกระทบ (โดยประมาณ)</label><input type="number" id="hfCount" value="${existing?existing.affectedTreeCountEst||'':''}" placeholder="0"></div>
    <div class="field"><label>ความรุนแรง</label>
      <div class="chip-group" id="hfSeverity">
        <div class="chip ${severity==='watch'?'active':''}" data-s="watch">เฝ้าระวัง</div>
        <div class="chip ${severity==='urgent'?'active':''}" data-s="urgent">ด่วน</div>
      </div>
    </div>
    <div class="field"><label>สถานะ</label>
      <div class="chip-group" id="hfStatus">
        <div class="chip ${(!existing||existing.status==='open')?'active':''}" data-st="open">ยังไม่แก้ไข</div>
        <div class="chip ${(existing&&existing.status==='resolved')?'active':''}" data-st="resolved">แก้ไขแล้ว</div>
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="hfSave">${isEdit?'บันทึกการแก้ไข':'บันทึก'}</button>
    ${isEdit?`<button class="btn btn-danger btn-block" style="margin-top:8px" id="hfDelete">ลบรายการนี้</button>`:''}
  `;
  let selectedPlot = plotId;
  wirePlotChips(sheet, (v)=>{ selectedPlot=v; });
  sheet.querySelectorAll('#hfSeverity .chip').forEach(ch=>ch.addEventListener('click', ()=>{
    sheet.querySelectorAll('#hfSeverity .chip').forEach(c=>c.classList.remove('active')); ch.classList.add('active');
  }));
  sheet.querySelectorAll('#hfStatus .chip').forEach(ch=>ch.addEventListener('click', ()=>{
    sheet.querySelectorAll('#hfStatus .chip').forEach(c=>c.classList.remove('active')); ch.classList.add('active');
  }));
  const issueOptions = ()=>{
    const s = new Set(['ใบเหลือง','เพลี้ย/แมลงศัตรูพืช','ราน้ำค้าง','โรครากเน่า','ขาดน้ำ','ดินขาดธาตุอาหาร']);
    STATE.healthIssues.forEach(h=>{ if(h.issueType) s.add(h.issueType); });
    return Array.from(s);
  };
  mountCombo(document.getElementById('hfTypeCombo'), { placeholder:'เช่น ใบเหลือง, เพลี้ย...', value: existing?existing.issueType||'':'', getOptions: issueOptions });

  document.getElementById('sgClose').addEventListener('click', ()=>closeSheet('sheetGeneric'));
  document.getElementById('hfSave').addEventListener('click', ()=>{
    if(!selectedPlot){ toast('กรุณาเลือกแปลง'); return; }
    const data = {
      date: document.getElementById('hfDate').value || todayISO(),
      plotId: selectedPlot,
      issueType: document.getElementById('hfTypeCombo').querySelector('.combo-input').value.trim(),
      description: document.getElementById('hfDesc').value.trim(),
      affectedTreeCountEst: Number(document.getElementById('hfCount').value)||0,
      severity: sheet.querySelector('#hfSeverity .chip.active').getAttribute('data-s'),
      status: sheet.querySelector('#hfStatus .chip.active').getAttribute('data-st')
    };
    if(isEdit){ touch(Object.assign(existing, data)); } else { STATE.healthIssues.push(touch(Object.assign({id:uid()}, data))); }
    saveState(); closeSheet('sheetGeneric'); toast('บันทึกแล้ว');
    refreshCurrentView();
  });
  if(isEdit){
    document.getElementById('hfDelete').addEventListener('click', async ()=>{
      const ok = await confirmDialog({ title:'ลบบันทึกสุขภาพนี้?', message:'ประวัติปัญหาของแปลงนี้จะหายไปด้วย' });
      if(!ok) return;
      STATE.healthIssues = STATE.healthIssues.filter(x=>x.id!==existing.id); tombstone('health_issues', existing.id);
      saveState(); closeSheet('sheetGeneric'); toast('ลบแล้ว'); refreshCurrentView();
    });
  }
  openSheet('sheetGeneric');
}

/* ============================== FORM: HARVEST ============================== */
function openHarvestForm(existing, presetPlotId){
  const isEdit = !!existing;
  const plotId = existing? existing.plotId : presetPlotId;
  const sheet = document.getElementById('sheetGeneric');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${isEdit?'แก้ไขบันทึกเก็บเกี่ยว':'บันทึกการเก็บเกี่ยว'}</h3><button class="icon-btn" id="sgClose">${ICONS.close}</button></div>
    <div class="field"><label>แปลง</label>${plotChipsHtml(plotId)}</div>
    <div class="field"><label>วันที่เก็บเกี่ยว</label><input type="date" id="vfDate" value="${existing?existing.date:todayISO()}"></div>
    <div class="field"><label>ชนิดผลไม้</label><div id="vfFruitCombo"></div></div>
    <div class="row2">
      <div class="field"><label>น้ำหนัก (กก.)</label><input type="number" id="vfWeight" value="${existing?existing.weightKg||'':''}" placeholder="0" step="0.1"></div>
      <div class="field"><label>จำนวนลูก</label><input type="number" id="vfCount" value="${existing?existing.count||'':''}" placeholder="0"></div>
    </div>
    <div class="row2">
      <div class="field"><label>ราคาต่อกก. (บาท)</label><input type="number" id="vfPrice" value="${existing?existing.pricePerKg||'':''}" placeholder="0"></div>
      <div class="field"><label>ผู้รับซื้อ</label><div id="vfBuyerCombo"></div></div>
    </div>
    <div class="row2">
      <div class="field"><label>ค่าจ้างเก็บเกี่ยว (บาท)</label><input type="number" id="vfLabor" value="${existing?existing.laborCost||'':''}" placeholder="0"></div>
      <div class="field"><label>ค่าน้ำมัน (บาท)</label><input type="number" id="vfFuel" value="${existing?existing.fuelCost||'':''}" placeholder="0"></div>
    </div>
    <div class="field"><label>หมายเหตุ</label><textarea id="vfNote">${existing?escapeHtml(existing.note||''):''}</textarea></div>
    <div class="card tint-lavender" style="margin-bottom:14px"><div class="flex-between"><span class="muted">รายได้โดยประมาณ</span><span class="num" id="vfRevenuePreview" style="font-weight:700">฿0</span></div></div>
    <button class="btn btn-primary btn-block" id="vfSave">${isEdit?'บันทึกการแก้ไข':'บันทึก'}</button>
    ${isEdit?`<button class="btn btn-danger btn-block" style="margin-top:8px" id="vfDelete">ลบรายการนี้</button>`:''}
  `;
  let selectedPlot = plotId, selectedBuyer = existing?existing.buyerId:null;
  wirePlotChips(sheet, (v)=>{ selectedPlot=v; });
  const fruitOptions = ()=>Array.from(new Set(STATE.plots.map(p=>p.fruitType).filter(Boolean).concat(['มะม่วง','ทุเรียน','เงาะ','ลำไย','มังคุด','ลองกอง'])));
  mountCombo(document.getElementById('vfFruitCombo'), { placeholder:'ชนิดผลไม้', value: existing?existing.fruitType:(plotById(plotId)?plotById(plotId).fruitType:''), getOptions: fruitOptions });
  const buyerOptions = ()=>STATE.buyers.map(b=>b.name);
  mountCombo(document.getElementById('vfBuyerCombo'), { placeholder:'ชื่อผู้รับซื้อ', value: existing&&existing.buyerId? (buyerById(existing.buyerId)?buyerById(existing.buyerId).name:''):'', getOptions: buyerOptions,
    onPick:(v)=>{ let b = STATE.buyers.find(x=>x.name===v); if(!b){ b=touch({id:uid(), name:v, phone:'', note:''}); STATE.buyers.push(b); saveState(); } selectedBuyer=b.id; }
  });

  const wEl=document.getElementById('vfWeight'), prEl=document.getElementById('vfPrice'), revPrev=document.getElementById('vfRevenuePreview');
  function recalcRev(){ revPrev.textContent = '฿'+fmtMoney((Number(wEl.value)||0)*(Number(prEl.value)||0)); }
  wEl.addEventListener('input', recalcRev); prEl.addEventListener('input', recalcRev); recalcRev();

  document.getElementById('sgClose').addEventListener('click', ()=>closeSheet('sheetGeneric'));
  document.getElementById('vfSave').addEventListener('click', ()=>{
    if(!selectedPlot){ toast('กรุณาเลือกแปลง'); return; }
    const data = {
      date: document.getElementById('vfDate').value || todayISO(),
      plotId: selectedPlot,
      fruitType: document.getElementById('vfFruitCombo').querySelector('.combo-input').value.trim(),
      weightKg: Number(wEl.value)||0,
      count: Number(document.getElementById('vfCount').value)||0,
      pricePerKg: Number(prEl.value)||0,
      buyerId: selectedBuyer,
      laborCost: Number(document.getElementById('vfLabor').value)||0,
      fuelCost: Number(document.getElementById('vfFuel').value)||0,
      note: document.getElementById('vfNote').value.trim()
    };
    if(isEdit){ touch(Object.assign(existing, data)); } else { STATE.harvests.push(touch(Object.assign({id:uid()}, data))); }
    saveState(); closeSheet('sheetGeneric'); toast('บันทึกแล้ว');
    refreshCurrentView();
  });
  if(isEdit){
    document.getElementById('vfDelete').addEventListener('click', async ()=>{
      const ok = await confirmDialog({ title:'ลบบันทึกเก็บเกี่ยวนี้?', message:'รายได้ของรายการนี้จะถูกหักออกจากยอดรวมด้วย' });
      if(!ok) return;
      STATE.harvests = STATE.harvests.filter(x=>x.id!==existing.id); tombstone('harvests', existing.id);
      saveState(); closeSheet('sheetGeneric'); toast('ลบแล้ว'); refreshCurrentView();
    });
  }
  openSheet('sheetGeneric');
}

/* One place that knows how to open any record for editing, so a row in any
   list can be made tappable without duplicating the lookup logic. */
function openRecord(kind, id){
  if(kind==='care'){
    const e = STATE.careEvents.find(x=>x.id===id); if(e) openCareForm(e);
  } else if(kind==='health'){
    const h = STATE.healthIssues.find(x=>x.id===id); if(h) openHealthForm(h);
  } else if(kind==='harvest'){
    const h = STATE.harvests.find(x=>x.id===id); if(h) openHarvestForm(h);
  } else if(kind==='task'){
    const t = STATE.tasks.find(x=>x.id===id); if(t) openTaskForm(t);
  } else if(kind==='plot'){
    const pl = plotById(id); if(pl) openPlotForm(pl);
  }
}
/* Wires every [data-rec] row inside a container to open its record. */
function wireRecordRows(root){
  if(!root) return;
  root.querySelectorAll('[data-rec]').forEach(el=>el.addEventListener('click', (ev)=>{
    if(ev.target.closest('button')) return;
    openRecord(el.getAttribute('data-rec'), el.getAttribute('data-rec-id'));
  }));
}

function refreshCurrentView(){
  if(window.__renderView) window.__renderView(currentView, {});
}

/* ============================== RENDER: CALENDAR ============================== */
let calSelectedDate = todayISO();
function renderCalendar(){
  const root = document.getElementById('view-calendar');
  root.innerHTML = `
    <div class="flex-between" style="margin-bottom:10px">
      <h2 style="font-size:19px">ปฏิทินดูแลสวน</h2>
      <button class="btn btn-primary btn-sm" id="btnAddTask">${ICONS.plus} เพิ่มงาน</button>
    </div>
    <div class="cal-strip" id="calStrip"></div>
    <div id="calOverdue"></div>
    <div class="section-title"><h2 id="calDayLabel"></h2></div>
    <div class="list" id="calDayList"></div>
    <div class="section-title"><h2>งานที่ยังไม่เสร็จทั้งหมด</h2></div>
    <div class="list" id="calAllList"></div>
  `;
  // strip: -2 .. +18 days
  const strip = document.getElementById('calStrip');
  let html = "";
  for(let i=-2;i<=18;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    const iso = d.toISOString().slice(0,10);
    const hasTask = STATE.tasks.some(t=>t.dueDate===iso && !t.done);
    html += `<div class="cal-day ${iso===todayISO()?'today':''} ${iso===calSelectedDate?'sel':''}" data-date="${iso}">
      <div class="dow">${THAI_DOW[d.getDay()]}</div><div class="dnum">${d.getDate()}</div>${hasTask?'<div class="dot"></div>':'<div style="height:9px"></div>'}
    </div>`;
  }
  strip.innerHTML = html;
  strip.querySelectorAll('.cal-day').forEach(el=>el.addEventListener('click', ()=>{ calSelectedDate = el.getAttribute('data-date'); renderCalendar(); }));

  const overdue = overdueTasks();
  document.getElementById('calOverdue').innerHTML = overdue.length ? `<div class="banner urgent"><div class="b-icon">⏰</div><div><div class="b-title">งานค้าง ${overdue.length} รายการ</div><div class="b-desc">เลื่อนวันหรือทำเครื่องหมายว่าเสร็จ</div></div></div>` : '';

  document.getElementById('calDayLabel').textContent = fmtDate(calSelectedDate) + (calSelectedDate===todayISO()?' (วันนี้)':'');
  const dayTasks = STATE.tasks.filter(t=>t.dueDate===calSelectedDate).sort((a,b)=>Number(a.done)-Number(b.done));
  document.getElementById('calDayList').innerHTML = dayTasks.length ? dayTasks.map(taskRowHtml).join('') : `<div class="empty"><div class="desc">ไม่มีงานในวันนี้</div></div>`;

  const allOpen = STATE.tasks.filter(t=>!t.done).sort((a,b)=>a.dueDate<b.dueDate?-1:1);
  document.getElementById('calAllList').innerHTML = allOpen.length ? allOpen.map(taskRowHtml).join('') : `<div class="empty"><div class="desc">ไม่มีงานค้าง 🎉</div></div>`;

  root.querySelectorAll('[data-task]').forEach(el=>el.addEventListener('click', (e)=>{
    if(e.target.closest('.task-done-btn')) return;
    const t = STATE.tasks.find(x=>x.id===el.getAttribute('data-task'));
    if(t) openTaskForm(t);
  }));
  root.querySelectorAll('.task-done-btn').forEach(btn=>btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const t = STATE.tasks.find(x=>x.id===btn.getAttribute('data-done'));
    if(!t) return;
    t.done = true; t.doneDate = todayISO(); touch(t);
    if(t.recurrenceDays){
      const next = new Date(t.dueDate+"T00:00:00"); next.setDate(next.getDate()+Number(t.recurrenceDays));
      STATE.tasks.push(touch({ id:uid(), title:t.title, plotId:t.plotId, type:t.type, dueDate: next.toISOString().slice(0,10), recurrenceDays:t.recurrenceDays, done:false }));
    }
    saveState(); toast('ทำเครื่องหมายว่าเสร็จแล้ว'); renderCalendar();
  }));
  document.getElementById('btnAddTask').addEventListener('click', ()=>openTaskForm(null));
}

function taskRowHtml(t){
  const meta = taskTypeMeta(t.type);
  const p = plotById(t.plotId);
  const overdue = !t.done && t.dueDate < todayISO();
  return `<div class="row-card" data-task="${t.id}" style="${t.done?'opacity:.5':''}">
    <div class="row-icon ${meta.cls}" style="color:${meta.color}">${meta.icon}</div>
    <div class="row-main"><div class="row-title">${escapeHtml(t.title||meta.label)}</div><div class="row-sub">${p?escapeHtml(p.name):''} ${overdue?' · เลยกำหนด':''} ${t.recurrenceDays?(' · ซ้ำทุก '+t.recurrenceDays+' วัน'):''}</div></div>
    <div class="row-end">
      ${t.done? `<span class="badge badge-ok">เสร็จแล้ว</span>` : `<button class="btn btn-soft btn-sm task-done-btn" data-done="${t.id}">${ICONS.check}</button>`}
      <div class="muted" style="margin-top:4px">${fmtDateShort(t.dueDate)}</div>
    </div>
  </div>`;
}

function openTaskForm(existing){
  const isEdit = !!existing;
  const type = existing? existing.type : 'spray';
  const sheet = document.getElementById('sheetGeneric');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${isEdit?'แก้ไขงาน':'เพิ่มงานในปฏิทิน'}</h3><button class="icon-btn" id="sgClose">${ICONS.close}</button></div>
    <div class="field"><label>ชื่องาน</label><input type="text" id="tfTitle" value="${existing?escapeHtml(existing.title||''):''}" placeholder="เช่น พ่นยากันเพลี้ยแปลงหน้าบ้าน"></div>
    <div class="field"><label>ประเภท</label>
      <div class="chip-group" id="tfType">
        <div class="chip ${type==='spray'?'active':''}" data-t="spray">พ่นยา</div>
        <div class="chip ${type==='fertilize'?'active':''}" data-t="fertilize">ใส่ปุ๋ย</div>
        <div class="chip ${type==='water'?'active':''}" data-t="water">รดน้ำ</div>
        <div class="chip ${type==='other'?'active':''}" data-t="other">อื่นๆ</div>
      </div>
    </div>
    <div class="field"><label>แปลง</label>${plotChipsHtml(existing?existing.plotId:null)}</div>
    <div class="field"><label>วันครบกำหนด</label><input type="date" id="tfDate" value="${existing?existing.dueDate:todayISO()}"></div>
    <div class="field"><label>ทำซ้ำทุก (วัน) — เว้นว่างถ้าไม่ซ้ำ</label>
      <div class="chip-group" id="tfRecur">
        <div class="chip ${(!existing||!existing.recurrenceDays)?'active':''}" data-r="">ไม่ซ้ำ</div>
        <div class="chip ${existing&&existing.recurrenceDays==7?'active':''}" data-r="7">ทุก 7 วัน</div>
        <div class="chip ${existing&&existing.recurrenceDays==14?'active':''}" data-r="14">ทุก 14 วัน</div>
        <div class="chip ${existing&&existing.recurrenceDays==30?'active':''}" data-r="30">ทุก 30 วัน</div>
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="tfSave">${isEdit?'บันทึกการแก้ไข':'เพิ่มงาน'}</button>
    ${isEdit?`<button class="btn btn-danger btn-block" style="margin-top:8px" id="tfDelete">ลบงานนี้</button>`:''}
  `;
  let selectedPlot = existing?existing.plotId:null;
  wirePlotChips(sheet, (v)=>{ selectedPlot=v; });
  sheet.querySelectorAll('#tfType .chip').forEach(ch=>ch.addEventListener('click', ()=>{ sheet.querySelectorAll('#tfType .chip').forEach(c=>c.classList.remove('active')); ch.classList.add('active'); }));
  sheet.querySelectorAll('#tfRecur .chip').forEach(ch=>ch.addEventListener('click', ()=>{ sheet.querySelectorAll('#tfRecur .chip').forEach(c=>c.classList.remove('active')); ch.classList.add('active'); }));

  document.getElementById('sgClose').addEventListener('click', ()=>closeSheet('sheetGeneric'));
  document.getElementById('tfSave').addEventListener('click', ()=>{
    const title = document.getElementById('tfTitle').value.trim();
    if(!title){ toast('กรุณาใส่ชื่องาน'); return; }
    const rec = sheet.querySelector('#tfRecur .chip.active').getAttribute('data-r');
    const data = {
      title, plotId: selectedPlot,
      type: sheet.querySelector('#tfType .chip.active').getAttribute('data-t'),
      dueDate: document.getElementById('tfDate').value || todayISO(),
      recurrenceDays: rec? Number(rec) : null
    };
    if(isEdit){ touch(Object.assign(existing, data)); } else { STATE.tasks.push(touch(Object.assign({id:uid(), done:false}, data))); }
    saveState(); closeSheet('sheetGeneric'); toast('บันทึกแล้ว'); refreshCurrentView();
  });
  if(isEdit){
    document.getElementById('tfDelete').addEventListener('click', async ()=>{
      const ok = await confirmDialog({ title:'ลบงานนี้?', message:'งานนี้จะหายไปจากปฏิทิน' });
      if(!ok) return;
      STATE.tasks = STATE.tasks.filter(x=>x.id!==existing.id); tombstone('tasks', existing.id);
      saveState(); closeSheet('sheetGeneric'); toast('ลบแล้ว'); refreshCurrentView();
    });
  }
  openSheet('sheetGeneric');
}

/* ============================== RENDER: ANALYSIS ============================== */
let analysisMonth = thisMonthKey();
let analysisYear = new Date().getFullYear();
let analysisMode = 'month'; // 'month' | 'year' | 'all'

function renderAnalysis(){
  const root = document.getElementById('view-analysis');
  const isYear = analysisMode==='year';
  const isAll  = analysisMode==='all';
  let headerLabel, st, periodMatch;
  if(isAll){
    headerLabel = 'ตั้งแต่เริ่มบันทึก';
    periodMatch = ()=>true;
    const all = economicsFor(STATE.plots.map(p=>p.id), periodMatch);
    st = { totalCost: all.cost, revenue: all.revenue, profit: all.profit };
  } else if(isYear){
    headerLabel = 'ปี ' + (analysisYear+543);
    st = yearStats(analysisYear);
    periodMatch = (dateStr)=> dateStr.slice(0,4)===String(analysisYear);
  } else {
    const d = new Date(analysisMonth+"-01");
    headerLabel = THAI_MONTHS[d.getMonth()] + " " + (d.getFullYear()+543);
    st = monthStats(analysisMonth);
    periodMatch = (dateStr)=> monthKey(dateStr)===analysisMonth;
  }

  root.innerHTML = `
    <h2 style="font-size:19px; margin-bottom:12px">วิเคราะห์ต้นทุน</h2>
    <div class="chip-group" id="anModeChips" style="margin-bottom:12px">
      <div class="chip ${analysisMode==='month'?'active':''}" data-mode="month">รายเดือน</div>
      <div class="chip ${isYear?'active':''}" data-mode="year">รายปี</div>
      <div class="chip ${isAll?'active':''}" data-mode="all">ทั้งหมด</div>
    </div>
    <div class="flex-between card" style="margin-bottom:14px; padding:10px 14px">
      ${isAll?'<span style="width:42px"></span>':`<button class="icon-btn" id="amPrev">${ICONS.back}</button>`}
      <div style="font-weight:700; font-size:14.5px">${headerLabel}</div>
      ${isAll?'<span style="width:42px"></span>':`<button class="icon-btn" id="amNext" style="transform:rotate(180deg)">${ICONS.back}</button>`}
    </div>
    <div class="bento">
      <div class="card stat-card tint-blue"><div class="label">ต้นทุนรวม</div><div class="value mono num">฿${fmtMoney(st.totalCost)}</div></div>
      <div class="card stat-card tint-peach"><div class="label">รายได้รวม${isYear?'ต่อปี':''}</div><div class="value mono num">฿${fmtMoney(st.revenue)}</div></div>
      <div class="card stat-card span2 ${st.profit>=0?'tint-lavender':'tint-pink'}"><div class="label">กำไรสุทธิ${isYear?'ต่อปี':''}</div><div class="value mono num">${st.profit>=0?'':'-'}฿${fmtMoney(Math.abs(st.profit))}</div></div>
    </div>

    ${isYear? `<div class="section-title"><h2>รายได้-ต้นทุนรายเดือนในปีนี้</h2></div><div class="card" id="anYearMonthly"></div><div class="chart-legend" style="padding:0 4px"><span><span class="dot" style="background:var(--blue)"></span>ต้นทุน</span><span><span class="dot" style="background:var(--peach)"></span>รายได้</span></div>` : ''}

    <div class="section-title"><h2>ต้นทุนต่อกิโล · จุดคุ้มทุน</h2></div>
    <div id="anUnit"></div>

    <div class="section-title"><h2>เทียบรายแปลง</h2></div>
    <div id="anPlotTable"></div>

    <div class="section-title"><h2>เทียบตามชนิดผลไม้</h2></div>
    <div id="anFruitTable"></div>

    <div class="section-title"><h2>ค่าปุ๋ย เทียบกับ ค่ายา</h2></div>
    <div class="bento" id="anCatSplit"></div>

    <div class="section-title"><h2>สัดส่วนต้นทุน</h2></div>
    <div class="card" id="anDonut"></div>

    <div class="section-title"><h2>ต้นทุนแยกตามแปลง</h2></div>
    <div class="card" id="anByPlot"></div>

    <div class="section-title"><h2>รายการค่าใช้จ่ายสูงสุด (Top 5)</h2></div>
    <div class="list" id="anTop5"></div>
  `;
  if(document.getElementById('amPrev')) document.getElementById('amPrev').addEventListener('click', ()=>{ isYear? shiftYear(-1) : shiftMonth(-1); });
  if(document.getElementById('amNext')) document.getElementById('amNext').addEventListener('click', ()=>{ isYear? shiftYear(1) : shiftMonth(1); });
  renderUnitEconomics(periodMatch, isAll);
  document.querySelectorAll('#anModeChips .chip').forEach(ch=>ch.addEventListener('click', ()=>{
    analysisMode = ch.getAttribute('data-mode'); renderAnalysis();
  }));

  if(isYear){
    const monthsData = [];
    for(let m=0;m<12;m++){
      const mk = analysisYear + "-" + String(m+1).padStart(2,'0');
      const ms = monthStats(mk);
      monthsData.push({ label: THAI_MONTHS[m], value: Math.round(ms.totalCost), value2: Math.round(ms.revenue) });
    }
    barChart(document.getElementById('anYearMonthly'), monthsData, {h:150, colorA:'var(--blue)', colorB:'var(--peach)'});
  }

  // donut: split by the category of each line, so a round that mixed
  // fertiliser and chemical is counted under both rather than one work type
  const careInPeriod = STATE.careEvents.filter(e=>periodMatch(e.date));
  const harvestsInPeriod = STATE.harvests.filter(h=>periodMatch(h.date));
  const catTotals = categoryCostTotals(periodMatch);
  const donutData = [
    {label:'ค่าปุ๋ย', value:catTotals.fertilizer, color:catByKey('fertilizer').color},
    {label:'ค่ายา', value:catTotals.pesticide, color:catByKey('pesticide').color},
    {label:'ค่าแรงเก็บเกี่ยว', value:catTotals.labor, color:'var(--peach)'},
    {label:'ค่าน้ำมัน', value:catTotals.fuel, color:'var(--pink)'},
    {label:'อื่นๆ', value:catTotals.other, color:'var(--text-faint)'}
  ].filter(d=>d.value>0);
  // ปุ๋ย vs ยา headline
  const splitBox = document.getElementById('anCatSplit');
  const fert = catTotals.fertilizer, pest = catTotals.pesticide;
  if(fert || pest){
    const sum = fert + pest;
    splitBox.innerHTML = `
      <div class="card stat-card cat-tint-fertilizer">
        <div class="label">ค่าปุ๋ย</div>
        <div class="value mono num">฿${fmtMoney(fert)}</div>
        <div class="delta muted">${sum?Math.round(fert/sum*100):0}% ของค่าปุ๋ย+ยา</div>
      </div>
      <div class="card stat-card cat-tint-pesticide">
        <div class="label">ค่ายา</div>
        <div class="value mono num">฿${fmtMoney(pest)}</div>
        <div class="delta muted">${sum?Math.round(pest/sum*100):0}% ของค่าปุ๋ย+ยา</div>
      </div>`;
  } else {
    splitBox.innerHTML = `<div class="card span2"><p class="muted">ยังไม่มีค่าปุ๋ยหรือค่ายาในช่วงนี้</p></div>`;
  }

  donutChart(document.getElementById('anDonut'), donutData, {});
  if(!donutData.length) document.getElementById('anDonut').innerHTML = `<div class="empty"><div class="desc">ยังไม่มีค่าใช้จ่ายใน${isYear?'ปีนี้':'เดือนนี้'}</div></div>`;

  // by plot bar chart (period-aware)
  const plotCosts = STATE.plots.map(p=>{
    const c1 = STATE.careEvents.filter(e=>e.plotId===p.id && periodMatch(e.date)).reduce((s,e)=>s+careCostOf(e),0);
    const c2 = STATE.harvests.filter(h=>h.plotId===p.id && periodMatch(h.date)).reduce((s,h)=>s+harvestCostOf(h),0);
    return { label: p.name, value: Math.round(c1+c2) };
  }).filter(d=>d.value>0).sort((a,b)=>b.value-a.value);
  if(plotCosts.length){ barChart(document.getElementById('anByPlot'), plotCosts, {h:150, colorA:'var(--blue)'}); }
  else { document.getElementById('anByPlot').innerHTML = `<div class="empty"><div class="desc">ยังไม่มีข้อมูลค่าใช้จ่ายแยกตามแปลง</div></div>`; }

  // top 5 expenses (individual entries, period-aware)
  let entries = [];
  careInPeriod.forEach(e=>entries.push({kind:'care', id:e.id, date:e.date, label:taskTypeMeta(e.type).label+(careItemsSummary(e)?(' · '+careItemsSummary(e)):''), plot:plotById(e.plotId), cost:careCostOf(e)}));
  harvestsInPeriod.forEach(h=>{
    const c = harvestCostOf(h); if(c>0) entries.push({kind:'harvest', id:h.id, date:h.date, label:'ค่าแรง/น้ำมันเก็บเกี่ยว', plot:plotById(h.plotId), cost:c});
  });
  entries.sort((a,b)=>b.cost-a.cost);
  entries = entries.slice(0,5);
  document.getElementById('anTop5').innerHTML = entries.length ? entries.map(en=>`
    <div class="row-card" data-rec="${en.kind}" data-rec-id="${en.id}"><div class="row-icon tint-blue" style="color:var(--blue-deep)">${ICONS.chart}</div>
      <div class="row-main"><div class="row-title">${escapeHtml(en.label)}</div><div class="row-sub">${en.plot?escapeHtml(en.plot.name):''}</div></div>
      <div class="row-end"><div class="num">฿${fmtMoney(en.cost)}</div><div class="muted">${fmtDateShort(en.date)}</div></div></div>
  `).join('') : `<div class="empty"><div class="desc">ยังไม่มีรายการค่าใช้จ่ายใน${isYear?'ปีนี้':'เดือนนี้'}</div></div>`;
  wireRecordRows(document.getElementById('anTop5'));
}
/* Renders the per-kilo panel, the plot table and the fruit comparison.
   Everything here is written so the answer is readable without doing maths:
   the break-even price is stated as a price, and each plot is labelled
   "คุ้ม" or "ขาดทุน" outright. */
function renderUnitEconomics(periodMatch, isAll){
  const wrap = document.getElementById('anUnit');
  if(!wrap) return;
  const all = economicsFor(STATE.plots.map(p=>p.id), periodMatch);

  if(!all.kg){
    wrap.innerHTML = `<div class="card"><div class="empty" style="padding:24px 12px">
      <span class="emoji">⚖️</span>
      <div class="title">ยังคำนวณต้นทุนต่อกิโลไม่ได้</div>
      <div class="desc">ช่วงนี้ยังไม่มีบันทึกการเก็บเกี่ยว${isAll?'':' — ลองกดดู "ทั้งหมด"'}<br>
      พอบันทึกน้ำหนักที่เก็บได้แล้ว ตัวเลขจะขึ้นให้เอง</div></div></div>`;
    document.getElementById('anPlotTable').innerHTML = '';
    document.getElementById('anFruitTable').innerHTML = '';
    return;
  }

  const good = all.profitPerKg >= 0;
  wrap.innerHTML = `
    <div class="bento">
      <div class="card stat-card tint-blue">
        <div class="label">ต้นทุนต่อกิโล</div>
        <div class="value mono num">฿${fmtNum(all.costPerKg)}</div>
        <div class="delta muted">จาก ${fmtNum(all.kg)} กก.</div>
      </div>
      <div class="card stat-card tint-peach">
        <div class="label">ราคาขายเฉลี่ย</div>
        <div class="value mono num">฿${fmtNum(all.pricePerKg)}</div>
        <div class="delta muted">ต่อกิโล</div>
      </div>
      <div class="card stat-card span2 ${good?'tint-lavender':'tint-pink'}">
        <div class="label">กำไรต่อกิโล</div>
        <div class="value mono num">${good?'':'-'}฿${fmtNum(Math.abs(all.profitPerKg))}</div>
      </div>
    </div>
    <div class="insight ${good?'':'bad'}">
      <div class="ins-title">${good?'ขายได้สูงกว่าทุน':'ตอนนี้ขายต่ำกว่าทุน'}</div>
      <p>ต้องขายให้ได้อย่างน้อย <b>฿${fmtNum(all.costPerKg)}/กก.</b> ถึงจะเท่าทุน
      ${good
        ? `ตอนนี้ขายได้เฉลี่ย ฿${fmtNum(all.pricePerKg)} เหลือกำไรกิโลละ ฿${fmtNum(all.profitPerKg)}`
        : `ตอนนี้ขายได้เฉลี่ย ฿${fmtNum(all.pricePerKg)} ขาดทุนกิโลละ ฿${fmtNum(Math.abs(all.profitPerKg))}`}</p>
      <p style="margin-top:6px">${all.kg >= all.breakEvenKg
        ? `คืนทุนไปแล้วตั้งแต่กิโลที่ <b>${fmtNum(all.breakEvenKg)}</b> — ที่เก็บได้เกินจากนั้นคือกำไร`
        : `ที่ราคานี้ ต้องเก็บขายให้ครบ <b>${fmtNum(all.breakEvenKg)} กก.</b> ถึงจะคืนทุน ยังขาดอีก <b>${fmtNum(all.breakEvenKg - all.kg)} กก.</b>`}</p>
    </div>
  `;

  // ---- per plot ----
  const plots = plotEconomics(periodMatch).filter(e=>e.kg>0 || e.cost>0);
  const ptable = document.getElementById('anPlotTable');
  if(!plots.length){
    ptable.innerHTML = `<div class="card"><p class="muted">ยังไม่มีข้อมูลรายแปลงในช่วงนี้</p></div>`;
  } else {
    plots.sort((a,b)=> (b.profitPerKg==null?-1e9:b.profitPerKg) - (a.profitPerKg==null?-1e9:a.profitPerKg));
    ptable.innerHTML = `<div class="card" style="padding:6px 0">
      <table class="tbl">
        <thead><tr><th>แปลง</th><th class="r">ทุน/กก.</th><th class="r">ขาย/กก.</th><th class="r">กำไร/กก.</th></tr></thead>
        <tbody>
        ${plots.map(e=>{
          const has = e.kg>0;
          const ok = has && e.profitPerKg>=0;
          return `<tr>
            <td><div class="t-name">${escapeHtml(e.plot.name)}</div>
                <div class="t-sub">${escapeHtml(e.plot.fruitType||'')}${has?` · ${fmtNum(e.kg)} กก.`:' · ยังไม่เก็บเกี่ยว'}</div></td>
            <td class="r num">${has?'฿'+fmtNum(e.costPerKg):'-'}</td>
            <td class="r num">${has?'฿'+fmtNum(e.pricePerKg):'-'}</td>
            <td class="r"><span class="pill ${has?(ok?'ok':'bad'):'na'}">${has?(ok?'+':'-')+'฿'+fmtNum(Math.abs(e.profitPerKg)):'-'}</span></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;

    // a plain-language read of the table
    const scored = plots.filter(e=>e.kg>0);
    if(scored.length>1){
      const best = scored[0], worst = scored[scored.length-1];
      const perTree = scored.filter(e=>e.profitPerTree!=null)
        .sort((a,b)=>b.profitPerTree-a.profitPerTree)[0];
      ptable.insertAdjacentHTML('beforeend', `
        <div class="insight" style="margin-top:12px">
          <div class="ins-title">อ่านจากตาราง</div>
          <p><b>${escapeHtml(best.plot.name)}</b> คุ้มที่สุด — กำไรกิโลละ ฿${fmtNum(best.profitPerKg)}</p>
          ${worst.profitPerKg < 0
            ? `<p style="margin-top:6px"><b>${escapeHtml(worst.plot.name)}</b> ยังขาดทุนกิโลละ ฿${fmtNum(Math.abs(worst.profitPerKg))} — ลองดูว่าต้นทุนไปลงกับอะไรมากผิดปกติ</p>`
            : `<p style="margin-top:6px">ทุกแปลงขายได้สูงกว่าทุน</p>`}
          ${perTree ? `<p style="margin-top:6px">ถ้าคิดต่อต้น <b>${escapeHtml(perTree.plot.name)}</b> ให้ผลตอบแทนดีที่สุด ต้นละ ฿${fmtNum(perTree.profitPerTree)}</p>` : ''}
        </div>`);
    }
  }

  // ---- per fruit ----
  const fruits = fruitEconomics(periodMatch).filter(e=>e.kg>0);
  const ftable = document.getElementById('anFruitTable');
  if(!fruits.length){
    ftable.innerHTML = `<div class="card"><p class="muted">ยังไม่มีข้อมูลผลผลิตในช่วงนี้</p></div>`;
  } else {
    fruits.sort((a,b)=>b.profitPerKg-a.profitPerKg);
    ftable.innerHTML = `<div class="card" style="padding:6px 0">
      <table class="tbl">
        <thead><tr><th>ผลไม้</th><th class="r">ผลผลิต</th><th class="r">กำไรรวม</th><th class="r">กำไร/กก.</th></tr></thead>
        <tbody>
        ${fruits.map(e=>`<tr>
          <td><div class="t-name">${escapeHtml(e.fruit)}</div></td>
          <td class="r num">${fmtNum(e.kg)} กก.</td>
          <td class="r num">${e.profit>=0?'':'-'}฿${fmtMoney(Math.abs(e.profit))}</td>
          <td class="r"><span class="pill ${e.profitPerKg>=0?'ok':'bad'}">${e.profitPerKg>=0?'+':'-'}฿${fmtNum(Math.abs(e.profitPerKg))}</span></td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }
}

function shiftMonth(delta){
  const d = new Date(analysisMonth+"-01");
  d.setMonth(d.getMonth()+delta);
  analysisMonth = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,'0');
  renderAnalysis();
}
function shiftYear(delta){
  analysisYear += delta;
  renderAnalysis();
}

/* ============================== RENDER: BUYERS ============================== */
function renderBuyers(){
  const root = document.getElementById('view-buyers');
  root.innerHTML = `
    <div class="flex-between" style="margin-bottom:6px">
      <button class="icon-btn" id="byBack">${ICONS.back}</button>
      <button class="btn btn-primary btn-sm" id="btnAddBuyer">${ICONS.plus} เพิ่มผู้รับซื้อ</button>
    </div>
    <h2 style="font-size:19px; margin:10px 0 14px">ผู้รับซื้อ</h2>
    <div class="list" id="buyerList"></div>
  `;
  document.getElementById('byBack').addEventListener('click', ()=>showView('menu'));
  const list = document.getElementById('buyerList');
  if(!STATE.buyers.length){
    list.innerHTML = `<div class="empty"><span class="emoji">🧺</span><div class="title">ยังไม่มีผู้รับซื้อ</div><div class="desc">เพิ่มรายชื่อผู้รับซื้อผลผลิตของสวน</div></div>`;
  } else {
    list.innerHTML = STATE.buyers.map(b=>{
      const totalRev = STATE.harvests.filter(h=>h.buyerId===b.id).reduce((s,h)=>s+harvestRevenueOf(h),0);
      return `<div class="row-card" data-buyer="${b.id}"><div class="row-icon tint-lavender" style="color:var(--lavender-deep)">${ICONS.buyers}</div>
        <div class="row-main"><div class="row-title">${escapeHtml(b.name)}</div><div class="row-sub">${escapeHtml(b.phone||'')}</div></div>
        <div class="row-end"><div class="num">฿${fmtMoney(totalRev)}</div><div class="muted">ยอดซื้อสะสม</div></div></div>`;
    }).join('');
    list.querySelectorAll('[data-buyer]').forEach(el=>el.addEventListener('click', ()=>{
      const b = STATE.buyers.find(x=>x.id===el.getAttribute('data-buyer'));
      openBuyerForm(b);
    }));
  }
  document.getElementById('btnAddBuyer').addEventListener('click', ()=>openBuyerForm(null));
}

/* Products are referenced by name inside saved entries, so renaming one has
   to rewrite those references or old records would lose their category. */
function openProductForm(existing, onDone){
  const sheet = document.getElementById('sheetGeneric');
  const curCat = catFromProductType(existing.type);
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>แก้ไขปุ๋ย/ยา</h3><button class="icon-btn" id="sgClose">${ICONS.close}</button></div>
    <div class="field"><label>ชื่อ</label><input type="text" id="prName" value="${escapeHtml(existing.name)}"></div>
    <div class="field"><label>หมวด</label>
      <div class="chip-group" id="prCat">
        ${CARE_CATS.map(c=>`<div class="chip ${c.key===curCat?'active':''}" data-cat="${c.key}">${c.label}</div>`).join('')}
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="prSave">บันทึกการแก้ไข</button>
    <button class="btn btn-danger btn-block" style="margin-top:8px" id="prDelete">ลบรายการนี้</button>
  `;
  sheet.querySelectorAll('#prCat .chip').forEach(ch=>ch.addEventListener('click', ()=>{
    sheet.querySelectorAll('#prCat .chip').forEach(c=>c.classList.remove('active'));
    ch.classList.add('active');
  }));
  document.getElementById('sgClose').addEventListener('click', ()=>closeSheet('sheetGeneric'));
  document.getElementById('prSave').addEventListener('click', ()=>{
    const name = document.getElementById('prName').value.trim();
    if(!name){ toast('กรุณาใส่ชื่อ'); return; }
    const cat = sheet.querySelector('#prCat .chip.active').getAttribute('data-cat');
    const oldName = existing.name;
    existing.name = name;
    existing.type = catByKey(cat).product;
    touch(existing);
    if(oldName !== name){
      // keep saved entries pointing at this product
      STATE.careEvents.forEach(ev=>{
        let changed = false;
        (ev.items||[]).forEach(it=>{ if(it.name===oldName){ it.name = name; changed = true; } });
        if(ev.productName===oldName){ ev.productName = name; changed = true; }
        if(changed) touch(ev);
      });
    }
    saveState(); closeSheet('sheetGeneric'); toast('แก้ไขแล้ว');
    if(onDone) onDone(); else refreshCurrentView();
  });
  document.getElementById('prDelete').addEventListener('click', async ()=>{
    const ok = await confirmDialog({ title:'ลบรายการนี้?',
      message:'บันทึกเก่าที่เคยใช้ชื่อนี้จะยังอยู่ แต่จะไม่มีหมวดอ้างอิงจากตั้งค่าแล้ว' });
    if(!ok) return;
    STATE.products = STATE.products.filter(x=>x.id!==existing.id);
    tombstone('products', existing.id);
    saveState(); closeSheet('sheetGeneric'); toast('ลบแล้ว');
    if(onDone) onDone(); else refreshCurrentView();
  });
  openSheet('sheetGeneric');
}

function openBuyerForm(existing){
  const isEdit = !!existing;
  const sheet = document.getElementById('sheetGeneric');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>${isEdit?'แก้ไขผู้รับซื้อ':'เพิ่มผู้รับซื้อ'}</h3><button class="icon-btn" id="sgClose">${ICONS.close}</button></div>
    <div class="field"><label>ชื่อ</label><input type="text" id="byName" value="${existing?escapeHtml(existing.name):''}" placeholder="ชื่อร้าน/ผู้รับซื้อ"></div>
    <div class="field"><label>เบอร์โทร</label><input type="text" id="byPhone" value="${existing?escapeHtml(existing.phone||''):''}" placeholder="08x-xxx-xxxx"></div>
    <div class="field"><label>หมายเหตุ</label><textarea id="byNote">${existing?escapeHtml(existing.note||''):''}</textarea></div>
    <button class="btn btn-primary btn-block" id="bySave">${isEdit?'บันทึกการแก้ไข':'เพิ่ม'}</button>
    ${isEdit?`<button class="btn btn-danger btn-block" style="margin-top:8px" id="byDelete">ลบผู้รับซื้อนี้</button>`:''}
  `;
  document.getElementById('sgClose').addEventListener('click', ()=>closeSheet('sheetGeneric'));
  document.getElementById('bySave').addEventListener('click', ()=>{
    const name = document.getElementById('byName').value.trim();
    if(!name){ toast('กรุณาใส่ชื่อ'); return; }
    const data = { name, phone: document.getElementById('byPhone').value.trim(), note: document.getElementById('byNote').value.trim() };
    if(isEdit){ touch(Object.assign(existing, data)); } else { STATE.buyers.push(touch(Object.assign({id:uid()}, data))); }
    saveState(); closeSheet('sheetGeneric'); toast('บันทึกแล้ว'); renderBuyers();
  });
  if(isEdit){
    document.getElementById('byDelete').addEventListener('click', async ()=>{
      const ok = await confirmDialog({ title:'ลบผู้รับซื้อรายนี้?', message:'ประวัติการขายที่ผูกไว้จะยังอยู่ แต่จะไม่มีชื่อผู้รับซื้ออ้างอิง' });
      if(!ok) return;
      STATE.buyers = STATE.buyers.filter(x=>x.id!==existing.id); tombstone('buyers', existing.id);
      saveState(); closeSheet('sheetGeneric'); toast('ลบแล้ว'); renderBuyers();
    });
  }
  openSheet('sheetGeneric');
}

/* ============================== WEATHER ============================== */
const WMO_MAP = {
  0:['ท้องฟ้าแจ่มใส','☀️'],1:['มีเมฆบางส่วน','🌤️'],2:['เมฆเป็นบางส่วน','⛅'],3:['เมฆมาก','☁️'],
  45:['หมอก','🌫️'],48:['หมอกน้ำแข็ง','🌫️'],
  51:['ฝนปรอยเบา','🌦️'],53:['ฝนปรอย','🌦️'],55:['ฝนปรอยหนัก','🌧️'],
  61:['ฝนเบา','🌦️'],63:['ฝนปานกลาง','🌧️'],65:['ฝนหนัก','🌧️'],
  80:['ฝนซู่','🌦️'],81:['ฝนซู่ปานกลาง','🌧️'],82:['ฝนซู่หนักมาก','⛈️'],
  95:['พายุฝนฟ้าคะนอง','⛈️'],96:['พายุฝนฟ้าคะนองมีลูกเห็บ','⛈️'],99:['พายุฝนฟ้าคะนองรุนแรง','⛈️']
};
function wmoDesc(code){ return WMO_MAP[code] || ['ไม่ทราบสภาพอากาศ','🌡️']; }

async function fetchWeather(){
  const {lat,lng} = STATE.garden;
  if(lat==null || lng==null) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=5`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('weather fetch failed');
  const data = await res.json();
  STATE.weatherCache = { fetchedAt: Date.now(), current: data.current, daily: data.daily };
  saveState();
  return STATE.weatherCache;
}

function renderWeather(){
  const root = document.getElementById('view-weather');
  root.innerHTML = `
    <div class="flex-between" style="margin-bottom:6px">
      <button class="icon-btn" id="wxBack">${ICONS.back}</button>
      <button class="icon-btn" id="wxRefresh">${ICONS.chart}</button>
    </div>
    <h2 style="font-size:19px; margin:10px 0 4px">สภาพอากาศ · สมาร์ทสวน</h2>
    <div class="muted" style="margin-bottom:14px">${STATE.garden.name?escapeHtml(STATE.garden.name):'สวนของเรา'}</div>
    <div id="wxBody"></div>
  `;
  document.getElementById('wxBack').addEventListener('click', ()=>showView('menu'));
  const body = document.getElementById('wxBody');

  if(STATE.garden.lat==null){
    body.innerHTML = `<div class="empty"><span class="emoji">📍</span><div class="title">ยังไม่ได้ตั้งตำแหน่งสวน</div><div class="desc">ไปที่ "ตั้งค่า" เพื่อปักหมุดตำแหน่งสวนก่อน</div></div>
      <button class="btn btn-primary btn-block" id="wxGoSettings" style="margin-top:12px">ไปตั้งค่าตำแหน่งสวน</button>`;
    document.getElementById('wxGoSettings').addEventListener('click', ()=>showView('settings'));
    return;
  }

  function paint(cache){
    if(!cache){
      body.innerHTML = `<div class="empty"><span class="emoji">📡</span><div class="title">ไม่มีข้อมูลสภาพอากาศ</div><div class="desc">ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อดึงข้อมูลครั้งแรก</div></div>`;
      return;
    }
    const c = cache.current, daily = cache.daily;
    const [desc, emoji] = wmoDesc(c.weather_code);
    const ageMin = Math.round((Date.now()-cache.fetchedAt)/60000);
    let daysHtml = "";
    if(daily && daily.time){
      daily.time.forEach((t,i)=>{
        const dd = new Date(t+"T00:00:00");
        const [dsc,em] = wmoDesc(daily.weather_code[i]);
        daysHtml += `<div class="row-card" style="cursor:default"><div class="row-icon tint-blue" style="font-size:20px">${em}</div>
          <div class="row-main"><div class="row-title">${THAI_DOW[dd.getDay()]} ${dd.getDate()} ${THAI_MONTHS[dd.getMonth()]}</div><div class="row-sub">${escapeHtml(dsc)} · ฝนตก ${daily.precipitation_probability_max[i]}%</div></div>
          <div class="row-end num">${Math.round(daily.temperature_2m_min[i])}–${Math.round(daily.temperature_2m_max[i])}°</div></div>`;
      });
    }
    const rainTip = daily && daily.precipitation_probability_max && daily.precipitation_probability_max[0]>60;
    body.innerHTML = `
      <div class="card tint-blue center" style="padding:26px 16px; margin-bottom:14px">
        <div style="font-size:44px">${emoji}</div>
        <div style="font-size:34px; font-weight:700" class="num">${Math.round(c.temperature_2m)}°C</div>
        <div class="muted">${escapeHtml(desc)} · ความชื้น ${c.relative_humidity_2m}% · ลม ${fmtNum(c.wind_speed_10m)} กม./ชม.</div>
        <div class="muted" style="margin-top:6px; font-size:11px">อัปเดตเมื่อ ${ageMin<1?'เมื่อสักครู่':ageMin+' นาทีที่แล้ว'}</div>
      </div>
      ${rainTip? `<div class="banner"><div class="b-icon">🌧️</div><div><div class="b-title">พรุ่งนี้อาจมีฝน</div><div class="b-desc">พิจารณาเลื่อนการพ่นยา/ใส่ปุ๋ยหากยังไม่จำเป็น</div></div></div>`:''}
      <div class="section-title"><h2>พยากรณ์ 5 วัน</h2></div>
      <div class="list">${daysHtml}</div>
    `;
  }

  paint(STATE.weatherCache);
  fetchWeather().then(cache=>paint(cache)).catch(()=>{
    if(!STATE.weatherCache) body.innerHTML = `<div class="empty"><span class="emoji">📡</span><div class="title">ดึงข้อมูลอากาศไม่สำเร็จ</div><div class="desc">ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต แล้วลองใหม่</div></div>`;
    else toast('ไม่สามารถอัปเดตอากาศได้ — แสดงข้อมูลล่าสุดที่มี');
  });
  document.getElementById('wxRefresh').addEventListener('click', ()=>{ toast('กำลังอัปเดต...'); fetchWeather().then(paint).catch(()=>toast('อัปเดตไม่สำเร็จ')); });
}

/* ============================== MAP PICKER (Leaflet, CDN, offline-fallback) ============================== */
let leafletLoading = null;
function ensureLeaflet(){
  if(window.L) return Promise.resolve(true);
  if(leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve)=>{
    const link = document.createElement('link');
    link.rel='stylesheet'; link.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = ()=>resolve(true);
    script.onerror = ()=>resolve(false);
    document.head.appendChild(script);
    setTimeout(()=>resolve(!!window.L), 4500);
  });
  return leafletLoading;
}

function openMapPicker(initLat, initLng, onPick){
  const modal = document.getElementById('modalMap');
  modal.innerHTML = `
    <div class="topbar"><div class="flex-between" style="width:100%">
      <button class="icon-btn" id="mapClose">${ICONS.close}</button>
      <h1>ปักหมุดตำแหน่งสวน</h1><div style="width:40px"></div>
    </div></div>
    <div style="padding:14px">
      <div id="mapEl" style="width:100%; height:340px; border-radius:var(--r-lg); overflow:hidden; background:var(--surface-alt); display:flex; align-items:center; justify-content:center; box-shadow:var(--shadow-soft)">
        <span class="muted">กำลังโหลดแผนที่...</span>
      </div>
      <div id="mapFallback" style="display:none">
        <p class="muted" style="margin:12px 0">โหลดแผนที่ไม่ได้ (ต้องใช้อินเทอร์เน็ต) กรอกพิกัดเองได้ที่นี่:</p>
        <div class="row2">
          <div class="field"><label>ละติจูด (Lat)</label><input type="text" id="mapLatIn" value="${initLat||''}"></div>
          <div class="field"><label>ลองจิจูด (Lng)</label><input type="text" id="mapLngIn" value="${initLng||''}"></div>
        </div>
      </div>
      <button class="btn btn-soft btn-block" id="mapUseGeo" style="margin-top:12px">${ICONS.pin} ใช้ตำแหน่งปัจจุบัน (GPS)</button>
      <div class="muted center" id="mapCoordLabel" style="margin:12px 0"></div>
      <button class="btn btn-primary btn-block" id="mapConfirm">ใช้ตำแหน่งนี้</button>
    </div>
  `;
  modal.classList.add('open');
  let lat = initLat, lng = initLng, marker=null, map=null;
  const coordLabel = document.getElementById('mapCoordLabel');
  function updateLabel(){ coordLabel.textContent = (lat&&lng)? `พิกัด: ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : 'ยังไม่ได้เลือกตำแหน่ง'; }
  updateLabel();

  ensureLeaflet().then(ok=>{
    if(!ok || !window.L){
      document.getElementById('mapEl').style.display='none';
      document.getElementById('mapFallback').style.display='block';
      return;
    }
    const startLat = lat||13.7563, startLng = lng||100.5018;
    document.getElementById('mapEl').innerHTML = '';
    map = L.map('mapEl').setView([startLat,startLng], lat?15:6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap' }).addTo(map);
    if(lat&&lng){ marker = L.marker([lat,lng]).addTo(map); }
    map.on('click', (e)=>{
      lat = e.latlng.lat; lng = e.latlng.lng;
      if(marker) marker.setLatLng(e.latlng); else marker = L.marker(e.latlng).addTo(map);
      updateLabel();
    });
  });

  document.getElementById('mapClose').addEventListener('click', ()=>modal.classList.remove('open'));
  document.getElementById('mapUseGeo').addEventListener('click', ()=>{
    if(!navigator.geolocation){ toast('อุปกรณ์นี้ไม่รองรับ GPS'); return; }
    toast('กำลังค้นหาตำแหน่ง...');
    navigator.geolocation.getCurrentPosition(pos=>{
      lat = pos.coords.latitude; lng = pos.coords.longitude;
      updateLabel();
      const latIn = document.getElementById('mapLatIn'); if(latIn) latIn.value = lat;
      const lngIn = document.getElementById('mapLngIn'); if(lngIn) lngIn.value = lng;
      if(map){ map.setView([lat,lng],16); if(marker) marker.setLatLng([lat,lng]); else marker=L.marker([lat,lng]).addTo(map); }
      toast('ระบุตำแหน่งแล้ว');
    }, ()=>toast('ไม่สามารถดึงตำแหน่งได้ กรุณาอนุญาตการเข้าถึงตำแหน่ง'));
  });
  document.getElementById('mapConfirm').addEventListener('click', ()=>{
    const latIn = document.getElementById('mapLatIn'), lngIn = document.getElementById('mapLngIn');
    if(latIn && latIn.offsetParent!==null){ lat = Number(latIn.value); lng = Number(lngIn.value); }
    if(lat==null || lng==null || isNaN(lat) || isNaN(lng)){ toast('กรุณาระบุตำแหน่งก่อน'); return; }
    onPick(lat,lng);
    modal.classList.remove('open');
  });
}

/* ============================== RENDER: SETTINGS ============================== */
function renderSettings(){
  const root = document.getElementById('view-settings');
  const g = STATE.garden, u = STATE.user;
  root.innerHTML = `
    <div class="flex-between" style="margin-bottom:6px"><button class="icon-btn" id="stBack">${ICONS.back}</button></div>
    <h2 style="font-size:19px; margin:10px 0 16px">ตั้งค่า</h2>

    <div class="section-title" style="margin-top:0"><h2>ข้อมูลผู้ใช้</h2></div>
    <div class="card" style="margin-bottom:14px">
      <div class="field"><label>ชื่อผู้ใช้</label><input type="text" id="stUserName" value="${escapeHtml(u.name||'')}"></div>
      <div class="field" style="margin-bottom:0"><label>บทบาท</label><input type="text" id="stUserRole" value="${escapeHtml(u.role||'')}" placeholder="เช่น เจ้าของสวน, ผู้ดูแล"></div>
    </div>

    <div class="section-title"><h2>ข้อมูลสวน</h2></div>
    <div class="card" style="margin-bottom:14px">
      <div class="field"><label>ชื่อสวน</label><input type="text" id="stGardenName" value="${escapeHtml(g.name||'')}"></div>
      <div class="row2">
        <div class="field"><label>พื้นที่</label><input type="number" id="stArea" value="${g.area||''}"></div>
        <div class="field"><label>หน่วย</label><select id="stAreaUnit"><option ${g.areaUnit==='ไร่'?'selected':''}>ไร่</option><option ${g.areaUnit==='งาน'?'selected':''}>งาน</option><option ${g.areaUnit==='เฮกตาร์'?'selected':''}>เฮกตาร์</option></select></div>
      </div>
      <div class="field"><label>ปีที่เริ่มทำสวน (พ.ศ.)</label><input type="number" id="stStartYear" value="${g.startYear||''}"></div>
      <div class="field" style="margin-bottom:0">
        <label>ตำแหน่งสวน</label>
        <button class="btn btn-ghost btn-block" id="stPickLocation">${ICONS.pin} ${g.lat!=null?`พิกัด ${Number(g.lat).toFixed(4)}, ${Number(g.lng).toFixed(4)}`:'ปักหมุดตำแหน่งสวน'}</button>
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="stSaveGarden" style="margin-bottom:20px">บันทึกข้อมูลสวน</button>

    <div class="section-title" style="margin-top:0"><h2>ปุ๋ย/ยาที่ใช้ประจำ</h2></div>
    <div class="card" style="margin-bottom:14px">
      <div id="stProductCombo" style="margin-bottom:12px"></div>
      <div class="mini-list" id="stProductList"></div>
    </div>

    <div class="section-title"><h2>แจ้งเตือน</h2></div>
    <div class="card row-card" style="cursor:default; margin-bottom:14px">
      <div class="row-icon tint-lavender" style="color:var(--lavender-deep)">${ICONS.bell}</div>
      <div class="row-main"><div class="row-title">แจ้งเตือนงานที่ครบกำหนด</div><div class="row-sub">แจ้งเตือนในแอปขณะเปิดใช้งาน (ยังไม่รองรับ LINE)</div></div>
      <div class="row-end"><label class="chip ${STATE.settings.notifEnabled?'active':''}" id="stNotifToggle" style="cursor:pointer">${STATE.settings.notifEnabled?'เปิดอยู่':'ปิดอยู่'}</label></div>
    </div>

    <div class="section-title"><h2>ซิงก์ขึ้นคลาวด์ (Supabase)</h2></div>
    <div id="cloudSection"></div>

    <div class="section-title"><h2>สำรองข้อมูล</h2></div>
    <div class="card" style="margin-bottom:14px">
      <p class="muted" style="margin-bottom:12px">ข้อมูลถูกเก็บในเครื่องนี้เสมอ จึงใช้งานได้แม้ไม่มีเน็ต และจะซิงก์ขึ้นคลาวด์ให้เองถ้าเชื่อมต่อไว้ — แนะนำให้ส่งออกไฟล์สำรองเก็บไว้เป็นระยะ</p>
      <div style="display:flex; gap:10px">
        <button class="btn btn-soft btn-block" id="stExport">${ICONS.download} ส่งออกข้อมูล</button>
        <button class="btn btn-ghost btn-block" id="stImport">${ICONS.upload} นำเข้าข้อมูล</button>
      </div>
      <input type="file" id="stImportFile" accept="application/json" style="display:none">
    </div>

    <div class="section-title"><h2>อื่นๆ</h2></div>
    <button class="btn btn-danger btn-block" id="stReset">ล้างข้อมูลทั้งหมด</button>
    <p class="muted center" style="margin:18px 0 6px">สวนอัจฉริยะ V1 · ทำงานได้แบบออฟไลน์</p>
  `;
  document.getElementById('stBack').addEventListener('click', ()=>showView('menu'));
  if(typeof renderCloudSection === 'function') renderCloudSection();

  const prodList = document.getElementById('stProductList');
  function paintProducts(){
    if(!STATE.products.length){
      prodList.innerHTML = `<p class="muted">ยังไม่มีรายการ — เลือกหมวดแล้วพิมพ์ชื่อด้านบนเพื่อเพิ่ม</p>`;
      return;
    }
    // grouped so ปุ๋ย and ยา are never mixed together in one list
    prodList.innerHTML = CARE_CATS.map(c=>{
      const inCat = STATE.products.filter(p=>catFromProductType(p.type)===c.key);
      if(!inCat.length) return '';
      return `<div class="prod-group">
        <div class="prod-head cat-${c.key}"><span class="cat-dot"></span>${c.label} <span class="cnt">${inCat.length}</span></div>
        ${inCat.map(p=>`<div class="mini-row cat-edge cat-${c.key}" data-edit-prod="${p.id}">
          <span class="mr-text">${escapeHtml(p.name)}</span>
          <span>
            <button class="mini-move" data-move="${p.id}">ย้ายหมวด</button>
            <button class="mini-remove" data-rm="${p.id}">ลบ</button>
          </span></div>`).join('')}
      </div>`;
    }).join('');

    prodList.querySelectorAll('[data-rm]').forEach(b=>b.addEventListener('click', ()=>{
      const rmId = b.getAttribute('data-rm');
      STATE.products = STATE.products.filter(p=>p.id!==rmId); tombstone('products', rmId); saveState(); paintProducts();
    }));
    // tapping the name opens the full editor (rename / category / delete)
    prodList.querySelectorAll('[data-edit-prod]').forEach(row=>row.addEventListener('click', (ev)=>{
      if(ev.target.closest('button')) return;
      const prod = STATE.products.find(p=>p.id===row.getAttribute('data-edit-prod'));
      if(prod) openProductForm(prod, paintProducts);
    }));
    // quick shortcut: cycle ปุ๋ย -> ยา -> อื่นๆ without opening the editor
    prodList.querySelectorAll('[data-move]').forEach(b=>b.addEventListener('click', ()=>{
      const prod = STATE.products.find(p=>p.id===b.getAttribute('data-move'));
      if(!prod) return;
      const i = CARE_CATS.findIndex(c=>c.key===catFromProductType(prod.type));
      prod.type = CARE_CATS[(i+1)%CARE_CATS.length].product;
      touch(prod); saveState(); paintProducts();
    }));
  }
  paintProducts();

  mountCombo(document.getElementById('stProductCombo'), {
    placeholder:'พิมพ์ชื่อปุ๋ย/ยา แล้วเลือกว่าเป็นอะไร',
    getOptions:()=>STATE.products.map(p=>p.name),
    getOptionMeta:(name)=>{ const k = productCategory(name); return k ? catTagHtml(k) : ''; },
    addOptions: CARE_CATS.map(c=>({key:c.key, label:c.label, tag:catTagHtml(c.key)})),
    onPick:(v, addCat)=>{
      if(!v || !addCat) return;
      if(!STATE.products.some(p=>p.name===v)){
        STATE.products.push(touch({id:uid(), name:v, type: catByKey(addCat).product}));
        saveState(); paintProducts();
      }
      document.getElementById('stProductCombo').querySelector('.combo-input').value='';
    }
  });

  document.getElementById('stPickLocation').addEventListener('click', ()=>{
    openMapPicker(g.lat, g.lng, (lat,lng)=>{ g.lat=lat; g.lng=lng; touch(g); saveState(); toast('ตั้งตำแหน่งสวนแล้ว'); renderSettings(); });
  });
  document.getElementById('stSaveGarden').addEventListener('click', ()=>{
    g.name = document.getElementById('stGardenName').value.trim();
    g.area = document.getElementById('stArea').value.trim();
    g.areaUnit = document.getElementById('stAreaUnit').value;
    g.startYear = document.getElementById('stStartYear').value.trim();
    touch(g);
    u.name = document.getElementById('stUserName').value.trim();
    u.role = document.getElementById('stUserRole').value.trim();
    saveState(); toast('บันทึกข้อมูลสวนแล้ว');
  });
  document.getElementById('stNotifToggle').addEventListener('click', (e)=>{
    STATE.settings.notifEnabled = !STATE.settings.notifEnabled;
    if(STATE.settings.notifEnabled && window.Notification && Notification.permission!=='granted'){ Notification.requestPermission(); }
    saveState(); renderSettings();
  });
  document.getElementById('stExport').addEventListener('click', ()=>{
    const blob = new Blob([JSON.stringify(STATE,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href=url; a.download = `สำรองข้อมูลสวน-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
    toast('ส่งออกไฟล์สำรองข้อมูลแล้ว');
  });
  document.getElementById('stImport').addEventListener('click', ()=>document.getElementById('stImportFile').click());
  document.getElementById('stImportFile').addEventListener('change', (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = async ()=>{
      try{
        const data = JSON.parse(reader.result);
        if(!data || typeof data!=='object') throw new Error('bad file');
        const ok = await confirmDialog({ title:'นำเข้าข้อมูลนี้?',
          message:'ข้อมูลปัจจุบันทั้งหมดในเครื่องจะถูกแทนที่ด้วยไฟล์นี้',
          confirmText:'นำเข้า', danger:false });
        if(!ok) return;
        STATE = Object.assign(defaultState(), data);
        saveState(); toast('นำเข้าข้อมูลสำเร็จ'); showView('dashboard');
      }catch(err){ toast('ไฟล์ไม่ถูกต้อง นำเข้าไม่สำเร็จ'); }
    };
    reader.readAsText(file);
  });
  document.getElementById('stReset').addEventListener('click', async ()=>{
    const once = await confirmDialog({ title:'ล้างข้อมูลทั้งหมด?',
      message:'ข้อมูลสวนทั้งหมดในเครื่องนี้จะถูกลบถาวร ย้อนกลับไม่ได้ — แนะนำให้กดส่งออกข้อมูลสำรองไว้ก่อน',
      confirmText:'ล้างข้อมูล' });
    if(!once) return;
    const twice = await confirmDialog({ title:'ยืนยันอีกครั้ง', message:'ลบข้อมูลทั้งหมดถาวรใช่หรือไม่?', confirmText:'ลบถาวร' });
    if(!twice) return;
    localStorage.removeItem(STORE_KEY);
    location.reload();
  });
}

/* ============================== QUICK-ADD (FAB) ============================== */
function openQuickAdd(){
  const sheet = document.getElementById('sheetQuick');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h3>เพิ่มบันทึกใหม่</h3><button class="icon-btn" id="qaClose">${ICONS.close}</button></div>
    <div class="quick-menu">
      <div class="quick-item" data-qa="care"><div class="qi-icon qi-care">💧</div><div><div class="qi-title">บันทึกการดูแล</div><div class="qi-sub">พ่นยา · ใส่ปุ๋ย · รดน้ำ</div></div></div>
      <div class="quick-item" data-qa="health"><div class="qi-icon qi-health">🐛</div><div><div class="qi-title">บันทึกปัญหาสุขภาพ</div><div class="qi-sub">โรค แมลง หรือความผิดปกติของต้นไม้</div></div></div>
      <div class="quick-item" data-qa="harvest"><div class="qi-icon qi-harvest">🧺</div><div><div class="qi-title">บันทึกเก็บเกี่ยว</div><div class="qi-sub">น้ำหนัก จำนวน ราคา รายได้</div></div></div>
      <div class="quick-item" data-qa="task"><div class="qi-icon qi-task">📅</div><div><div class="qi-title">เพิ่มงานในปฏิทิน</div><div class="qi-sub">วางแผนงานดูแลล่วงหน้า</div></div></div>
    </div>
  `;
  document.getElementById('qaClose').addEventListener('click', ()=>closeSheet('sheetQuick'));
  sheet.querySelectorAll('[data-qa]').forEach(el=>el.addEventListener('click', ()=>{
    closeSheet('sheetQuick');
    const t = el.getAttribute('data-qa');
    setTimeout(()=>{
      if(t==='care') openCareForm(null, STATE.plots[0]?STATE.plots[0].id:null);
      if(t==='health') openHealthForm(null, STATE.plots[0]?STATE.plots[0].id:null);
      if(t==='harvest') openHarvestForm(null, STATE.plots[0]?STATE.plots[0].id:null);
      if(t==='task') openTaskForm(null);
    }, 200);
  }));
  openSheet('sheetQuick');
}

/* ============================== MENU VIEW ============================== */
function renderMenu(){
  const root = document.getElementById('view-menu');
  root.innerHTML = `
    <h2 style="font-size:19px; margin-bottom:14px">เมนู</h2>
    <div class="list">
      <div class="row-card" data-go="buyers"><div class="row-icon tint-lavender" style="color:var(--lavender-deep)">${ICONS.buyers}</div><div class="row-main"><div class="row-title">ผู้รับซื้อ</div><div class="row-sub">${STATE.buyers.length} ราย</div></div><div class="row-end">${ICONS.arrowR}</div></div>
      <div class="row-card" data-go="weather"><div class="row-icon tint-peach" style="color:var(--peach-deep)">${ICONS.weather}</div><div class="row-main"><div class="row-title">สภาพอากาศ / สมาร์ทสวน</div><div class="row-sub">พยากรณ์อากาศประจำสวน</div></div><div class="row-end">${ICONS.arrowR}</div></div>
      <div class="row-card" data-go="settings"><div class="row-icon tint-pink" style="color:var(--pink-deep)">${ICONS.settings}</div><div class="row-main"><div class="row-title">ตั้งค่า</div><div class="row-sub">ข้อมูลสวน สำรองข้อมูล</div></div><div class="row-end">${ICONS.arrowR}</div></div>
    </div>
  `;
  root.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click', ()=>showView(el.getAttribute('data-go'))));
}

/* ============================== WIZARD (first-run onboarding) ============================== */
let wizardStep = 1;
const WIZARD_TOTAL = 6;
let wizardData = null;
function freshWizardData(){
  return { user:{name:'',role:''}, garden:{name:'',lat:null,lng:null,area:'',areaUnit:'ไร่',startYear:'', wateringFreqDays:'', fertilizingFreqDays:''}, plots:[], products:[], buyers:[], harvestSeasons:{} };
}

function startWizard(){
  wizardData = freshWizardData();
  wizardStep = 1;
  document.getElementById('view-dashboard').style.display='none';
  document.getElementById('wizardRoot').classList.add('open');
  renderWizardStep();
}

function wizardShell(inner){
  const segs = Array.from({length:WIZARD_TOTAL}).map((_,i)=>`<div class="seg ${i<wizardStep?'done':''}"></div>`).join('');
  return `<div class="wizard"><div class="wizard-progress">${segs}</div><div class="wizard-body">${inner}</div>
    <div class="wizard-foot" id="wizFoot"></div></div>`;
}

function renderWizardStep(){
  const root = document.getElementById('wizardRoot');
  let inner = "";
  if(wizardStep===1){
    inner = `
      <div class="wizard-eyebrow">ขั้นตอน 1 จาก ${WIZARD_TOTAL}</div>
      <div class="wizard-title">สวัสดีครับ 👋</div>
      <div class="wizard-desc">มาเริ่มตั้งค่าแอปจัดการสวนกัน ขอทราบข้อมูลผู้ใช้ก่อนนะครับ</div>
      <div class="field"><label>ชื่อของคุณ</label><input type="text" id="wUserName" value="${escapeHtml(wizardData.user.name)}" placeholder="ชื่อเล่นหรือชื่อจริง"></div>
      <div class="field"><label>บทบาทในสวน</label><input type="text" id="wUserRole" value="${escapeHtml(wizardData.user.role)}" placeholder="เช่น เจ้าของสวน, ผู้ดูแลสวน"></div>
    `;
  } else if(wizardStep===2){
    const g = wizardData.garden;
    inner = `
      <div class="wizard-eyebrow">ขั้นตอน 2 จาก ${WIZARD_TOTAL}</div>
      <div class="wizard-title">ข้อมูลสวน</div>
      <div class="wizard-desc">ตั้งชื่อสวนและระบุตำแหน่ง/ขนาดพื้นที่</div>
      <div class="field"><label>ชื่อสวน</label><input type="text" id="wGardenName" value="${escapeHtml(g.name)}" placeholder="เช่น สวนคุณแม่, สวนริมคลอง"></div>
      <div class="row2">
        <div class="field"><label>พื้นที่</label><input type="number" id="wArea" value="${g.area}"></div>
        <div class="field"><label>หน่วย</label><select id="wAreaUnit"><option ${g.areaUnit==='ไร่'?'selected':''}>ไร่</option><option ${g.areaUnit==='งาน'?'selected':''}>งาน</option><option ${g.areaUnit==='เฮกตาร์'?'selected':''}>เฮกตาร์</option></select></div>
      </div>
      <div class="field"><label>ปีที่เริ่มทำสวน (พ.ศ.)</label><input type="number" id="wStartYear" value="${g.startYear}"></div>
      <div class="field" style="margin-bottom:0">
        <label>ตำแหน่งสวน</label>
        <button class="btn btn-ghost btn-block" id="wPickLoc">${ICONS.pin} ${g.lat!=null?`พิกัด ${Number(g.lat).toFixed(4)}, ${Number(g.lng).toFixed(4)}`:'ปักหมุดตำแหน่งสวน'}</button>
        <div class="hint">ใช้สำหรับแสดงพยากรณ์อากาศของสวน — ข้ามได้และตั้งภายหลังในเมนูตั้งค่า</div>
      </div>
    `;
  } else if(wizardStep===3){
    inner = `
      <div class="wizard-eyebrow">ขั้นตอน 3 จาก ${WIZARD_TOTAL}</div>
      <div class="wizard-title">แปลง / ต้นไม้</div>
      <div class="wizard-desc">เพิ่มแปลงปลูกในสวน (เพิ่มได้หลายแปลง ภายหลังก็แก้ไขได้)</div>
      <div class="field"><label>ชื่อแปลง</label><input type="text" id="wPlotName" placeholder="เช่น แปลงหน้าบ้าน"></div>
      <div class="field"><label>ชนิดผลไม้</label><div id="wPlotFruitCombo"></div></div>
      <div class="row2">
        <div class="field"><label>จำนวนต้น</label><input type="number" id="wPlotCount" placeholder="0"></div>
        <div class="field"><label>ปีที่ปลูก (พ.ศ.)</label><input type="number" id="wPlotYear" placeholder="เช่น 2560"></div>
      </div>
      <button class="btn btn-soft btn-block" id="wPlotAdd">${ICONS.plus} เพิ่มแปลงนี้</button>
      <div class="mini-list" id="wPlotList"></div>
    `;
  } else if(wizardStep===4){
    const g = wizardData.garden;
    inner = `
      <div class="wizard-eyebrow">ขั้นตอน 4 จาก ${WIZARD_TOTAL}</div>
      <div class="wizard-title">ปุ๋ย/ยาประจำ &amp; ความถี่</div>
      <div class="wizard-desc">รายการปุ๋ย/ยาที่ใช้เป็นประจำ และความถี่ในการดูแล (ใช้สร้างงานในปฏิทินให้อัตโนมัติ)</div>
      <div class="field"><label>เพิ่มปุ๋ย/ยาที่ใช้ประจำ</label><div id="wProductCombo"></div>
        <div class="hint">พิมพ์ชื่อแล้วเลือกว่าเป็น ปุ๋ย / ยา / อื่นๆ</div></div>
      <div class="mini-list" id="wProductList"></div>
      <div class="row2" style="margin-top:6px">
        <div class="field"><label>รดน้ำทุกกี่วัน</label><input type="number" id="wWaterFreq" value="${g.wateringFreqDays}" placeholder="เช่น 3"></div>
        <div class="field"><label>ใส่ปุ๋ยทุกกี่วัน</label><input type="number" id="wFertFreq" value="${g.fertilizingFreqDays}" placeholder="เช่น 30"></div>
      </div>
      <div class="hint">ถ้ากรอกไว้ ระบบจะสร้างงานแจ้งเตือนในปฏิทินให้อัตโนมัติสำหรับทุกแปลง</div>
    `;
  } else if(wizardStep===5){
    inner = `
      <div class="wizard-eyebrow">ขั้นตอน 5 จาก ${WIZARD_TOTAL}</div>
      <div class="wizard-title">ผู้รับซื้อ &amp; ฤดูเก็บเกี่ยว</div>
      <div class="wizard-desc">เพิ่มรายชื่อผู้รับซื้อผลผลิต และช่วงฤดูเก็บเกี่ยวของแต่ละชนิดผลไม้</div>
      <div class="field"><label>ชื่อผู้รับซื้อ</label><input type="text" id="wBuyerName" placeholder="ชื่อร้าน/ผู้รับซื้อ"></div>
      <div class="field"><label>เบอร์โทร</label><input type="text" id="wBuyerPhone" placeholder="08x-xxx-xxxx"></div>
      <button class="btn btn-soft btn-block" id="wBuyerAdd">${ICONS.plus} เพิ่มผู้รับซื้อนี้</button>
      <div class="mini-list" id="wBuyerList"></div>
      <div class="divider"></div>
      <div id="wSeasonFields"></div>
    `;
  } else if(wizardStep===6){
    const fruitTypes = Array.from(new Set(wizardData.plots.map(p=>p.fruitType).filter(Boolean)));
    inner = `
      <div class="wizard-eyebrow">ขั้นตอนสุดท้าย</div>
      <div class="wizard-title">ตรวจสอบข้อมูล</div>
      <div class="wizard-desc">ตรวจสอบก่อนเริ่มใช้งานแอป — แก้ไขเพิ่มเติมได้ภายหลังทุกจุด</div>
      <div class="card" style="margin-bottom:10px">
        <div class="muted" style="margin-bottom:4px">ผู้ใช้</div>
        <div>${escapeHtml(wizardData.user.name||'-')} ${wizardData.user.role?('· '+escapeHtml(wizardData.user.role)):''}</div>
      </div>
      <div class="card" style="margin-bottom:10px">
        <div class="muted" style="margin-bottom:4px">สวน</div>
        <div>${escapeHtml(wizardData.garden.name||'-')} · ${wizardData.garden.area||'?'} ${escapeHtml(wizardData.garden.areaUnit)} ${wizardData.garden.lat!=null?'· ปักหมุดแล้ว 📍':''}</div>
      </div>
      <div class="card" style="margin-bottom:10px">
        <div class="muted" style="margin-bottom:4px">แปลง (${wizardData.plots.length})</div>
        ${wizardData.plots.map(p=>`<div class="tag-row" style="margin-bottom:4px"><span class="tag">${escapeHtml(p.name)} · ${escapeHtml(p.fruitType||'-')}</span></div>`).join('') || '<span class="muted">ยังไม่ได้เพิ่มแปลง</span>'}
      </div>
      <div class="card" style="margin-bottom:10px">
        <div class="muted" style="margin-bottom:4px">ปุ๋ย/ยาประจำ (${wizardData.products.length})</div>
        <div class="tag-row">${wizardData.products.map(p=>`<span class="tag">${escapeHtml(p.name)}</span>`).join('') || '<span class="muted">-</span>'}</div>
      </div>
      <div class="card">
        <div class="muted" style="margin-bottom:4px">ผู้รับซื้อ (${wizardData.buyers.length})</div>
        <div class="tag-row">${wizardData.buyers.map(b=>`<span class="tag">${escapeHtml(b.name)}</span>`).join('') || '<span class="muted">-</span>'}</div>
      </div>
    `;
  }
  root.innerHTML = wizardShell(inner);
  wireWizardStep();
  const foot = document.getElementById('wizFoot');
  foot.innerHTML = `
    ${wizardStep>1?`<button class="btn btn-ghost" id="wizBack">ย้อนกลับ</button>`:'<div></div>'}
    <button class="btn btn-primary btn-block" id="wizNext">${wizardStep===WIZARD_TOTAL?'เริ่มใช้งานแอป 🌱':'ถัดไป'}</button>
  `;
  if(wizardStep>1) document.getElementById('wizBack').addEventListener('click', ()=>{ wizardStep--; renderWizardStep(); });
  document.getElementById('wizNext').addEventListener('click', onWizardNext);
}

function wireWizardStep(){
  if(wizardStep===2){
    document.getElementById('wPickLoc').addEventListener('click', ()=>{
      openMapPicker(wizardData.garden.lat, wizardData.garden.lng, (lat,lng)=>{
        wizardData.garden.lat=lat; wizardData.garden.lng=lng; toast('ระบุตำแหน่งแล้ว'); renderWizardStep();
      });
    });
  }
  if(wizardStep===3){
    mountCombo(document.getElementById('wPlotFruitCombo'), { placeholder:'เช่น มะม่วง, ทุเรียน', getOptions:()=>['มะม่วง','ทุเรียน','เงาะ','ลำไย','มังคุด','ลองกอง'] });
    function paintPlots(){
      document.getElementById('wPlotList').innerHTML = wizardData.plots.map((p,i)=>`
        <div class="mini-row"><div><div class="mr-text">${escapeHtml(p.name)}</div><div class="mr-sub">${escapeHtml(p.fruitType||'')} · ${p.treeCount||0} ต้น</div></div><button class="mini-remove" data-i="${i}">ลบ</button></div>
      `).join('');
      document.getElementById('wPlotList').querySelectorAll('[data-i]').forEach(b=>b.addEventListener('click', ()=>{
        wizardData.plots.splice(Number(b.getAttribute('data-i')),1); paintPlots();
      }));
    }
    paintPlots();
    document.getElementById('wPlotAdd').addEventListener('click', ()=>{
      const name = document.getElementById('wPlotName').value.trim();
      if(!name){ toast('กรุณาใส่ชื่อแปลง'); return; }
      const fruitType = document.getElementById('wPlotFruitCombo').querySelector('.combo-input').value.trim();
      wizardData.plots.push({ id:uid(), name, fruitType, treeCount:Number(document.getElementById('wPlotCount').value)||0, plantingYear:document.getElementById('wPlotYear').value.trim() });
      document.getElementById('wPlotName').value=''; document.getElementById('wPlotCount').value=''; document.getElementById('wPlotYear').value='';
      paintPlots(); toast('เพิ่มแปลงแล้ว');
    });
  }
  if(wizardStep===4){
    function paintProducts(){
      // grouped by category, same as the settings list
      document.getElementById('wProductList').innerHTML = CARE_CATS.map(c=>{
        const inCat = wizardData.products
          .map((p,i)=>({p,i}))
          .filter(x=>catFromProductType(x.p.type)===c.key);
        if(!inCat.length) return '';
        return `<div class="prod-group">
          <div class="prod-head cat-${c.key}"><span class="cat-dot"></span>${c.label} <span class="cnt">${inCat.length}</span></div>
          ${inCat.map(x=>`<div class="mini-row cat-edge cat-${c.key}"><span class="mr-text">${escapeHtml(x.p.name)}</span>
            <button class="mini-remove" data-i="${x.i}">ลบ</button></div>`).join('')}
        </div>`;
      }).join('');
      document.getElementById('wProductList').querySelectorAll('[data-i]').forEach(b=>b.addEventListener('click', ()=>{
        wizardData.products.splice(Number(b.getAttribute('data-i')),1); paintProducts();
      }));
    }
    paintProducts();
    mountCombo(document.getElementById('wProductCombo'), {
      placeholder:'พิมพ์ชื่อ แล้วเลือกว่าเป็นปุ๋ยหรือยา',
      getOptions:()=>wizardData.products.map(p=>p.name),
      getOptionMeta:(name)=>{ const p = wizardData.products.find(x=>x.name===name);
        return p ? catTagHtml(catFromProductType(p.type)) : ''; },
      addOptions: CARE_CATS.map(c=>({key:c.key, label:c.label, tag:catTagHtml(c.key)})),
      onPick:(v, addCat)=>{
        if(!v || !addCat) return;
        if(!wizardData.products.some(p=>p.name===v)){
          wizardData.products.push({id:uid(), name:v, type: catByKey(addCat).product});
          paintProducts();
        }
        document.getElementById('wProductCombo').querySelector('.combo-input').value='';
      }
    });
  }
  if(wizardStep===5){
    function paintBuyers(){
      document.getElementById('wBuyerList').innerHTML = wizardData.buyers.map((b,i)=>`
        <div class="mini-row"><span class="mr-text">${escapeHtml(b.name)}</span><button class="mini-remove" data-i="${i}">ลบ</button></div>
      `).join('');
      document.getElementById('wBuyerList').querySelectorAll('[data-i]').forEach(b=>b.addEventListener('click', ()=>{
        wizardData.buyers.splice(Number(b.getAttribute('data-i')),1); paintBuyers();
      }));
    }
    paintBuyers();
    document.getElementById('wBuyerAdd').addEventListener('click', ()=>{
      const name = document.getElementById('wBuyerName').value.trim();
      if(!name){ toast('กรุณาใส่ชื่อผู้รับซื้อ'); return; }
      wizardData.buyers.push({ id:uid(), name, phone:document.getElementById('wBuyerPhone').value.trim() });
      document.getElementById('wBuyerName').value=''; document.getElementById('wBuyerPhone').value='';
      paintBuyers(); toast('เพิ่มผู้รับซื้อแล้ว');
    });
    const fruitTypes = Array.from(new Set(wizardData.plots.map(p=>p.fruitType).filter(Boolean)));
    const sf = document.getElementById('wSeasonFields');
    if(fruitTypes.length){
      sf.innerHTML = `<label style="display:block;font-size:12.5px;color:var(--text-soft);margin-bottom:6px;font-weight:600">ฤดูเก็บเกี่ยว (ไม่บังคับ)</label>` +
        fruitTypes.map(f=>`<div class="field"><label>${escapeHtml(f)}</label><input type="text" data-season="${escapeHtml(f)}" value="${escapeHtml(wizardData.harvestSeasons[f]||'')}" placeholder="เช่น มี.ค.-พ.ค."></div>`).join('');
      sf.querySelectorAll('[data-season]').forEach(inp=>inp.addEventListener('input', ()=>{ wizardData.harvestSeasons[inp.getAttribute('data-season')] = inp.value; }));
    } else { sf.innerHTML = ''; }
  }
}

function onWizardNext(){
  if(wizardStep===1){
    wizardData.user.name = document.getElementById('wUserName').value.trim();
    wizardData.user.role = document.getElementById('wUserRole').value.trim();
  } else if(wizardStep===2){
    const g = wizardData.garden;
    g.name = document.getElementById('wGardenName').value.trim();
    g.area = document.getElementById('wArea').value.trim();
    g.areaUnit = document.getElementById('wAreaUnit').value;
    g.startYear = document.getElementById('wStartYear').value.trim();
    if(!g.name){ toast('กรุณาใส่ชื่อสวน'); return; }
  } else if(wizardStep===4){
    wizardData.garden.wateringFreqDays = document.getElementById('wWaterFreq').value.trim();
    wizardData.garden.fertilizingFreqDays = document.getElementById('wFertFreq').value.trim();
  } else if(wizardStep===6){
    finishWizard();
    return;
  }
  wizardStep++;
  renderWizardStep();
}

function finishWizard(){
  STATE.user = wizardData.user;
  STATE.garden = touch(Object.assign(STATE.garden, wizardData.garden));
  STATE.plots = wizardData.plots.map(p=>touch({ id:p.id, name:p.name, fruitType:p.fruitType, variety:'', treeCount:p.treeCount, plantingYear:p.plantingYear, notes:'' }));
  STATE.products = wizardData.products.map(touch);
  STATE.buyers = wizardData.buyers.map(touch);
  STATE.garden.harvestSeasons = wizardData.harvestSeasons;
  // auto-create recurring tasks from frequencies
  const wf = Number(wizardData.garden.wateringFreqDays)||0;
  const ff = Number(wizardData.garden.fertilizingFreqDays)||0;
  STATE.plots.forEach(p=>{
    if(wf>0) STATE.tasks.push(touch({ id:uid(), title:`รดน้ำ · ${p.name}`, plotId:p.id, type:'water', dueDate:todayISO(), recurrenceDays:wf, done:false }));
    if(ff>0) STATE.tasks.push(touch({ id:uid(), title:`ใส่ปุ๋ย · ${p.name}`, plotId:p.id, type:'fertilize', dueDate:todayISO(), recurrenceDays:ff, done:false }));
  });
  STATE.meta.onboarded = true;
  saveState();
  document.getElementById('wizardRoot').classList.remove('open');
  toast('ตั้งค่าเสร็จสิ้น ยินดีต้อนรับ! 🌳');
  enterApp();
}

/* ============================== VIEW DISPATCH ============================== */
window.__renderView = function(name){
  if(name==='dashboard') renderDashboard();
  else if(name==='plots') renderPlots();
  else if(name==='plotDetail') renderPlotDetail();
  else if(name==='calendar') renderCalendar();
  else if(name==='analysis') renderAnalysis();
  else if(name==='menu') renderMenu();
  else if(name==='buyers') renderBuyers();
  else if(name==='weather') renderWeather();
  else if(name==='settings') renderSettings();
};

/* ============================== REMINDER CHECK (best-effort, in-app only) ============================== */
function checkReminders(){
  if(!STATE.settings.notifEnabled) return;
  if(!window.Notification || Notification.permission!=='granted') return;
  const today = todayISO();
  if(STATE.settings.lastNotifDate===today) return;
  const due = STATE.tasks.filter(t=>!t.done && t.dueDate<=today);
  if(due.length){
    try{ new Notification('สวนอัจฉริยะ', { body: `วันนี้มีงานที่ต้องทำ ${due.length} รายการ` }); }catch(e){}
    STATE.settings.lastNotifDate = today; saveState();
  }
}

/* ============================== BOOT ============================== */
function wireChrome(){
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn=>{
    btn.addEventListener('click', ()=>showView(btn.getAttribute('data-view')));
  });
  document.getElementById('fabAdd').addEventListener('click', openQuickAdd);
  document.getElementById('topMenuBtn').addEventListener('click', ()=>showView('menu'));
}

function enterApp(){
  document.getElementById('view-dashboard').style.display='';
  updateTopbar();
  showView('dashboard');
  setTimeout(checkReminders, 1500);
  setInterval(checkReminders, 10*60*1000);
}

function boot(){
  loadState();
  updateTopbar();
  if(!STATE.meta.onboarded){
    document.getElementById('view-dashboard').style.display='none';
    startWizard();
    return;
  }
  enterApp();
}

document.addEventListener('DOMContentLoaded', ()=>{
  wireChrome();
  boot();
});
window.__boot = boot;


/* ===================================================================
   สวนอัจฉริยะ — Cloud layer (Supabase)

   Design: local-first. The app always reads and writes localStorage, so it
   keeps working with no signal out in the orchard. Supabase is a sync target,
   never a dependency — if the library, the network, or the login is missing,
   every feature still works and changes queue up until the next sync.

   Conflict rule: last write wins per row, compared on updated_at.
   =================================================================== */

/* Connection details live in config.js, not here, so that updating the app
   (replacing this file) can never wipe the keys the user pasted in. */
const SB_CFG = window.SAG_CONFIG || {};
const SUPABASE_URL      = SB_CFG.SUPABASE_URL      || 'PASTE_SUPABASE_URL_HERE';
const SUPABASE_ANON_KEY = SB_CFG.SUPABASE_ANON_KEY || 'PASTE_SUPABASE_ANON_KEY_HERE';

const SB_LIB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

function isCloudConfigured(){
  return /^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 30;
}

let sb = null;              // supabase client
let sbSession = null;       // current auth session
let syncTimer = null;
let syncing = false;
let syncStatus = 'offline'; // offline | ready | syncing | ok | error
let syncMessage = '';

/* Local array  <->  database table. Column names are the snake_case of the
   local field names, so one generic converter covers every table. */
const TABLE_SPECS = [
  { key:'plots',        table:'plots' },
  { key:'products',     table:'products' },
  { key:'buyers',       table:'buyers' },
  { key:'careEvents',   table:'care_events' },
  { key:'healthIssues', table:'health_issues' },
  { key:'harvests',     table:'harvests' },
  { key:'tasks',        table:'tasks' }
];
const TABLE_BY_NAME = {};
TABLE_SPECS.forEach(s=>{ TABLE_BY_NAME[s.table] = s; });

const NON_COLUMN_KEYS = ['dirty'];

function toSnake(k){ return k.replace(/[A-Z]/g, c=>'_'+c.toLowerCase()); }
function toCamel(k){ return k.replace(/_([a-z])/g, (_,c)=>c.toUpperCase()); }

function rowFromLocal(obj, gardenId){
  const row = { garden_id: gardenId, deleted: false };
  Object.keys(obj).forEach(k=>{
    if(NON_COLUMN_KEYS.includes(k)) return;
    row[k==='updated_at' ? 'updated_at' : toSnake(k)] = obj[k];
  });
  if(!row.updated_at) row.updated_at = new Date().toISOString();
  // empty date strings would fail a date column
  ['date','due_date','done_date','resolved_date'].forEach(c=>{ if(row[c]==='') row[c]=null; });
  return row;
}
function localFromRow(row){
  const obj = {};
  Object.keys(row).forEach(k=>{
    if(k==='garden_id' || k==='deleted') return;
    obj[k==='updated_at' ? 'updated_at' : toCamel(k)] = row[k];
  });
  return obj;
}

function setSyncStatus(st, msg){
  syncStatus = st; syncMessage = msg||'';
  const dot = document.getElementById('syncDot');
  if(dot){
    dot.className = 'sync-dot ' + st;
    // nothing to report = no mark in the header; and if cloud sync was never
    // set up there is no status worth showing at all
    const quiet = !isCloudConfigured() || ((st==='ready'||st==='ok') && !pendingCount());
    dot.style.display = quiet ? 'none' : 'inline-block';
  }
  if(typeof renderCloudSection === 'function' && document.getElementById('cloudSection')) renderCloudSection();
}

function pendingCount(){
  let n = (STATE.tombstones||[]).filter(t=>t.dirty).length;
  TABLE_SPECS.forEach(spec=>{ n += (STATE[spec.key]||[]).filter(r=>r.dirty).length; });
  if(STATE.garden && STATE.garden.dirty) n++;
  return n;
}

/* ---------- library + client ---------- */
function loadSupabaseLib(){
  if(window.supabase && window.supabase.createClient) return Promise.resolve(true);
  return new Promise(resolve=>{
    const sc = document.createElement('script');
    sc.src = SB_LIB_URL;
    sc.onload = ()=>resolve(!!(window.supabase && window.supabase.createClient));
    sc.onerror = ()=>resolve(false);
    document.head.appendChild(sc);
    setTimeout(()=>resolve(!!(window.supabase && window.supabase.createClient)), 8000);
  });
}

async function initCloud(){
  if(!isCloudConfigured()){ setSyncStatus('offline','ยังไม่ได้ใส่ค่า Supabase ในโค้ด'); return false; }
  const ok = await loadSupabaseLib();
  if(!ok){ setSyncStatus('offline','โหลดไลบรารีไม่ได้ (ออฟไลน์อยู่)'); return false; }
  try{
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth:{ persistSession:true, autoRefreshToken:true, storageKey:'sag_auth' }
    });
  }catch(e){ setSyncStatus('error','ค่า Supabase ในโค้ดไม่ถูกต้อง'); return false; }

  try{
    const { data } = await sb.auth.getSession();
    sbSession = data ? data.session : null;
  }catch(e){ sbSession = null; }

  if(sb.auth.onAuthStateChange){
    sb.auth.onAuthStateChange((_evt, session)=>{
      sbSession = session;
      setSyncStatus(session ? 'ready' : 'offline', session ? '' : 'ยังไม่ได้เข้าสู่ระบบ');
    });
  }
  setSyncStatus(sbSession ? 'ready' : 'offline', sbSession ? '' : 'ยังไม่ได้เข้าสู่ระบบ');
  if(sbSession) syncNow();
  return true;
}

/* ---------- auth ---------- */
async function cloudSignIn(email, password){
  if(!sb) { const ok = await initCloud(); if(!ok) return {error:{message:'เชื่อมต่อไม่ได้'}}; }
  const res = await sb.auth.signInWithPassword({ email, password });
  if(!res.error){ sbSession = res.data.session; await syncNow(); }
  return res;
}
async function cloudSignUp(email, password){
  if(!sb) { const ok = await initCloud(); if(!ok) return {error:{message:'เชื่อมต่อไม่ได้'}}; }
  const res = await sb.auth.signUp({ email, password });
  if(!res.error && res.data.session){ sbSession = res.data.session; await syncNow(); }
  return res;
}
async function cloudSignOut(){
  if(sb) await sb.auth.signOut();
  sbSession = null;
  setSyncStatus('offline','ออกจากระบบแล้ว');
}

/* ---------- garden row ---------- */
async function ensureGarden(){
  const uid_ = sbSession.user.id;
  // already linked?
  if(STATE.cloud.gardenId){
    const { data } = await sb.from('gardens').select('id').eq('id', STATE.cloud.gardenId).maybeSingle();
    if(data) return STATE.cloud.gardenId;
  }
  // any garden this user can see?
  const { data: rows, error } = await sb.from('gardens').select('*').eq('deleted', false).limit(1);
  if(error) throw error;
  if(rows && rows.length){
    STATE.cloud.gardenId = rows[0].id;
    const g = rows[0];
    // adopt cloud garden details if local is still blank
    if(!STATE.garden.name && g.name){
      STATE.garden = Object.assign(STATE.garden, {
        name:g.name, lat:g.lat, lng:g.lng, area:g.area, areaUnit:g.area_unit,
        startYear:g.start_year, harvestSeasons:g.harvest_seasons||{}, updated_at:g.updated_at
      });
    }
    saveState();
    return STATE.cloud.gardenId;
  }
  // none yet — create one from local data and push everything up
  const gid = uid();
  const { error: insErr } = await sb.from('gardens').insert({
    id: gid, owner_id: uid_,
    name: STATE.garden.name || 'สวนของฉัน',
    lat: STATE.garden.lat, lng: STATE.garden.lng,
    area: STATE.garden.area || null, area_unit: STATE.garden.areaUnit || null,
    start_year: STATE.garden.startYear || null,
    harvest_seasons: STATE.garden.harvestSeasons || {},
    deleted: false,
    updated_at: new Date().toISOString()
  });
  if(insErr) throw insErr;
  STATE.cloud.gardenId = gid;
  markAllDirty();
  saveState();
  return gid;
}

function markAllDirty(){
  TABLE_SPECS.forEach(spec=>{ (STATE[spec.key]||[]).forEach(r=>{ r.dirty = true; if(!r.updated_at) r.updated_at = new Date().toISOString(); }); });
  if(STATE.garden) STATE.garden.dirty = true;
}

/* ---------- sync ---------- */
function scheduleSync(){
  if(!sb || !sbSession) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(()=>syncNow(), 2500);
}

async function syncNow(){
  if(syncing) return;
  if(!sb || !sbSession){ setSyncStatus(sb?'offline':'offline','ยังไม่ได้เข้าสู่ระบบ'); return; }
  if(!navigator.onLine){ setSyncStatus('offline','ออฟไลน์ — จะซิงก์ให้เมื่อมีเน็ต'); return; }
  syncing = true; setSyncStatus('syncing');
  try{
    const gardenId = await ensureGarden();
    let watermark = STATE.cloud.lastPull || '1970-01-01T00:00:00.000Z';
    let newWatermark = watermark;

    // 1) push the garden row itself
    if(STATE.garden && STATE.garden.dirty){
      const g = STATE.garden;
      const { error } = await sb.from('gardens').update({
        name:g.name||'', lat:g.lat, lng:g.lng, area:g.area||null, area_unit:g.areaUnit||null,
        start_year:g.startYear||null, harvest_seasons:g.harvestSeasons||{},
        updated_at:g.updated_at || new Date().toISOString()
      }).eq('id', gardenId);
      if(error) throw error;
      delete STATE.garden.dirty;
    }

    // 2) push dirty rows, table by table
    for(const spec of TABLE_SPECS){
      const dirty = (STATE[spec.key]||[]).filter(r=>r.dirty);
      if(!dirty.length) continue;
      const rows = dirty.map(r=>rowFromLocal(r, gardenId));
      const { error } = await sb.from(spec.table).upsert(rows, { onConflict:'id' });
      if(error) throw error;
      dirty.forEach(r=>{ delete r.dirty; });
    }

    // 3) push deletions as tombstones
    const deadRows = (STATE.tombstones||[]).filter(t=>t.dirty);
    for(const t of deadRows){
      const { error } = await sb.from(t.table)
        .upsert([{ id:t.id, garden_id:gardenId, deleted:true, updated_at:t.updated_at }], { onConflict:'id' });
      if(error) throw error;
      delete t.dirty;
    }

    // 4) pull anything changed elsewhere since the last watermark
    for(const spec of TABLE_SPECS){
      const { data, error } = await sb.from(spec.table).select('*')
        .eq('garden_id', gardenId).gt('updated_at', watermark);
      if(error) throw error;
      (data||[]).forEach(row=>{
        if(row.updated_at > newWatermark) newWatermark = row.updated_at;
        mergeRemoteRow(spec, row);
      });
    }

    // 5) pull garden row changes
    const { data: gRow } = await sb.from('gardens').select('*').eq('id', gardenId).maybeSingle();
    if(gRow && gRow.updated_at > (STATE.garden.updated_at||'') && !STATE.garden.dirty){
      STATE.garden = Object.assign(STATE.garden, {
        name:gRow.name, lat:gRow.lat, lng:gRow.lng, area:gRow.area, areaUnit:gRow.area_unit,
        startYear:gRow.start_year, harvestSeasons:gRow.harvest_seasons||{}, updated_at:gRow.updated_at
      });
      if(gRow.updated_at > newWatermark) newWatermark = gRow.updated_at;
    }

    STATE.cloud.lastPull = newWatermark;
    STATE.cloud.lastSyncAt = new Date().toISOString();
    // tombstones that have been pushed can be trimmed after a while
    STATE.tombstones = (STATE.tombstones||[]).filter(t=>t.dirty || (Date.now() - new Date(t.updated_at).getTime()) < 30*86400000);
    localStorage.setItem(STORE_KEY, JSON.stringify(STATE));
    setSyncStatus('ok');
    if(typeof refreshCurrentView === 'function') refreshCurrentView();
  }catch(e){
    console.warn('sync failed', e);
    setSyncStatus('error', (e && e.message) ? e.message : 'ซิงก์ไม่สำเร็จ');
  }finally{
    syncing = false;
  }
}

function mergeRemoteRow(spec, row){
  const list = STATE[spec.key] = STATE[spec.key] || [];
  const idx = list.findIndex(x=>x.id===row.id);
  const local = idx>=0 ? list[idx] : null;

  // never let a pull clobber an edit that hasn't been pushed yet
  if(local && local.dirty) return;

  if(row.deleted){
    if(idx>=0) list.splice(idx,1);
    const ts = (STATE.tombstones||[]).find(t=>t.table===spec.table && t.id===row.id);
    if(!ts){ STATE.tombstones.push({ table:spec.table, id:row.id, updated_at:row.updated_at, dirty:false }); }
    return;
  }
  const incoming = localFromRow(row);
  if(!local){ list.push(incoming); return; }
  if((row.updated_at||'') > (local.updated_at||'')) list[idx] = incoming;
}

/* ---------- login screen ----------
   Shown once at startup when the app is configured but nobody is signed in.
   Skippable on purpose: the orchard has dead spots, and a login wall would
   lock someone out of their own records while standing in it. */
let authMode = 'in'; // 'in' | 'up'

function showAuthScreen(mode){
  authMode = mode || 'in';
  const root = document.getElementById('authRoot');
  if(!root) return;
  const isUp = authMode==='up';

  root.innerHTML = `
    <svg class="auth-waves" viewBox="0 0 420 220" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0,0 H420 V96 C340,150 300,80 210,110 C120,140 70,96 0,132 Z" fill="rgba(255,255,255,.10)"/>
      <path d="M0,0 H420 V54 C330,110 280,44 190,74 C110,100 60,62 0,92 Z" fill="rgba(255,255,255,.08)"/>
    </svg>
    <svg class="auth-waves-b" viewBox="0 0 420 160" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0,160 H420 V60 C340,20 280,96 190,74 C110,54 60,110 0,86 Z" fill="rgba(255,255,255,.07)"/>
    </svg>

    <div class="auth-inner">
      <div class="auth-brand">
        <div class="auth-logo">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3c3.4 2.3 5.6 5.6 5.6 9.4A5.6 5.6 0 0 1 6.4 12.4C6.4 8.6 8.6 5.3 12 3Z"/><path d="M12 14v7"/>
          </svg>
        </div>
        <div class="a-name">สวนอัจฉริยะ</div>
        <div class="a-tag">จัดการและวิเคราะห์ต้นทุนสวนผลไม้</div>
      </div>

      <div class="auth-card">
        <h2>${isUp?'สร้างบัญชีใหม่':'ยินดีต้อนรับ'}</h2>
        <p class="a-sub">${isUp?'สมัครเพื่อเก็บข้อมูลสวนไว้บนคลาวด์':'เข้าสู่ระบบเพื่อใช้งานต่อ'}</p>

        <div class="field"><label>อีเมล</label>
          <input type="email" id="auEmail" placeholder="อีเมล" autocomplete="username"></div>
        <div class="field"><label>รหัสผ่าน</label>
          <input type="password" id="auPass" placeholder="รหัสผ่าน" autocomplete="${isUp?'new-password':'current-password'}"></div>
        ${isUp?`
          <div class="field"><label>ยืนยันรหัสผ่าน</label>
            <input type="password" id="auPass2" placeholder="ยืนยันรหัสผ่าน" autocomplete="new-password"></div>
          <label class="auth-terms"><input type="checkbox" id="auTerms"><span>ฉันยอมรับเงื่อนไขการใช้งาน และรับทราบว่าข้อมูลสวนจะถูกเก็บไว้บนคลาวด์</span></label>
        `:`
          <div class="auth-forgot">ลืมรหัสผ่าน? รีเซ็ตได้ที่ Supabase</div>
        `}

        <button class="btn btn-primary btn-block" id="auGo">${isUp?'สมัครใหม่':'เข้าสู่ระบบ'}</button>
        <div class="auth-note" id="auNote"></div>
        <div class="auth-alt">
          ${isUp?'มีบัญชีอยู่แล้ว? <b id="auSwap">เข้าสู่ระบบ</b>':'ยังไม่มีบัญชี? <b id="auSwap">สมัครใหม่</b>'}
        </div>
      </div>

      <button class="auth-skip" id="auSkip">ข้ามไปก่อน · ใช้แบบออฟไลน์</button>
    </div>
  `;
  root.classList.add('open');

  const $ = id=>document.getElementById(id);
  const note = m=>{ $('auNote').textContent = m||''; };

  $('auGo').addEventListener('click', async ()=>{
    const email = $('auEmail').value.trim(), pass = $('auPass').value;
    if(!email || !pass){ note('กรอกอีเมลและรหัสผ่านก่อน'); return; }
    if(isUp){
      if(pass.length < 6){ note('รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร'); return; }
      if(pass !== $('auPass2').value){ note('รหัสผ่านสองช่องไม่ตรงกัน'); return; }
      if(!$('auTerms').checked){ note('กรุณาติ๊กยอมรับเงื่อนไขการใช้งาน'); return; }
    }
    note('กำลังดำเนินการ...');
    const res = await (isUp ? cloudSignUp(email, pass) : cloudSignIn(email, pass));
    if(res.error){ note(translateAuthError(res.error.message)); return; }
    const msg = isUp ? 'สมัครและเข้าสู่ระบบแล้ว' : 'เข้าสู่ระบบแล้ว';
    note(msg);
    setTimeout(()=>{ hideAuthScreen(); toast(msg); }, 400);
  });
  $('auSwap').addEventListener('click', ()=>showAuthScreen(isUp?'in':'up'));
  $('auSkip').addEventListener('click', ()=>{ hideAuthScreen(); toast('ใช้งานแบบออฟไลน์ — ล็อกอินภายหลังได้ที่เมนู → ตั้งค่า'); });
}
function hideAuthScreen(){
  const root = document.getElementById('authRoot');
  if(root) root.classList.remove('open');
}
function translateAuthError(msg){
  const m = (msg||'').toLowerCase();
  if(m.includes('invalid login')) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
  if(m.includes('already registered')) return 'อีเมลนี้สมัครไว้แล้ว — กดเข้าสู่ระบบแทน';
  if(m.includes('email not confirmed')) return 'อีเมลยังไม่ยืนยัน — ปิด Confirm email ใน Supabase ก่อน';
  if(m.includes('password')) return 'รหัสผ่านสั้นเกินไป (อย่างน้อย 6 ตัวอักษร)';
  if(m.includes('failed to fetch') || m.includes('network')) return 'เชื่อมต่อไม่ได้ — ตรวจอินเทอร์เน็ต';
  return msg;
}

/* ---------- settings section ---------- */
function renderCloudSection(){
  const el = document.getElementById('cloudSection');
  if(!el) return;
  const c = STATE.cloud || {};
  const signedIn = !!sbSession;
  const pending = pendingCount();

  const statusMap = {
    offline:{ t:'ยังไม่ได้เชื่อมต่อ', cls:'badge-watch' },
    ready:{ t:'พร้อมซิงก์', cls:'badge-ok' },
    syncing:{ t:'กำลังซิงก์...', cls:'badge-ok' },
    ok:{ t:'ซิงก์แล้ว', cls:'badge-ok' },
    error:{ t:'ซิงก์ไม่สำเร็จ', cls:'badge-urgent' }
  };
  const st = statusMap[syncStatus] || statusMap.offline;

  el.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="flex-between" style="margin-bottom:10px">
        <span class="badge ${st.cls}">${st.t}</span>
        ${pending?`<span class="muted">รอซิงก์ ${pending} รายการ</span>`:''}
      </div>
      ${syncMessage?`<p class="muted" style="margin-bottom:10px">${escapeHtml(syncMessage)}</p>`:''}
      ${c.lastSyncAt?`<p class="muted" style="margin-bottom:10px">ซิงก์ล่าสุด: ${new Date(c.lastSyncAt).toLocaleString('th-TH')}</p>`:''}

      ${!isCloudConfigured() ? `
        <p class="muted">ยังไม่ได้ใส่ค่า Supabase — เปิดไฟล์ <span class="num">config.js</span>
        แล้วใส่ <span class="num">SUPABASE_URL</span> กับ <span class="num">SUPABASE_ANON_KEY</span><br>
        ตอนนี้แอปทำงานแบบออฟไลน์ ข้อมูลเก็บในเครื่องนี้เท่านั้น จึงยังไม่มีหน้าเข้าสู่ระบบ</p>
      ` : signedIn ? `
        <p class="muted" style="margin-bottom:12px">เข้าสู่ระบบด้วย <b>${escapeHtml(sbSession.user.email||'')}</b></p>
        <div style="display:flex; gap:10px">
          <button class="btn btn-primary btn-block btn-sm" id="cfgSync">ซิงก์เดี๋ยวนี้</button>
          <button class="btn btn-ghost btn-block btn-sm" id="cfgOut">ออกจากระบบ</button>
        </div>
        <div class="divider"></div>
        <label style="display:block;font-size:12.5px;color:var(--text-soft);margin-bottom:6px;font-weight:600">รหัสผู้ใช้ของฉัน (ใช้แชร์สวนให้คนอื่น)</label>
        <div class="num" style="font-size:11px; word-break:break-all; background:var(--surface-alt); padding:10px; border-radius:10px">${escapeHtml(sbSession.user.id)}</div>
      ` : `
        <p class="muted" style="margin-bottom:12px">ยังไม่ได้เข้าสู่ระบบ — ข้อมูลถูกเก็บไว้ในเครื่องนี้เท่านั้น</p>
        <button class="btn btn-primary btn-block btn-sm" id="cfgLogin">เข้าสู่ระบบ / สมัครใหม่</button>
      `}
    </div>
  `;

  const $ = id=>document.getElementById(id);
  if($('cfgSync')) $('cfgSync').addEventListener('click', async ()=>{ toast('กำลังซิงก์...'); await syncNow(); });
  if($('cfgOut')) $('cfgOut').addEventListener('click', async ()=>{ await cloudSignOut(); renderCloudSection(); });
  if($('cfgLogin')) $('cfgLogin').addEventListener('click', ()=>showAuthScreen());
}

/* sync when the connection comes back */
window.addEventListener('online', ()=>{ setSyncStatus('ready'); syncNow(); });
window.addEventListener('offline', ()=>setSyncStatus('offline','ออฟไลน์ — บันทึกไว้ในเครื่องก่อน'));

document.addEventListener('DOMContentLoaded', ()=>{
  setTimeout(async ()=>{
    const ready = await initCloud();
    // Only interrupt with a login screen when signing in could actually work.
    if(ready && !sbSession && navigator.onLine) showAuthScreen();
  }, 600);
});
