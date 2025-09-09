// templates/app.js
// SPA Controller client – continuous, linear valve animation synced to server timeline,
// multi-client polling, and skeuomorphic diagram components. Valves now support a
// configurable base rotation angle via the "base-angle" attribute or setBaseAngle().

let VALVE_MS = 30000; // overwritten by /status

// ===== Shared stylesheet loader for shadow roots =====
let diagramSheetPromise = null;
function adoptDiagramStyles(shadowRoot) {
  const supportsConstructable =
    'adoptedStyleSheets' in Document.prototype &&
    'replaceSync' in CSSStyleSheet.prototype;

  if (supportsConstructable) {
    if (!diagramSheetPromise) {
      diagramSheetPromise = fetch('diagram.css')
        .then(r => r.text())
        .then(css => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          return sheet;
        });
    }
    diagramSheetPromise.then(sheet => {
      const existing = shadowRoot.adoptedStyleSheets || [];
      if (!existing.includes(sheet)) {
        shadowRoot.adoptedStyleSheets = [...existing, sheet];
      }
    });
  } else {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'diagram.css';
    shadowRoot.appendChild(link);
  }
}

// ===== Slider + diagram refs =====
const slider = document.getElementById('slider');
const sr = document.getElementById('sr');
const diagram = document.getElementById('diagram');

function setSliderClass(cls){
  slider.classList.remove('on','off','working');
  slider.classList.add(cls);
  slider.setAttribute('aria-checked', String(cls === 'on'));
  sr.textContent = cls === 'on' ? 'Spa ON' : (cls === 'off' ? 'Spa OFF' : 'Spa transitioning');
}
function setSliderDisabled(disabled){ slider.setAttribute('aria-disabled', String(disabled)); }

async function fetchStatus(){
  const r = await fetch('/status', { cache: 'no-store' });
  if(!r.ok) throw new Error('status HTTP ' + r.status);
  return r.json();
}

// ===== Clock skew (serverNow vs client Date.now) =====
let clockSkewMs = 0;
function updateClockSkew(serverNow) {
  if (typeof serverNow !== 'number') return;
  const sample = Date.now() - serverNow; // positive if client clock is ahead
  clockSkewMs = clockSkewMs === 0 ? sample : (clockSkewMs * 0.8 + sample * 0.2);
}

// ===== Valve timeline from server (single source of truth) =====
let valveTimeline = null; // { moving, from, to, startMs, durationMs }
let valvePercentIdle = 0; // last stable percent (0..100) when not moving

function setTimelineFromStatus(j) {
  if (!j || !j.valve) return;
  updateClockSkew(j.serverNow);
  VALVE_MS = j.valveWaitMs ?? VALVE_MS;

  if (typeof j.valve.percent === 'number') {
    valvePercentIdle = j.valve.percent;
  }

  valveTimeline = {
    moving: !!j.valve.moving,
    from: Number(j.valve.from ?? valvePercentIdle),
    to: Number(j.valve.to ?? valvePercentIdle),
    startMs: Number(j.valve.startMs ?? 0),
    durationMs: Number(j.valve.durationMs ?? VALVE_MS),
  };
}

// ===== Apply server status to non-valve visuals + slider =====
async function applyStatus(j){
  setTimelineFromStatus(j);

  if (j.state === 'on') {
    diagram.setPump('on', 'high');
    diagram.setHeater(true);
    setSliderClass('on');
    setSliderDisabled(false);
  } else if (j.state === 'off') {
    diagram.setPump('off', 'off');
    diagram.setHeater(false);
    setSliderClass('off');
    setSliderDisabled(false);
  } else { // working
    if (j.target === 'on') {
      diagram.setPump('on', 'low');
      diagram.setHeater(true);
    } else {
      diagram.setPump('off', 'off');
      diagram.setHeater(false);
    }
    setSliderClass('working');
    setSliderDisabled(true);
  }
}

// ===== Continuous polling so multiple clients stay in sync =====
let pollTimer = null;
async function pollLoop(intervalMs = 1000, idleMs = 3000){
  try {
    const j = await fetchStatus();
    await applyStatus(j);
    const next = (j.busy || j.state === 'working') ? intervalMs : idleMs;
    pollTimer = setTimeout(() => pollLoop(intervalMs, idleMs), next);
  } catch {
    pollTimer = setTimeout(() => pollLoop(intervalMs, idleMs), 4000);
  }
}

// ===== RAF loop: render valve position from server timeline (no resets) =====
function startValveRaf() {
  function tick() {
    if (diagram && typeof diagram.setValvePosition === 'function') {
      if (valveTimeline && valveTimeline.moving && valveTimeline.durationMs > 0) {
        const nowServer = Date.now() - clockSkewMs;
        const t = Math.max(0, Math.min(1, (nowServer - valveTimeline.startMs) / valveTimeline.durationMs));
        const pct = valveTimeline.from + (valveTimeline.to - valveTimeline.from) * t;
        diagram.setValvePosition(pct / 100);
      } else {
        diagram.setValvePosition((valvePercentIdle || 0) / 100);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ===== User toggles slider =====
slider.addEventListener('click', async () => {
  if (slider.getAttribute('aria-disabled') === 'true') return;
  const goingOn = !slider.classList.contains('on');

  setSliderClass('working');
  setSliderDisabled(true);

  // Provisional local timeline (will be reconciled by next /status)
  const clientNow = Date.now();
  const currentPct = (valveTimeline && valveTimeline.moving)
    ? (() => {
        const nowServer = clientNow - clockSkewMs;
        const t = Math.max(0, Math.min(1, (nowServer - valveTimeline.startMs) / valveTimeline.durationMs));
        return valveTimeline.from + (valveTimeline.to - valveTimeline.from) * t;
      })()
    : (valvePercentIdle || 0);

  valveTimeline = {
    moving: true,
    from: currentPct,
    to: goingOn ? 100 : 0,
    startMs: clientNow - clockSkewMs,   // approx server start time
    durationMs: VALVE_MS,
  };

  try {
    const r = await fetch(goingOn ? '/spa/on' : '/spa/off', { method:'GET', cache:'no-store' });
    if (!r.ok && r.status !== 409) throw new Error('HTTP ' + r.status);
  } catch {
    // Let polling reconcile on error
  }
});

// ===== Custom elements =====
class SpaDiagram extends HTMLElement{
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    adoptDiagramStyles(this.shadowRoot);
    this.shadowRoot.innerHTML = `
      <div class="diagram" style="grid-template-areas:
        'suction pump'
        'return  heater'">
        <div class="col" style="grid-area:suction">
          <spa-equipment-valve id="suction" label="Suction"></spa-equipment-valve>
          <div class="label">Suction Valve</div>
        </div>
        <div class="col" style="grid-area:pump">
          <spa-equipment-pump id="pump"></spa-equipment-pump>
          <div class="label">Pump</div>
        </div>
        <div class="col" style="grid-area:heater">
          <spa-equipment-heater id="heater"></spa-equipment-heater>
          <div class="label">Heater</div>
        </div>
        <div class="col" style="grid-area:return">
          <spa-equipment-valve id="return" label="Return"></spa-equipment-valve>
          <div class="label">Return Valve</div>
        </div>
      </div>
    `;
    this.$pump   = this.shadowRoot.getElementById('pump');
    this.$heater = this.shadowRoot.getElementById('heater');
    this.$suction= this.shadowRoot.getElementById('suction');
    this.$return = this.shadowRoot.getElementById('return');
  }
  setValvePosition(norm){
    const pct = Math.max(0, Math.min(1, norm)) * 100;
    this.$suction.setValue(pct);
    this.$return.setValue(pct);
  }
  setPump(state, speed){ this.$pump.setState(state, speed); }
  setHeater(on){ this.$heater.setOn(on); }
  applyState(state){
    if(state === 'on'){
      this.setValvePosition(1); this.setPump('on','high'); this.setHeater(true);
    }else{
      this.setValvePosition(0); this.setPump('off','off'); this.setHeater(false);
    }
  }
}
customElements.define('spa-diagram', SpaDiagram);

// -- <spa-equipment-valve> (now supports configurable base angle) -------------
class SpaValve extends HTMLElement{
  static get observedAttributes(){ return ['label','value','base-angle']; }
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    adoptDiagramStyles(this.shadowRoot);
    this.shadowRoot.innerHTML = `
      <div class="wrap">
        <div class="pipe h" id="pipeH"></div>
        <div class="pipe v" id="pipeV"></div>
        <div class="body">
          <div class="handle" id="handle"></div>
          <div class="cap"></div>
        </div>
        <div class="tag" id="tag"></div>
      </div>
    `;
    this.$h = this.shadowRoot.getElementById('pipeH');
    this.$v = this.shadowRoot.getElementById('pipeV');
    this.$handle = this.shadowRoot.getElementById('handle');
    this.$tag = this.shadowRoot.getElementById('tag');

    this.value = 0;              // 0..100
    this.baseAngleDeg = 0;     // default baseline; configurable
  }
  attributeChangedCallback(name, _old, val){
    if(name === 'label'){ this.$tag.textContent = val || ''; }
    if(name === 'value'){ this.setValue(Number(val)); }
    if(name === 'base-angle'){
      const n = Number(val);
      if (Number.isFinite(n)) {
        this.baseAngleDeg = n;
        // Re-apply transform with new base angle
        this.setValue(this.value);
      }
    }
  }
  setBaseAngle(deg){
    const n = Number(deg);
    if (Number.isFinite(n)) {
      this.baseAngleDeg = n;
      this.setValue(this.value);
      this.setAttribute('base-angle', String(n));
    }
  }
  setValue(pct){
    if(Number.isFinite(pct)) this.value = Math.max(0, Math.min(100, pct));
    // Sweep is -180° across full travel (clockwise), offset by baseAngleDeg
    const angle = this.baseAngleDeg + (-180 * (this.value/100));
    this.$handle.style.transform = `translate(-100%, -50%) rotate(${angle}deg)`;
    // Simple flow tint (keep both lit for clarity)
    this.$h.classList.add('flow'); this.$v.classList.add('flow');
  }
  setWorking(on){ this.classList.toggle('working', !!on); }
}
customElements.define('spa-equipment-valve', SpaValve);

// -- <spa-equipment-pump> -----------------------------------------------------
class SpaPump extends HTMLElement{
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    adoptDiagramStyles(this.shadowRoot);
    this.shadowRoot.innerHTML = `
      <div class="pump" id="box">
        <div class="round" id="disc"></div>
        <div class="status" id="st">OFF</div>
      </div>
    `;
    this.$box  = this.shadowRoot.getElementById('box');
    this.$disc = this.shadowRoot.getElementById('disc');
    this.$st   = this.shadowRoot.getElementById('st');
    this.$st.addEventListener('click', ev => this.handleClick(ev));
  }
  setState(state, speed){
    const on = state === 'on';
    this.$box.className = 'pump' + (on ? (' on ' + (speed === 'high' ? 'high' : 'low')) : '');
    this.$st.textContent = on ? (speed==='high'?'ON • HIGH':'ON • LOW') : 'OFF';

    // Faster spin when HIGH (1s), slower when LOW (2s). None when OFF.
    if (on) {
      const dur = (speed === 'high') ? '1s' : '2s';
      this.$disc.style.animation = `pump-spin ${dur} linear infinite`;
    } else {
      this.$disc.style.animation = 'none';
    }
    this.speed = speed;
	  console.log(state, speed);
  }
  handleClick(ev) {
	  console.log('eeee', this.speed);
    if (this.speed == 'off') {
      this.setState('on', 'low');
    } else if (this.speed == 'low') {
      this.setState('on', 'high');
    } else if (this.speed == 'high') {
      this.setState('off', 'off');
    }
  }
}
customElements.define('spa-equipment-pump', SpaPump);

// -- <spa-equipment-heater> ---------------------------------------------------
class SpaHeater extends HTMLElement{
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    adoptDiagramStyles(this.shadowRoot);
    this.shadowRoot.innerHTML = `<div class="heater" id="box"><div class="txt">HEATER</div></div>`;
    this.$box  = this.shadowRoot.getElementById('box');
  }
  setOn(on){ this.$box.classList.toggle('on', !!on); }
}
customElements.define('spa-equipment-heater', SpaHeater);

// ===== Start: initial fetch, RAF, and polling =====
(async () => {
  try {
    const initial = await fetchStatus();
    await applyStatus(initial);
  } catch {
    // ignore; poller will retry
  }
  startValveRaf();   // render loop driven by server timeline
  pollLoop();        // keeps all clients in sync
})();

