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
const relayPanel = document.getElementById('relay-panel');
const simulatorBanner = document.getElementById('simulator-banner');
const simulatorToggle = document.getElementById('simulator-toggle');

// Global state
let availableModes = [];
let currentMode = 'auto';
let simulatorMode = false;
let gpioHardwareAvailable = true;

// Status update functions for mode selector
function updateModeSelector(status) {
  if (modeSelector && typeof modeSelector.updateStatus === 'function') {
    modeSelector.updateStatus(status);
  }
}

// Simulator mode functions
function updateSimulatorBanner(isSimulator, hardwareAvailable = true) {
  simulatorMode = isSimulator;
  gpioHardwareAvailable = hardwareAvailable;
  
  if (simulatorBanner) {
    simulatorBanner.classList.toggle('hidden', !isSimulator);
    
    if (simulatorToggle) {
      if (!hardwareAvailable) {
        simulatorToggle.textContent = 'No GPIO Hardware';
        simulatorToggle.disabled = true;
        simulatorToggle.style.opacity = '0.6';
        simulatorToggle.style.cursor = 'not-allowed';
      } else {
        simulatorToggle.textContent = isSimulator ? 'Exit Simulator' : 'Enter Simulator';
        simulatorToggle.disabled = false;
        simulatorToggle.style.opacity = '1';
        simulatorToggle.style.cursor = 'pointer';
      }
    }
    
    // Update banner text for hardware detection
    const bannerText = simulatorBanner.querySelector('.simulator-text');
    if (bannerText) {
      if (!hardwareAvailable) {
        bannerText.textContent = 'SIMULATOR MODE (No GPIO Hardware)';
      } else {
        bannerText.textContent = 'SIMULATOR MODE';
      }
    }
  }
}

async function toggleSimulator() {
  if (!gpioHardwareAvailable) {
    console.log('Cannot toggle simulator mode: GPIO hardware not available');
    return;
  }
  
  try {
    const response = await fetch('/simulator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !simulatorMode })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Failed to toggle simulator mode:', errorData.message);
      return;
    }
    
    // Status will be updated via polling
  } catch (error) {
    console.error('Failed to toggle simulator mode:', error);
  }
}

// Set up simulator toggle button
if (simulatorToggle) {
  simulatorToggle.addEventListener('click', toggleSimulator);
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
  currentMode = j.mode || 'auto';
  
  // Update simulator mode
  updateSimulatorBanner(j.simulator, j.gpioHardwareAvailable);
  
  // Update diagram based on equipment state
  if (j.equipment && diagram) {
    const eq = j.equipment;
    diagram.setPump(eq.pump, eq.pumpSpeed);
    diagram.setHeater(eq.heater === 'on');
  }
  
  // Update relay panel
  if (j.gpio && relayPanel && typeof relayPanel.updateRelayStates === 'function') {
    relayPanel.updateRelayStates(j.gpio);
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
      <style>
        .equipment-shed {
          display: grid;
          grid-template-columns: 1fr 1fr 2fr;
          grid-template-rows: repeat(3, 1fr);
          gap: 20px;
          padding: 20px;
          position: relative;
          min-height: 400px;
          border: 2px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          background: rgba(0,0,0,0.1);
	  align-items: center;
        }
        
        /* Grid positioning */
	/*
        #pool { grid-column: 1; grid-row: 1; justify-self: center; align-self: center; }
        #spa { grid-column: 1; grid-row: 3; justify-self: center; align-self: center; }
	*/
        #suction { grid-column: 2; grid-row: 3; }
        #return { grid-column: 2; grid-row: 1; }
        #pump { grid-column: 3; grid-row: 3; justify-self: center; }
        #filter { grid-column: 3; grid-row: 2; justify-self: center; }
        #heater { grid-column: 3; grid-row: 1; justify-self: center; }
	.water-bodies { grid-column: 1; grid-row: span 3; position: relative; height: 100%; }
	.water-bodies #pool {
	  position: absolute;
	  height: 400px;
	  width: 100px;
	}
	.water-bodies #spa {
	  position: absolute;
	  height: 60px;
	  width: 40px;
	  left: 100px;
	  top: 340px;
	}
        #pool-skimmer {
          position: absolute;
          top: 405px;
	  left: 10px;
	  z-index: 12;
        }
        #pool-inlet {
          position: absolute;
          top: 10px;
	  left: 90px;
	  z-index: 12;
        }
        #spa-drain {
          position: absolute;
          top: 375px;
	  left: 135px;
	  z-index: 12;
        }
        #spa-inlet {
          position: absolute;
          top: 350px;
	  left: 135px;
	  z-index: 12;
        }
      </style>
      
      <div class="equipment-shed">
        <!-- Water bodies -->
        <div class="water-bodies">
          <pool-water-body id="pool" type="pool" temperature="75">
	  </pool-water-body>
          <pool-water-body id="spa" type="spa" temperature="104">
	  </pool-water-body>
            <pool-equipment-drain id="spa-drain"></pool-equipment-drain>
            <pool-equipment-inlet id="spa-inlet"></pool-equipment-inlet>
            <pool-equipment-skimmer id="pool-skimmer"></pool-equipment-skimmer>
            <pool-equipment-inlet id="pool-inlet"></pool-equipment-inlet>
        </div>
        
        <!-- Equipment flow path -->
        <pool-equipment-valve id="suction" label="Suction" rotation="-90" reversed="true"></pool-equipment-valve>
        <pool-equipment-pump id="pump"></pool-equipment-pump>
        <pool-equipment-filter id="filter"></pool-equipment-filter>
        <pool-equipment-valve id="return" label="Return" rotation="-90"></pool-equipment-valve>
        <pool-equipment-heater id="heater"></pool-equipment-heater>
        
        <!-- Pipes -->
        <pool-pipe from="pool-skimmer.outlet" to="suction.left"></pool-pipe>
        <pool-pipe from="spa-drain.outlet" to="suction.right"></pool-pipe>
        <pool-pipe from="suction.bottom" to="pump.input"></pool-pipe>
        <pool-pipe from="pump.output" to="filter.input"></pool-pipe>
        <pool-pipe from="filter.output" to="heater.input"></pool-pipe>
        <pool-pipe from="heater.output" to="return.bottom"></pool-pipe>
        <pool-pipe from="return.right" to="pool-inlet.inlet"></pool-pipe>
        <pool-pipe from="return.left" to="spa-inlet.inlet"></pool-pipe>
      </div>
    `;
    this.$pump   = this.shadowRoot.getElementById('pump');
    this.$heater = this.shadowRoot.getElementById('heater');
    this.$suction= this.shadowRoot.getElementById('suction');
    this.$return = this.shadowRoot.getElementById('return');
    this.$filter = this.shadowRoot.getElementById('filter');
    this.$pool = this.shadowRoot.getElementById('pool');
    this.$spa = this.shadowRoot.getElementById('spa');
    this.$pipes = this.shadowRoot.querySelectorAll('pool-pipe');
    
    // Initialize pipes after components are rendered
    setTimeout(() => this.initializePipes(), 0);
    
    // Initialize throttling
    this.lastFlowUpdate = 0;
  }

  setValvePosition(norm){
    const pct = Math.max(0, Math.min(1, norm)) * 100;
    this.$suction.setValue(pct);
    this.$return.setValue(pct);
    this.throttledUpdatePipeFlows();
  }
  
  setPump(state, speed){ 
    this.$pump.setState(state, speed); 
    this.throttledUpdatePipeFlows();
  }
  
  setHeater(on){ 
    this.$heater.setOn(on); 
    this.throttledUpdatePipeFlows();
  }
  
  throttledUpdatePipeFlows() {
    const now = Date.now();
    if (now - this.lastFlowUpdate < 100) {
      return; // Skip if updated less than 100 ms ago
    }
    this.lastFlowUpdate = now;
    this.updatePipeFlows();
  }
  
  updatePipeFlows() {
    // Build flow model by discovering components and connections from DOM
    const flowModel = new PoolFlowModel();
    
    // Auto-discover all flow components in the diagram
    const allComponents = this.shadowRoot.querySelectorAll('pool-water-body, pool-equipment-valve, pool-equipment-pump, pool-equipment-filter, pool-equipment-heater, pool-equipment-drain, pool-equipment-skimmer, pool-equipment-inlet');
    
    allComponents.forEach(element => {
      const id = element.id;
      if (!id) return;
      
      const config = this.getComponentConfig(element);
      flowModel.addComponent(id, config);
    });
    
    // Auto-discover connections from pipe elements
    this.$pipes.forEach(pipe => {
      const fromComp = pipe.fromComponent;
      const fromPort = pipe.fromPoint;
      const toComp = pipe.toComponent;
      const toPort = pipe.toPoint;
      
      if (fromComp && fromPort && toComp && toPort) {
        flowModel.addConnection(fromComp, fromPort, toComp, toPort);
      }
    });
    
    // Calculate flow for each pipe
    const flows = flowModel.calculateFlows();
    
    // Apply flow state to pipes with intensity
    this.$pipes.forEach(pipe => {
      const flowKey = `${pipe.fromComponent}.${pipe.fromPoint}-${pipe.toComponent}.${pipe.toPoint}`;
      const flowIntensity = flows[flowKey] || 0;
      pipe.setFlow(flowIntensity);
    });
    
    // Apply flow state to valve ports with intensity
    const valves = this.shadowRoot.querySelectorAll('pool-equipment-valve');
    valves.forEach(valve => {
      // Clear all valve port flows first
      valve.setPipeFlow('left', 0);
      valve.setPipeFlow('right', 0);
      valve.setPipeFlow('bottom', 0);
      
      // Check each connection involving this valve
      this.$pipes.forEach(pipe => {
        const flowKey = `${pipe.fromComponent}.${pipe.fromPoint}-${pipe.toComponent}.${pipe.toPoint}`;
        const flowIntensity = flows[flowKey] || 0;
        
        if (flowIntensity > 0) {
          // If flow is coming INTO this valve
          if (pipe.toComponent === valve.id) {
            valve.setPipeFlow(pipe.toPoint, flowIntensity);
          }
          // If flow is coming FROM this valve
          if (pipe.fromComponent === valve.id) {
            valve.setPipeFlow(pipe.fromPoint, flowIntensity);
          }
        }
      });
    });
    
    // Update connection positions
    setTimeout(() => {
      this.$pipes.forEach(pipe => pipe.updatePath());
    }, 0);
  }
  
  getComponentConfig(element) {
    // Determine component type and current state from the element itself
    const tagName = element.tagName.toLowerCase();
    
    if (tagName === 'pool-water-body') {
      return { 
        type: 'reservoir', 
        pressure: 0,
        waterType: element.getAttribute('type') || 'pool'
      };
    }
    
    if (tagName === 'pool-equipment-valve') {
      return { 
        type: 'valve', 
        position: element.value || 0,
        reversed: element.getAttribute('reversed') === 'true'
      };
    }
    
    if (tagName === 'pool-equipment-pump') {
      const isRunning = element.shadowRoot?.querySelector('.pump.on') !== null;
      return { 
        type: 'pump', 
        running: isRunning 
      };
    }
    
    if (tagName === 'pool-equipment-filter') {
      return { 
        type: 'passthrough', 
        pressure: 0,
        resistance: 0 // No flow resistance
      };
    }
    
    if (tagName === 'pool-equipment-heater') {
      const isOn = element.shadowRoot?.querySelector('.heater.on') !== null;
      return { 
        type: 'passthrough', 
        pressure: 0,
        resistance: 0 // No flow resistance
      };
    }
    
    if (tagName === 'pool-equipment-drain') {
      return { 
        type: 'reservoir', 
        pressure: 0,
        waterType: 'drain'
      };
    }
    
    if (tagName === 'pool-equipment-skimmer') {
      return { 
        type: 'reservoir', 
        pressure: 0,
        waterType: 'skimmer'
      };
    }
    
    if (tagName === 'pool-equipment-inlet') {
      return { 
        type: 'reservoir', 
        pressure: 0,
        waterType: 'inlet'
      };
    }
    
    return { type: 'unknown', pressure: 0 };
  }
  
  initializePipes() {
    // Force all pipes to update their paths
    this.$pipes.forEach(pipe => {
      pipe.updatePath();
    });
    
    // Initialize flow states
    this.updatePipeFlows();
  }
  
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
    this.currentMode = 'auto';
    this.targetMode = null;
    this.busy = false;
    this.isDragging = false;
    this.dragStartX = 0;
    this.knobStartX = 0;
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
        .mode-slider.working .tint {
          animation: breathe 1.4s ease-in-out infinite;
        }
        .mode-slider.working .track {
          box-shadow: inset 0 0 0 1px rgba(245,209,95,.45), inset 0 0 20px rgba(245,209,95,.28);
        }
        @keyframes breathe {
          0% { opacity: .18; filter: brightness(95%); }
          50% { opacity: .40; filter: brightness(110%); }
          100% { opacity: .18; filter: brightness(95%); }
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
    
    // Add drag/touch event listeners
    this.setupDragHandlers();
  }
  
  setupDragHandlers() {
    // Mouse events
    this.$knob.addEventListener('mousedown', (e) => this.startDrag(e));
    document.addEventListener('mousemove', (e) => this.onDrag(e));
    document.addEventListener('mouseup', () => this.endDrag());
    
    // Touch events
    this.$knob.addEventListener('touchstart', (e) => this.startDrag(e), { passive: false });
    document.addEventListener('touchmove', (e) => this.onDrag(e), { passive: false });
    document.addEventListener('touchend', () => this.endDrag());
  }
  
  startDrag(e) {
    if (this.busy) return;
    
    e.preventDefault();
    this.isDragging = true;
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    this.dragStartX = clientX;
    
    // Get current knob position
    const knobRect = this.$knob.getBoundingClientRect();
    this.knobStartX = knobRect.left;
    
    this.$knob.style.transition = 'none'; // Disable transition during drag
    this.$slider.style.cursor = 'grabbing';
  }
  
  onDrag(e) {
    if (!this.isDragging || this.busy) return;
    
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const deltaX = clientX - this.dragStartX;
    
    // Calculate new position
    const sliderRect = this.$slider.getBoundingClientRect();
    const knobWidth = 76;
    const trackWidth = sliderRect.width - 12; // slider width minus padding
    const maxTravel = trackWidth - knobWidth;
    
    let newX = this.knobStartX - sliderRect.left + deltaX;
    newX = Math.max(6, Math.min(6 + maxTravel, newX)); // Clamp to valid range
    
    this.$knob.style.transform = `translate(${newX}px, -50%)`;
    
    // Update visual feedback based on position
    const progress = (newX - 6) / maxTravel;
    const targetModeIndex = Math.round(progress * (this.modes.length - 1));
    const targetMode = this.modes[targetModeIndex];
    
    if (targetMode) {
      this.$tint.style.background = `linear-gradient(90deg, ${targetMode.color}, ${targetMode.color}88)`;
      this.$sr.textContent = `Dragging to: ${targetMode.name}`;
    }
  }
  
  endDrag() {
    if (!this.isDragging) return;
    
    this.isDragging = false;
    this.$knob.style.transition = 'transform .35s cubic-bezier(.2,.8,.2,1), box-shadow .2s ease';
    this.$slider.style.cursor = '';
    
    if (this.busy) return;
    
    // Calculate which mode we're closest to
    const knobRect = this.$knob.getBoundingClientRect();
    const sliderRect = this.$slider.getBoundingClientRect();
    const knobCenter = knobRect.left + knobRect.width / 2 - sliderRect.left;
    
    const knobWidth = 76;
    const trackWidth = sliderRect.width - 12;
    const maxTravel = trackWidth - knobWidth;
    const progress = Math.max(0, Math.min(1, (knobCenter - 6 - knobWidth/2) / maxTravel));
    
    const targetModeIndex = Math.round(progress * (this.modes.length - 1));
    const targetMode = this.modes[targetModeIndex];
    
    const effectiveCurrentMode = this.targetMode || this.currentMode;
    if (targetMode && targetMode.key !== effectiveCurrentMode) {
      this.switchToMode(targetMode.key);
    } else {
      // Snap back to current/target position
      this.updateVisualState();
    }
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
    const prevMode = this.currentMode;
    const prevBusy = this.busy;
    
    this.currentMode = status.mode;
    this.targetMode = status.target;
    this.busy = status.busy;
    
    // Update modes if provided
    if (status.modes && status.modes.length > 0) {
      this.setModes(status.modes);
    }
    
    // If we just finished switching modes, ensure we're in the right visual state
    if (prevBusy && !this.busy) {
      this.$slider.classList.remove('working');
    }
    
    this.updateVisualState();
  }
  
  updateVisualState() {
    // Use target mode if we're transitioning, otherwise use current mode
    const displayMode = this.targetMode || this.currentMode;
    const currentIndex = this.modes.findIndex(m => m.key === displayMode);
    const currentModeObj = this.modes.find(m => m.key === displayMode);
    
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
    
    // Update label active state - show target during transitions
    const activeMode = this.targetMode || this.currentMode;
    this.$labels.querySelectorAll('.label').forEach((label, index) => {
      label.classList.toggle('active', this.modes[index]?.key === activeMode);
    });
    
    // Update disabled and working states
    this.$slider.classList.toggle('disabled', this.busy);
    this.$slider.classList.toggle('working', this.busy);
  }
  
  async switchToMode(modeKey) {
    if (this.busy || modeKey === this.currentMode) return;
    
    // Immediate visual feedback - move to target position and show working state
    const targetModeIndex = this.modes.findIndex(m => m.key === modeKey);
    const targetMode = this.modes[targetModeIndex];
    
    if (targetModeIndex >= 0 && targetMode) {
      // Calculate and move to target position immediately
      const progress = targetModeIndex / Math.max(1, this.modes.length - 1);
      const knobWidth = 76;
      const trackWidth = 420 - 12;
      const maxTravel = trackWidth - knobWidth;
      const position = 6 + (progress * maxTravel);
      
      this.$knob.style.transform = `translate(${position}px, -50%)`;
      
      // Update colors for target mode
      this.$tint.style.background = `linear-gradient(90deg, ${targetMode.color}, ${targetMode.color}88)`;
      this.$sr.textContent = `Switching to: ${targetMode.name}`;
      
      // Show working state immediately (will be confirmed by server status)
      this.$slider.classList.add('working');
      
      // Update active label to show target
      this.$labels.querySelectorAll('.label').forEach((label, index) => {
        label.classList.toggle('active', index === targetModeIndex);
      });
    }
    
    try {
      const response = await fetch(`/mode/${modeKey}`, { 
        method: 'GET', 
        cache: 'no-store' 
      });
      
      if (!response.ok && response.status !== 409) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      // Let polling handle the final UI update
    } catch (error) {
      console.error('Failed to switch mode:', error);
      // Reset visual state on error - let polling reconcile
      this.$slider.classList.remove('working');
      this.updateVisualState();
    }
  }
}

customElements.define('pool-mode-selector', PoolModeSelector);

// ===== Pool Flow System Base Classes =====

// Base class for components with connection points
class PoolFlowComponent extends HTMLElement {
  constructor() {
    super();
    this.connectionPoints = new Map(); // name -> { x, y, type: 'input'|'output' }
  }
  
  defineConnectionPoint(name, x, y, type = 'output') {
    this.connectionPoints.set(name, { x, y, type });
  }
  
  getConnectionPoint(name) {
    const point = this.connectionPoints.get(name);
    if (!point) {
      // Check if this is a dynamic connection point (input/output or inlet/outlet)
      if (name === 'input' || name === 'output') {
        return this.getDynamicConnectionPoint(name);
      }
      if (name === 'inlet') {
        return this.getDynamicConnectionPoint('input');
      }
      if (name === 'outlet') {
        return this.getDynamicConnectionPoint('output');
      }
      return null;
    }
    
    const rect = this.getBoundingClientRect();
    
    // Find the equipment shed container for relative positioning
    const diagram = this.getRootNode().host;
    const shedRect = diagram?.shadowRoot?.querySelector('.equipment-shed')?.getBoundingClientRect();
    
    if (!shedRect) {
      // Fallback to absolute positioning
      return {
        x: rect.left + point.x,
        y: rect.top + point.y,
        type: point.type
      };
    }
    
    // Return coordinates relative to the equipment shed
    return {
      x: (rect.left - shedRect.left) + point.x,
      y: (rect.top - shedRect.top) + point.y,
      type: point.type
    };
  }
  
  getDynamicConnectionPoint(type) {
    // Find the closest edge to the connected component
    const rect = this.getBoundingClientRect();
    const diagram = this.getRootNode().host;
    const shedRect = diagram?.shadowRoot?.querySelector('.equipment-shed')?.getBoundingClientRect();
    
    if (!shedRect) return null;
    
    // Get center of this component relative to shed
    const thisX = (rect.left - shedRect.left) + rect.width / 2;
    const thisY = (rect.top - shedRect.top) + rect.height / 2;
    
    // Find the connection this component is involved in
    const connections = diagram.shadowRoot.querySelectorAll('pool-pipe');
    let targetElement = null;
    
    for (const pipe of connections) {
      // Check for both the requested type and potential aliases
      const matchNames = [type];
      if (type === 'input') matchNames.push('inlet');
      if (type === 'output') matchNames.push('outlet');
      
      const fromMatch = pipe.fromComponent === this.id && matchNames.includes(pipe.fromPoint);
      const toMatch = pipe.toComponent === this.id && matchNames.includes(pipe.toPoint);
      
      if (fromMatch || toMatch) {
        const targetId = pipe.fromComponent === this.id ? pipe.toComponent : pipe.fromComponent;
        targetElement = diagram.shadowRoot.getElementById(targetId);
        break;
      }
    }
    
    if (!targetElement) {
      // Default to left for input, right for output
      const x = type === 'input' ? 0 : rect.width;
      const y = rect.height / 2;
      return {
        x: (rect.left - shedRect.left) + x,
        y: (rect.top - shedRect.top) + y,
        type: type
      };
    }
    
    // Calculate target position
    const targetRect = targetElement.getBoundingClientRect();
    const targetX = (targetRect.left - shedRect.left) + targetRect.width / 2;
    const targetY = (targetRect.top - shedRect.top) + targetRect.height / 2;
    
    // Determine which side is closest
    const sides = [
      { name: 'left', x: 0, y: rect.height / 2 },
      { name: 'right', x: rect.width, y: rect.height / 2 },
      { name: 'top', x: rect.width / 2, y: 0 },
      { name: 'bottom', x: rect.width / 2, y: rect.height }
    ];
    
    let closestSide = sides[0];
    let minDistance = Infinity;
    
    for (const side of sides) {
      const sideX = (rect.left - shedRect.left) + side.x;
      const sideY = (rect.top - shedRect.top) + side.y;
      const distance = Math.sqrt((targetX - sideX) ** 2 + (targetY - sideY) ** 2);
      
      if (distance < minDistance) {
        minDistance = distance;
        closestSide = side;
      }
    }
    
    return {
      x: (rect.left - shedRect.left) + closestSide.x,
      y: (rect.top - shedRect.top) + closestSide.y,
      type: type
    };
  }
  
  getAllConnectionPoints() {
    const rect = this.getBoundingClientRect();
    
    // Find the equipment shed container for relative positioning
    const diagram = this.getRootNode().host;
    const shedRect = diagram?.shadowRoot?.querySelector('.equipment-shed')?.getBoundingClientRect();
    
    const points = {};
    for (const [name, point] of this.connectionPoints) {
      if (shedRect) {
        // Relative to equipment shed
        points[name] = {
          x: (rect.left - shedRect.left) + point.x,
          y: (rect.top - shedRect.top) + point.y,
          type: point.type
        };
      } else {
        // Fallback to absolute positioning
        points[name] = {
          x: rect.left + point.x,
          y: rect.top + point.y,
          type: point.type
        };
      }
    }
    return points;
  }
}

// -- <pool-equipment-valve> (now supports configurable base angle) -------------
class PoolValve extends PoolFlowComponent{
  static get observedAttributes(){ return ['label','value','base-angle','rotation']; }
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    adoptDiagramStyles(this.shadowRoot);
    this.shadowRoot.innerHTML = `
      <div class="wrap">
        <div class="pipe left-pipe" id="pipeLeft"></div>
        <div class="pipe right-pipe" id="pipeRight"></div>
        <div class="pipe bottom-pipe" id="pipeBottom"></div>
        <div class="body">
          <div class="handle" id="handle"></div>
          <div class="cap"></div>
        </div>
        <div class="tag" id="tag"></div>
      </div>
    `;
    this.$pipeLeft = this.shadowRoot.getElementById('pipeLeft');
    this.$pipeRight = this.shadowRoot.getElementById('pipeRight');
    this.$pipeBottom = this.shadowRoot.getElementById('pipeBottom');
    this.$handle = this.shadowRoot.getElementById('handle');
    this.$tag = this.shadowRoot.getElementById('tag');

    this.value = 0;              // 0..100
    this.baseAngleDeg = 0;     // default baseline; configurable
    this.rotationDeg = 0;      // rotation of entire valve display
    
    // Define 3 connection points for T-shaped 3-way valve 
    // 50px from center (110, 70) in each direction
    // These will be rotated by this.rotationDeg when accessed
    // Port names always stay consistent: left, right, bottom
    this.defineConnectionPoint('left', 60, 70, 'input');      // 50px left of center
    this.defineConnectionPoint('right', 160, 70, 'output');   // 50px right of center  
    this.defineConnectionPoint('bottom', 110, 120, 'input');  // 50px below center
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
    if(name === 'rotation'){
      const n = Number(val);
      if (Number.isFinite(n)) {
        this.rotationDeg = n;
        this.applyRotation();
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
    // Note: Flow states are managed separately by the flow calculation system
  }
  
  // Method to control individual pipe flow lighting with intensity
  setPipeFlow(port, flowIntensity) {
    const pipe = this.getPipeElement(port);
    if (!pipe) return;
    
    // Determine target class based on intensity
    let targetClass = '';
    if (flowIntensity > 0) {
      if (flowIntensity >= 0.995) {  // Use tolerance to prevent flickering between flow and flow_100pct
        targetClass = 'flow'; // Full flow with glow effect
      } else {
        const percentage = Math.round(flowIntensity * 10) * 10; // Round to nearest 10%
        const clampedPercentage = Math.max(10, Math.min(100, percentage)); // Clamp between 10-100%
        targetClass = `flow_${clampedPercentage}pct`;
      }
    }
    
    // Only update classes if they need to change
    const currentClass = pipe.className.split(' ').find(cls => cls === 'flow' || cls.startsWith('flow_'));
    if (currentClass !== targetClass) {
      // Clear all flow classes only when necessary
      pipe.classList.remove('flow', 'flow_10pct', 'flow_20pct', 'flow_30pct', 'flow_40pct', 
                           'flow_50pct', 'flow_60pct', 'flow_70pct', 'flow_80pct', 'flow_90pct', 'flow_100pct');
      
      // Apply new class if needed
      if (targetClass) {
        pipe.classList.add(targetClass);
      }
    }
  }
  
  getPipeElement(port) {
    switch(port) {
      case 'left': return this.$pipeLeft;
      case 'right': return this.$pipeRight; 
      case 'bottom': return this.$pipeBottom;
      default: return null;
    }
  }
  applyRotation() {
    const wrap = this.shadowRoot.querySelector('.wrap');
    if (wrap) {
      wrap.style.transform = `rotate(${this.rotationDeg}deg)`;
      wrap.style.transformOrigin = 'center center';
    }
  }
  
  setRotation(deg) {
    const n = Number(deg);
    if (Number.isFinite(n)) {
      this.rotationDeg = n;
      this.setAttribute('rotation', String(n));
      this.applyRotation();
    }
  }
  
  // Override getConnectionPoint to account for valve rotation
  getConnectionPoint(name) {
    const point = this.connectionPoints.get(name);
    if (!point) return null;
    
    const rect = this.getBoundingClientRect();
    const diagram = this.getRootNode().host;
    const shedRect = diagram?.shadowRoot?.querySelector('.equipment-shed')?.getBoundingClientRect();
    
    if (!shedRect) {
      return {
        x: rect.left + point.x,
        y: rect.top + point.y,
        type: point.type
      };
    }
    
    // Calculate the center of the valve for rotation
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    // Rotate the connection point around the valve center
    const radians = (this.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    
    // Translate point to origin, rotate, then translate back
    const localX = point.x - centerX;
    const localY = point.y - centerY;
    const rotatedX = localX * cos - localY * sin;
    const rotatedY = localX * sin + localY * cos;
    const finalX = rotatedX + centerX;
    const finalY = rotatedY + centerY;
    
    return {
      x: (rect.left - shedRect.left) + finalX,
      y: (rect.top - shedRect.top) + finalY,
      type: point.type
    };
  }
  
  setWorking(on){ this.classList.toggle('working', !!on); }
}
customElements.define('pool-equipment-valve', PoolValve);

// -- <pool-equipment-pump> -----------------------------------------------------
class PoolPump extends PoolFlowComponent{
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
    
    // Pump uses dynamic connection points (input/output will be calculated automatically)
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
customElements.define('pool-equipment-pump', PoolPump);

// -- <pool-equipment-heater> ---------------------------------------------------
class PoolHeater extends PoolFlowComponent{
  constructor(){
    super();
    this.attachShadow({mode:'open'});
    adoptDiagramStyles(this.shadowRoot);
    this.shadowRoot.innerHTML = `<div class="heater" id="box"><div class="txt">HEATER</div></div>`;
    this.$box  = this.shadowRoot.getElementById('box');
    
    // Heater uses dynamic connection points (input/output will be calculated automatically)
  }
  setOn(on){ this.$box.classList.toggle('on', !!on); }
}
customElements.define('pool-equipment-heater', PoolHeater);

// ===== Pool Flow System Components =====

// ===== Pool Water Body Component =====
class PoolWaterBody extends PoolFlowComponent {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.type = 'pool'; // 'pool' or 'spa'
    this.temperature = 78; // default temp
    
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 120px;
          height: 80px;
        }
        .water-body {
          width: 100%;
          height: 100%;
          border-radius: 12px;
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          border: 2px solid rgba(255,255,255,0.1);
          box-shadow: inset 0 2px 8px rgba(0,0,0,0.3), 0 4px 12px rgba(37,99,235,0.2);
          position: relative;
          overflow: hidden;
	  z-index: 10;
        }
        .water-body.spa {
          background: linear-gradient(135deg, #dc2626, #b91c1c);
          box-shadow: inset 0 2px 8px rgba(0,0,0,0.3), 0 4px 12px rgba(220,38,38,0.2);
        }
        .temperature {
          position: absolute;
          bottom: 4px;
          right: 6px;
          font-size: 0.7rem;
          color: white;
          font-weight: 600;
          text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        }
      </style>
      <div class="water-body">
        <div class="temperature">${this.temperature}°F</div>
      </div>
    `;
    
    // Water body uses dynamic connection points (inlet/outlet will be calculated automatically)
  }
  
  // Override getDynamicConnectionPoint to handle overlap prevention for water bodies
  getDynamicConnectionPoint(type) {
    const basePoint = super.getDynamicConnectionPoint(type);
    if (!basePoint) return null;
    
    // Get the other connection point type for this water body
    const otherType = type === 'input' ? 'output' : 'input';
    const otherAlias = otherType === 'input' ? 'inlet' : 'outlet';
    
    // Check if we have a pipe connection for the other type
    const diagram = this.getRootNode().host;
    if (!diagram) return basePoint;
    
    const connections = diagram.shadowRoot.querySelectorAll('pool-pipe');
    let hasOtherConnection = false;
    
    for (const pipe of connections) {
      if ((pipe.fromComponent === this.id && (pipe.fromPoint === otherType || pipe.fromPoint === otherAlias)) ||
          (pipe.toComponent === this.id && (pipe.toPoint === otherType || pipe.toPoint === otherAlias))) {
        hasOtherConnection = true;
        break;
      }
    }
    
    // If no other connection, no overlap to worry about
    if (!hasOtherConnection) return basePoint;
    
    // Calculate the other connection point to check for overlap
    const otherPoint = super.getDynamicConnectionPoint(otherType);
    if (!otherPoint) return basePoint;
    
    // Check if they're too close (likely on same side)
    const distance = Math.sqrt(
      (basePoint.x - otherPoint.x) ** 2 + (basePoint.y - otherPoint.y) ** 2
    );
    
    // If points are close, apply offset
    if (distance < 20) {
      const rect = this.getBoundingClientRect();
      const shedRect = diagram?.shadowRoot?.querySelector('.equipment-shed')?.getBoundingClientRect();
      
      if (shedRect) {
        // Determine which side we're on and apply appropriate offset
        const relativeX = basePoint.x - (rect.left - shedRect.left);
        const relativeY = basePoint.y - (rect.top - shedRect.top);
        
        // Check if we're on left/right sides (offset vertically) or top/bottom sides (offset horizontally)
        if (relativeX <= 10 || relativeX >= rect.width - 10) {
          // On left or right side - offset vertically
          const offset = type === 'input' ? -15 : 15; // inlet up, outlet down
          return {
            ...basePoint,
            y: basePoint.y + offset
          };
        } else {
          // On top or bottom side - offset horizontally  
          const offset = type === 'input' ? -15 : 15; // inlet left, outlet right
          return {
            ...basePoint,
            x: basePoint.x + offset
          };
        }
      }
    }
    
    return basePoint;
  }
  
  static get observedAttributes() { return ['type', 'temperature']; }
  
  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'type') {
      this.type = newVal;
      const body = this.shadowRoot.querySelector('.water-body');
      if (body) {
        body.classList.toggle('spa', newVal === 'spa');
      }
    } else if (name === 'temperature') {
      this.temperature = parseFloat(newVal) || 78;
      const tempEl = this.shadowRoot.querySelector('.temperature');
      if (tempEl) {
        tempEl.textContent = `${this.temperature}°F`;
      }
    }
  }
  
  setTemperature(temp) {
    this.temperature = temp;
    this.setAttribute('temperature', temp);
  }
}

// ===== Pool Filter Component =====
class PoolFilter extends PoolFlowComponent {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    adoptDiagramStyles(this.shadowRoot);
    
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 80px;
          height: 60px;
        }
        .filter {
          width: 100%;
          height: 100%;
          background: linear-gradient(135deg, #64748b, #475569);
          border: 2px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          position: relative;
          box-shadow: inset 0 2px 6px rgba(0,0,0,0.3), 0 4px 8px rgba(0,0,0,0.2);
        }
        .filter-media {
          position: absolute;
          inset: 8px;
          background: repeating-linear-gradient(
            90deg,
            #e2e8f0 0px,
            #e2e8f0 2px,
            #cbd5e1 2px,
            #cbd5e1 4px
          );
          border-radius: 4px;
          opacity: 0.8;
        }
      </style>
      <div class="filter">
        <div class="filter-media"></div>
      </div>
    `;
    
    // Filter uses dynamic connection points (input/output will be calculated automatically)
  }
}

// ===== Pool Pipe Component =====
class PoolPipe extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.fromComponent = null;
    this.fromPoint = null;
    this.toComponent = null;
    this.toPoint = null;
    this.flowing = false;
    
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: absolute;
          pointer-events: none;
          z-index: 1;
          top: 0;
          left: 0;
        }
        svg {
          position: absolute;
          overflow: visible;
        }
        .pipe-path {
          fill: none;
          stroke: #162038;
          stroke-width: 12;
          filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
        }
        .pipe-path.flowing {
          stroke: #60a5fa;
          filter: drop-shadow(0 0 8px rgba(96,165,250,0.4));
        }
        
        /* Partial flow intensity classes for pipes */
        .pipe-path.flow_10pct { stroke: #60a5fa; opacity: 0.1; }
        .pipe-path.flow_20pct { stroke: #60a5fa; opacity: 0.2; }
        .pipe-path.flow_30pct { stroke: #60a5fa; opacity: 0.3; }
        .pipe-path.flow_40pct { stroke: #60a5fa; opacity: 0.4; }
        .pipe-path.flow_50pct { stroke: #60a5fa; opacity: 0.5; }
        .pipe-path.flow_60pct { stroke: #60a5fa; opacity: 0.6; }
        .pipe-path.flow_70pct { stroke: #60a5fa; opacity: 0.7; }
        .pipe-path.flow_80pct { stroke: #60a5fa; opacity: 0.8; }
        .pipe-path.flow_90pct { stroke: #60a5fa; opacity: 0.9; }
        .pipe-path.flow_100pct { stroke: #60a5fa; opacity: 1.0; }
        .flow-animation {
          fill: none;
          stroke: rgba(255,255,255,0.6);
          stroke-width: 4;
          stroke-dasharray: 8 4;
          opacity: 0;
        }
        .pipe-path.flowing + .flow-animation {
          opacity: 1;
          animation: flow 1.5s linear infinite;
        }
        @keyframes flow {
          from { stroke-dashoffset: 12; }
          to { stroke-dashoffset: 0; }
        }
      </style>
      <svg width="100%" height="100%">
        <path class="pipe-path" d="M 0 0"></path>
        <path class="flow-animation" d="M 0 0"></path>
      </svg>
    `;
  }
  
  static get observedAttributes() { return ['from', 'to', 'flowing']; }
  
  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'from') {
      const [componentId, pointName] = newVal.split('.');
      this.fromComponent = componentId;
      this.fromPoint = pointName;
      this.updatePath();
    } else if (name === 'to') {
      const [componentId, pointName] = newVal.split('.');
      this.toComponent = componentId;
      this.toPoint = pointName;
      this.updatePath();
    } else if (name === 'flowing') {
      this.flowing = newVal === 'true';
      this.updateFlowState();
    }
  }
  
  updatePath() {
    if (!this.fromComponent || !this.toComponent) return;
    
    // Look for components in the diagram's shadow root
    const diagram = this.getRootNode().host;
    if (!diagram) return;
    
    const fromEl = diagram.shadowRoot.getElementById(this.fromComponent);
    const toEl = diagram.shadowRoot.getElementById(this.toComponent);
    
    if (!fromEl || !toEl) {
      console.warn(`Pipe components not found: ${this.fromComponent} or ${this.toComponent}`);
      return;
    }
    
    const fromCoords = fromEl.getConnectionPoint?.(this.fromPoint);
    const toCoords = toEl.getConnectionPoint?.(this.toPoint);
    
    if (!fromCoords || !toCoords) {
      console.warn(`Connection points not found: ${this.fromComponent}.${this.fromPoint} or ${this.toComponent}.${this.toPoint}`);
      return;
    }
    
    // Calculate path with straight segments and 90° turns
    const dx = toCoords.x - fromCoords.x;
    const dy = toCoords.y - fromCoords.y;
    
    // Create Manhattan routing path (straight lines with 90° turns)
    const path = this.createManhattanPath(fromCoords, toCoords);
    
    const svg = this.shadowRoot.querySelector('svg');
    const pipePath = this.shadowRoot.querySelector('.pipe-path');
    const flowPath = this.shadowRoot.querySelector('.flow-animation');
    
    // Set SVG viewBox to encompass the Manhattan path
    const minX = Math.min(fromCoords.x, toCoords.x) - 10;
    const minY = Math.min(fromCoords.y, toCoords.y) - 10;
    const maxX = Math.max(fromCoords.x, toCoords.x) + 10;
    const maxY = Math.max(fromCoords.y, toCoords.y) + 10;
    const width = maxX - minX;
    const height = maxY - minY;
    
    // Position the SVG relative to the equipment shed
    svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
    svg.style.width = width + 'px';
    svg.style.height = height + 'px';
    svg.style.left = minX + 'px';
    svg.style.top = minY + 'px';
    
    // Ensure the pipe host element fills the entire equipment shed
    this.style.width = '100%';
    this.style.height = '100%';
    
    pipePath.setAttribute('d', path);
    flowPath.setAttribute('d', path);
  }
  
  createManhattanPath(fromCoords, toCoords) {
    const startX = fromCoords.x;
    const startY = fromCoords.y;
    const endX = toCoords.x;
    const endY = toCoords.y;
    
    const dx = endX - startX;
    const dy = endY - startY;
    
    let path = `M ${startX} ${startY}`;
    
    // If already aligned (horizontal or vertical), use 0 turns (straight line)
    if (Math.abs(dx) <= 1) {
      // Vertically aligned
      path += ` L ${endX} ${endY}`;
    } else if (Math.abs(dy) <= 1) {
      // Horizontally aligned
      path += ` L ${endX} ${endY}`;
    } else {
      // Need to route with 2 turns for cleaner paths
      // Place turns at midpoints for equal-length segments
      
      // Choose routing direction based on the longer distance
      if (Math.abs(dx) >= Math.abs(dy)) {
        // Horizontal-dominant: horizontal → vertical → horizontal
        // Split the horizontal distance in half
        const midX = startX + dx / 2;
        
        path += ` L ${midX} ${startY}`;   // First segment: half horizontal
        path += ` L ${midX} ${endY}`;     // Second segment: full vertical
        path += ` L ${endX} ${endY}`;     // Third segment: half horizontal
      } else {
        // Vertical-dominant: vertical → horizontal → vertical  
        // Split the vertical distance in half
        const midY = startY + dy / 2;
        
        path += ` L ${startX} ${midY}`;   // First segment: half vertical
        path += ` L ${endX} ${midY}`;     // Second segment: full horizontal
        path += ` L ${endX} ${endY}`;     // Third segment: half vertical
      }
    }
    
    return path;
  }

  updateFlowState() {
    const pipePath = this.shadowRoot.querySelector('.pipe-path');
    
    // Clear all flow classes
    pipePath.classList.remove('flowing', 'flow_10pct', 'flow_20pct', 'flow_30pct', 'flow_40pct',
                             'flow_50pct', 'flow_60pct', 'flow_70pct', 'flow_80pct', 'flow_90pct', 'flow_100pct');
    
    // Apply appropriate flow class based on intensity
    if (this.flowIntensity > 0) {
      if (this.flowIntensity >= 1.0) {
        pipePath.classList.add('flowing'); // Full flow
      } else {
        const percentage = Math.round(this.flowIntensity * 10) * 10; // Round to nearest 10%
        const clampedPercentage = Math.max(10, Math.min(100, percentage)); // Clamp between 10-100%
        pipePath.classList.add(`flow_${clampedPercentage}pct`);
      }
    }
  }
  
  setFlow(flowIntensity) {
    this.flowIntensity = typeof flowIntensity === 'number' ? flowIntensity : (flowIntensity ? 1.0 : 0);
    this.flowing = this.flowIntensity > 0;
    this.setAttribute('flowing', this.flowing);
    this.updateFlowState();
  }
}

// ===== Simple Equipment Components =====

class PoolDrain extends PoolFlowComponent {
  constructor() {
    super();
    this.defineConnectionPoint('port', 10, 10, 'output');
  }
  
  connectedCallback() {
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 20px;
          height: 20px;
        }
        .drain {
          width: calc(100% - 2px);
          height: calc(100% - 2px);
          border-radius: 50%;
          background: #4a5568;
          border: 1px solid rgba(255,255,255,0.2);
        }
      </style>
      <div class="drain"></div>
    `;
    
    adoptDiagramStyles(this.shadowRoot);
  }
}

class PoolSkimmer extends PoolFlowComponent {
  constructor() {
    super();
    this.defineConnectionPoint('port', 15, 6, 'output');
  }
  
  connectedCallback() {
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 30px;
          height: 12px;
        }
        .skimmer {
          width: calc(100% - 2px);
          height: calc(100% - 2px);
          border-radius: 6px;
          background: #6b7280;
          border: 1px solid rgba(255,255,255,0.2);
        }
      </style>
      <div class="skimmer"></div>
    `;
    
    adoptDiagramStyles(this.shadowRoot);
  }
}

class PoolInlet extends PoolFlowComponent {
  constructor() {
    super();
    this.defineConnectionPoint('port', 10, 10, 'input');
  }
  
  connectedCallback() {
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 20px;
          height: 20px;
        }
        .inlet {
          width: calc(100% - 2px);
          height: calc(100% - 2px);
          border-radius: 50%;
          background: #059669;
          border: 1px solid rgba(255,255,255,0.2);
        }
      </style>
      <div class="inlet"></div>
    `;
    
    adoptDiagramStyles(this.shadowRoot);
  }
}

// ===== Pool Flow Model =====
class PoolFlowModel {
  constructor() {
    this.components = new Map();
    this.connections = [];
  }
  
  addComponent(id, config) {
    this.components.set(id, { id, ...config });
  }
  
  addConnection(fromComp, fromPort, toComp, toPort) {
    this.connections.push({ fromComp, fromPort, toComp, toPort });
  }
  
  calculateFlows() {
    const flows = {};
    
    // Simple approach: if pump is running, trace the flow path
    const pumpRunning = Array.from(this.components.values()).some(comp => 
      comp.type === 'pump' && comp.running
    );
    
    if (!pumpRunning) {
      // No pump running, no flow anywhere
      return flows;
    }
    
    // Find pump and trace flow paths with intensity
    for (const [pumpId, comp] of this.components) {
      if (comp.type === 'pump' && comp.running) {
        console.log(`Pump ${pumpId} running - tracing flows with intensity`);
        console.log('All connections:', this.connections);
        console.log('Valve positions:', 
          Array.from(this.components.entries()).filter(([id, c]) => c.type === 'valve').map(([id, c]) => `${id}:${c.position}`)
        );
        
        // Start from pump output and follow connections with full intensity
        this.traceFlowFromComponent(pumpId, 'output', flows, new Set(), 1.0);
        
        // Trace backward from pump input to find suction sources with full intensity
        this.traceFlowToComponent(pumpId, 'input', flows, new Set(), 1.0);
      }
    }
    
    return flows;
  }
  
  traceFlowFromComponent(componentId, portId, flows, visited, intensity) {
    const key = `${componentId}.${portId}`;
    if (visited.has(key)) return; // Avoid cycles
    visited.add(key);
    
    // Find all connections from this component/port
    for (const conn of this.connections) {
      if (conn.fromComp === componentId && conn.fromPort === portId) {
        const toComp = this.components.get(conn.toComp);
        if (!toComp) continue;
        
        // Check if flow can pass through this connection
        const flowCoeff = this.getFlowCoefficient(conn, this.components.get(componentId), toComp);
        
        console.log(`Checking connection ${conn.fromComp}.${conn.fromPort} -> ${conn.toComp}.${conn.toPort}: flowCoeff=${flowCoeff}`);
        
        if (flowCoeff > 0) {
          const connectionIntensity = intensity * flowCoeff;
          const flowKey = `${conn.fromComp}.${conn.fromPort}-${conn.toComp}.${conn.toPort}`;
          flows[flowKey] = connectionIntensity;
          
          console.log(`→ ${flowKey} (intensity: ${connectionIntensity})`);
          
          // Continue tracing from the destination component
          if (toComp.type === 'passthrough') {
            // For passthrough components, continue from output with same intensity
            this.traceFlowFromComponent(conn.toComp, 'output', flows, visited, connectionIntensity);
          } else if (toComp.type === 'valve') {
            // For valves, flow entering one port can exit through other ports
            const valvePortEntered = conn.toPort;
            
            // Check flow from this port to all other valve ports
            const valvePorts = ['left', 'right', 'bottom'];
            for (const exitPort of valvePorts) {
              if (exitPort !== valvePortEntered) {
                const internalFlowCoeff = this.getValveFlowCoefficient(valvePortEntered, exitPort, toComp.position || 0, toComp.reversed || false);
                if (internalFlowCoeff > 0) {
                  const exitIntensity = connectionIntensity * internalFlowCoeff;
                  // Continue tracing from this valve port
                  this.traceFlowFromComponent(conn.toComp, exitPort, flows, visited, exitIntensity);
                }
              }
            }
          }
        }
      }
    }
  }
  
  traceFlowToComponent(componentId, portId, flows, visited, intensity) {
    const key = `${componentId}.${portId}`;
    if (visited.has(key)) return;
    visited.add(key);
    
    // Find all connections to this component/port
    for (const conn of this.connections) {
      if (conn.toComp === componentId && conn.toPort === portId) {
        const fromComp = this.components.get(conn.fromComp);
        if (!fromComp) continue;
        
        const flowCoeff = this.getFlowCoefficient(conn, fromComp, this.components.get(componentId));
        
        if (flowCoeff > 0) {
          const connectionIntensity = intensity * flowCoeff;
          const flowKey = `${conn.fromComp}.${conn.fromPort}-${conn.toComp}.${conn.toPort}`;
          flows[flowKey] = connectionIntensity;
          
          console.log(`→ ${flowKey} (intensity: ${connectionIntensity})`);
          
          // Continue tracing backward
          if (fromComp.type === 'passthrough') {
            this.traceFlowToComponent(conn.fromComp, 'input', flows, visited, connectionIntensity);
          } else if (fromComp.type === 'valve') {
            // For valves, flow exiting one port could have come from other ports
            const valvePortExited = conn.fromPort;
            
            // Check flow from all other valve ports to this port
            const valvePorts = ['left', 'right', 'bottom'];
            for (const entryPort of valvePorts) {
              if (entryPort !== valvePortExited) {
                const internalFlowCoeff = this.getValveFlowCoefficient(entryPort, valvePortExited, fromComp.position || 0, fromComp.reversed || false);
                if (internalFlowCoeff > 0) {
                  const entryIntensity = connectionIntensity / internalFlowCoeff; // Reverse calculation
                  // Continue tracing to this valve port
                  this.traceFlowToComponent(conn.fromComp, entryPort, flows, visited, entryIntensity);
                }
              }
            }
          } else if (fromComp.type === 'reservoir') {
            // Reached a source, flow is complete
          }
        }
      }
    }
  }
  
  getEffectivePressure(componentId, portId, pressures) {
    const comp = this.components.get(componentId);
    
    // For pumps, use the specific input/output pressure
    if (comp?.type === 'pump' && comp.running) {
      if (portId === 'input') return pressures.get(componentId + '_input') || 0;
      if (portId === 'output') return pressures.get(componentId + '_output') || 0;
    }
    
    // For open reservoirs (pools/spas), inlet and outlet are isolated
    // Both are always at atmospheric pressure (0)
    if (comp?.type === 'reservoir') {
      return 0; // Always atmospheric pressure for open water bodies
    }
    
    return pressures.get(componentId) || 0;
  }
  
  getFlowCoefficient(connection, fromComp, toComp) {
    const { fromComp: fromId, fromPort, toComp: toId, toPort } = connection;
    
    // Check if either component is a valve
    if (fromComp.type === 'valve') {
      // Flow OUT of a valve: map external port names to 'external'
      const mappedToPort = (toPort === 'inlet' || toPort === 'input' || toPort === 'output') ? 'external' : toPort;
      const coeff = this.getValveFlowCoefficient(fromPort, mappedToPort, fromComp.position || 0, fromComp.reversed || false);
      console.log(`Valve ${fromId} OUT: ${fromPort}->${mappedToPort} pos=${fromComp.position}: ${coeff}`);
      return coeff;
    }
    
    if (toComp.type === 'valve') {
      // Flow INTO a valve: use valve's port name (toPort)
      const coeff = this.getValveFlowCoefficient('external', toPort, toComp.position || 0, toComp.reversed || false);
      console.log(`Valve ${toId} IN: external->${toPort} pos=${toComp.position}: ${coeff}`);
      return coeff;
    }
    
    // For non-valve components
    if (fromComp.type === 'pump' && fromComp.running) {
      return 1.0; // Pump provides full flow when running
    }
    
    if (fromComp.type === 'reservoir' || toComp.type === 'reservoir') {
      return 1.0; // Open water bodies have no flow restriction
    }
    
    return 1.0; // No flow restriction for equipment (only valves control flow)
  }
  
  getValveFlowCoefficient(fromPort, toPort, position, reversed = false) {
    // 3-way valve with bottom port always open
    // Position controls proportional split between left/right ports
    let pos = Math.max(0, Math.min(100, position)) / 100; // Normalize to 0-1
    
    // If valve is reversed, flip the position for left/right calculations
    if (reversed) {
      pos = 1 - pos;
    }
    
    // Handle external connections into valve ports
    if (fromPort === 'external') {
      // Flow coming into the valve from outside
      if (toPort === 'bottom') return 1.0; // Bottom port always accepts flow
      if (toPort === 'left') return pos;    // Left port accepts flow based on position
      if (toPort === 'right') return 1 - pos; // Right port accepts inverse flow
    }
    
    // Handle flow between valve ports
    if (fromPort === 'bottom') {
      if (toPort === 'left') return pos;      // Bottom to left based on position
      if (toPort === 'right') return 1 - pos; // Bottom to right inverse
      if (toPort === 'external') return 1.0;  // Bottom can always flow out
    }
    
    if (fromPort === 'left') {
      if (toPort === 'bottom') return pos;    // Left to bottom based on position
      if (toPort === 'external') return pos;  // Left can flow out based on position
    }
    
    if (fromPort === 'right') {
      if (toPort === 'bottom') return 1 - pos; // Right to bottom inverse
      if (toPort === 'external') return 1 - pos; // Right can flow out inverse
    }
    
    // Direct left-right connections are blocked
    if ((fromPort === 'left' && toPort === 'right') || (fromPort === 'right' && toPort === 'left')) {
      return 0;
    }
    
    console.log(`No valve flow path: ${fromPort} -> ${toPort}`);
    return 0;
  }
  
  enforceFlowConservation(flowRates, pressures) {
    // For each valve, ensure flow in = flow out
    for (const [id, comp] of this.components) {
      if (comp.type !== 'valve') continue;
      
      let totalInflow = 0;
      let totalOutflow = 0;
      
      // Calculate total inflow and outflow for this valve
      for (const [flowKey, rate] of flowRates) {
        const [from, to] = flowKey.split('-');
        const [fromComp, fromPort] = from.split('.');
        const [toComp, toPort] = to.split('.');
        
        if (toComp === id) {
          totalInflow += Math.max(0, rate);
        }
        if (fromComp === id) {
          totalOutflow += Math.max(0, rate);
        }
      }
      
      // Adjust flow rates to maintain conservation
      const imbalance = totalInflow - totalOutflow;
      if (Math.abs(imbalance) > 0.01) {
        // Adjust outflow rates proportionally
        const adjustment = imbalance / Math.max(1, totalOutflow);
        
        for (const [flowKey, rate] of flowRates) {
          const [from, to] = flowKey.split('-');
          const [fromComp] = from.split('.');
          
          if (fromComp === id && rate > 0) {
            flowRates.set(flowKey, rate * (1 + adjustment));
          }
        }
      }
    }
  }
}

// Register custom elements
customElements.define('pool-water-body', PoolWaterBody);
customElements.define('pool-equipment-filter', PoolFilter);
customElements.define('pool-equipment-drain', PoolDrain);
customElements.define('pool-equipment-skimmer', PoolSkimmer);
customElements.define('pool-equipment-inlet', PoolInlet);
customElements.define('pool-pipe', PoolPipe);

// ===== Pool Relay Status Panel =====
class PoolRelayPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.relayStates = {};
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          margin: 16px 0;
        }
        .relay-panel {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          padding: 16px;
        }
        .panel-title {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--muted, #9aa4b2);
          margin-bottom: 12px;
          text-align: center;
          letter-spacing: 0.5px;
        }
        .relay-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 8px;
        }
        .relay-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          transition: all 0.2s ease;
        }
        .relay-indicator {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: #4a5568;
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5);
          transition: all 0.2s ease;
          flex-shrink: 0;
        }
        .relay-indicator.on {
          background: #2bd576;
          box-shadow: 
            inset 0 1px 2px rgba(0, 0, 0, 0.3),
            0 0 8px rgba(43, 213, 118, 0.4);
        }
        .relay-label {
          font-size: 0.75rem;
          font-weight: 500;
          color: var(--text, #e8ecf1);
          opacity: 0.8;
        }
        .relay-pin {
          font-size: 0.7rem;
          color: var(--muted, #9aa4b2);
          margin-left: auto;
          opacity: 0.6;
        }
      </style>
      <div class="relay-panel">
        <div class="panel-title">GPIO Relay Status</div>
        <div class="relay-grid" id="relay-grid"></div>
      </div>
    `;
    
    this.$grid = this.shadowRoot.getElementById('relay-grid');
    this.setupRelayItems();
  }
  
  setupRelayItems() {
    const relays = [
      { key: 'RELAY_INFLOW', label: 'Inflow Valve', pin: 25 },
      { key: 'RELAY_OUTFLOW', label: 'Return Valve', pin: 24 },
      { key: 'PUMP', label: 'Pump', pin: 23 },
      { key: 'PUMP_TURBO', label: 'Pump Turbo', pin: 18 },
      { key: 'HEATER_SPA', label: 'Heater', pin: 14 }
    ];
    
    this.$grid.innerHTML = '';
    relays.forEach(relay => {
      const item = document.createElement('div');
      item.className = 'relay-item';
      item.innerHTML = `
        <div class="relay-indicator" id="indicator-${relay.key}"></div>
        <div class="relay-label">${relay.label}</div>
        <div class="relay-pin">P${relay.pin}</div>
      `;
      this.$grid.appendChild(item);
    });
  }
  
  updateRelayStates(gpioStates) {
    if (!gpioStates) return;
    
    this.relayStates = { ...gpioStates };
    
    // Update each relay indicator
    Object.entries(gpioStates).forEach(([pinKey, state]) => {
      const indicator = this.shadowRoot.getElementById(`indicator-${pinKey}`);
      if (indicator) {
        indicator.classList.toggle('on', state === 1);
      }
    });
  }
  
  getRelayStates() {
    return { ...this.relayStates };
  }
}

customElements.define('pool-relay-panel', PoolRelayPanel);

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

