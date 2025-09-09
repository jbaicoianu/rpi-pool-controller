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

// ===== Component refs =====
const diagram = document.getElementById('diagram');
const modeSelector = document.getElementById('mode-selector');

// Global state
let availableModes = [];
let currentMode = 'service';

// Status update functions for mode selector
function updateModeSelector(status) {
  if (modeSelector && typeof modeSelector.updateStatus === 'function') {
    modeSelector.updateStatus(status);
  }
}

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

// ===== Apply server status to components =====
async function applyStatus(j){
  setTimelineFromStatus(j);
  
  // Update global state
  if (j.modes) {
    availableModes = j.modes;
  }
  currentMode = j.mode || 'service';
  
  // Update diagram based on equipment state
  if (j.equipment && diagram) {
    const eq = j.equipment;
    diagram.setPump(eq.pump, eq.pumpSpeed);
    diagram.setHeater(eq.heater === 'on');
  }
  
  // Update mode selector
  updateModeSelector(j);
}

// ===== Continuous polling so multiple clients stay in sync =====
let pollTimer = null;
async function pollLoop(intervalMs = 1000, idleMs = 3000){
  try {
    const j = await fetchStatus();
    await applyStatus(j);
    const next = j.busy ? intervalMs : idleMs;
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

// Mode switching is now handled by the pool-mode-selector component

// ===== Custom elements =====
class PoolDiagram extends HTMLElement{
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
customElements.define('pool-diagram', PoolDiagram);

// ===== Pool Mode Selector Component =====
class PoolModeSelector extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.modes = [];
    this.currentMode = 'service';
    this.busy = false;
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          margin: 18px 0;
        }
        .mode-slider {
          --w: 420px;
          --h: 88px;
          --pad: 6px;
          width: var(--w);
          height: var(--h);
          position: relative;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,.10);
          background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(0,0,0,.15));
          box-shadow: inset 0 2px 8px rgba(0,0,0,.35), 0 12px 30px rgba(0,0,0,.25);
          margin: 0 auto;
        }
        .track {
          position: absolute;
          inset: var(--pad);
          border-radius: 999px;
          background: #0f1427;
          overflow: hidden;
          transition: box-shadow .25s ease;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
        }
        .tint {
          position: absolute;
          inset: 0;
          border-radius: 999px;
          opacity: .22;
          transition: background .3s ease;
        }
        .knob {
          position: absolute;
          top: 50%;
          width: calc(var(--h) - (var(--pad) * 2));
          height: calc(var(--h) - (var(--pad) * 2));
          border-radius: 999px;
          transform: translate(var(--pad), -50%);
          transition: transform .35s cubic-bezier(.2,.8,.2,1), box-shadow .2s ease;
          background: radial-gradient(circle at 30% 30%, #ffffff, #dfe7fb 32%, #b8c6e8 60%, #93a5d6);
          box-shadow: 0 10px 20px rgba(0,0,0,.45), inset 0 2px 5px rgba(255,255,255,.6);
          cursor: pointer;
        }
        .labels {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          font-weight: 700;
          letter-spacing: .5px;
          font-size: .85rem;
          user-select: none;
          padding: 0 20px;
          justify-content: space-between;
        }
        .label {
          opacity: .7;
          transition: opacity .2s ease;
          cursor: pointer;
          padding: 8px 12px;
          border-radius: 8px;
          transition: all .2s ease;
        }
        .label:hover {
          opacity: 1;
          background: rgba(255,255,255,.05);
        }
        .label.active {
          opacity: 1;
          font-weight: 800;
        }
        .sr {
          position: absolute;
          left: -9999px;
        }
        .mode-slider.disabled {
          filter: grayscale(.25);
          opacity: .82;
          pointer-events: none;
        }
      </style>
      <div class="mode-slider" id="slider">
        <span class="sr" id="sr">Loading modes...</span>
        <div class="track"><div class="tint" id="tint"></div></div>
        <div class="knob" id="knob"></div>
        <div class="labels" id="labels"></div>
      </div>
    `;
    
    this.$slider = this.shadowRoot.getElementById('slider');
    this.$sr = this.shadowRoot.getElementById('sr');
    this.$tint = this.shadowRoot.getElementById('tint');
    this.$knob = this.shadowRoot.getElementById('knob');
    this.$labels = this.shadowRoot.getElementById('labels');
  }
  
  setModes(modes) {
    this.modes = modes;
    this.renderLabels();
  }
  
  renderLabels() {
    this.$labels.innerHTML = '';
    this.modes.forEach((mode, index) => {
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = mode.name;
      label.style.color = mode.color || '#9aa4b2';
      label.dataset.modeKey = mode.key;
      label.addEventListener('click', () => this.switchToMode(mode.key));
      this.$labels.appendChild(label);
    });
  }
  
  updateStatus(status) {
    this.currentMode = status.mode;
    this.busy = status.busy;
    
    // Update modes if provided
    if (status.modes && status.modes.length > 0) {
      this.setModes(status.modes);
    }
    
    this.updateVisualState();
  }
  
  updateVisualState() {
    const currentIndex = this.modes.findIndex(m => m.key === this.currentMode);
    const currentModeObj = this.modes.find(m => m.key === this.currentMode);
    
    if (currentIndex >= 0 && this.modes.length > 0) {
      // Calculate knob position
      const progress = currentIndex / Math.max(1, this.modes.length - 1);
      const knobWidth = 76; // approximate knob width
      const trackWidth = 420 - 12; // slider width minus padding
      const maxTravel = trackWidth - knobWidth;
      const position = 6 + (progress * maxTravel); // pad + travel
      
      this.$knob.style.transform = `translate(${position}px, -50%)`;
      
      // Update tint color
      if (currentModeObj) {
        this.$tint.style.background = `linear-gradient(90deg, ${currentModeObj.color}, ${currentModeObj.color}88)`;
        this.$sr.textContent = `Current mode: ${currentModeObj.name}`;
      }
      
      // Update track glow
      this.$slider.querySelector('.track').style.boxShadow = 
        `inset 0 0 0 1px ${currentModeObj?.color}35, inset 0 0 18px ${currentModeObj?.color}22`;
    }
    
    // Update label active state
    this.$labels.querySelectorAll('.label').forEach((label, index) => {
      label.classList.toggle('active', this.modes[index]?.key === this.currentMode);
    });
    
    // Update disabled state
    this.$slider.classList.toggle('disabled', this.busy);
    
    // Update working animation
    if (this.busy) {
      this.$tint.style.animation = 'breathe 1.4s ease-in-out infinite';
    } else {
      this.$tint.style.animation = 'none';
    }
  }
  
  async switchToMode(modeKey) {
    if (this.busy || modeKey === this.currentMode) return;
    
    try {
      const response = await fetch(`/mode/${modeKey}`, { 
        method: 'GET', 
        cache: 'no-store' 
      });
      
      if (!response.ok && response.status !== 409) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      // Let polling handle the UI update
    } catch (error) {
      console.error('Failed to switch mode:', error);
      // Let polling reconcile on error
    }
  }
}

customElements.define('pool-mode-selector', PoolModeSelector);

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

