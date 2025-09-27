#!/usr/bin/env node
/**
 * SPA control REST API + UI using libgpiod.
 *   GET /           -> serves templates/index.html
 *   GET /spa/on     -> start spa ON sequence (non-blocking)
 *   GET /spa/off    -> start spa OFF sequence (non-blocking)
 *   GET /status     -> { ok, state, busy, target, valve: { suction, return }, valveWaitMs }
 *
 * Run: sudo node pool-controller.js
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const gpiod = require('node-libgpiod');

// ---- Configuration Classes ----
class EquipmentState {
  constructor(pump = 'off', pumpSpeed = 'low', inflowValve = 'pool', outflowValve = 'pool', heater = 'off') {
    this.pump = pump;
    this.pumpSpeed = pumpSpeed;
    this.inflowValve = inflowValve;
    this.outflowValve = outflowValve;
    this.heater = heater;
  }

  static fromConfig(config) {
    return new EquipmentState(
      config.pump,
      config.pumpSpeed,
      config.inflowValve,
      config.outflowValve,
      config.heater
    );
  }

  copy() {
    return new EquipmentState(this.pump, this.pumpSpeed, this.inflowValve, this.outflowValve, this.heater);
  }
}

class ModeConfig {
  constructor(key, name, description, order, equipment, color) {
    this.key = key;
    this.name = name;
    this.description = description;
    this.order = order;
    this.equipment = EquipmentState.fromConfig(equipment);
    this.color = color;
  }

  static loadFromDirectory(modesDir) {
    const modes = new Map();
    const files = fs.readdirSync(modesDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const modePath = path.join(modesDir, file);
      const config = JSON.parse(fs.readFileSync(modePath, 'utf8'));
      const key = path.basename(file, '.json');

      modes.set(key, new ModeConfig(
        key,
        config.name,
        config.description,
        config.order || 999,
        config.equipment,
        config.color
      ));
    }

    return modes;
  }

  static getSortedModes(modes) {
    return Array.from(modes.values()).sort((a, b) => a.order - b.order);
  }
}

class PoolController {
  constructor(pins, gpio, simulator = false) {
    this.pins = pins;
    this.gpio = gpio;
    this.simulator = simulator;
    this.currentState = new EquipmentState();
    this.gpioStates = {};

    // Initialize GPIO states to 0
    Object.keys(pins).forEach(pinKey => {
      this.gpioStates[pinKey] = 0;
    });
  }

  setSimulatorMode(enabled) {
    this.simulator = enabled;
    console.log(`Simulator mode: ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  applyEquipmentState(equipmentState) {
    this.currentState = equipmentState.copy();

    // Calculate new GPIO states
    const newGpioStates = {
      PUMP: equipmentState.pump === 'on' ? 1 : 0,
      PUMP_TURBO: (equipmentState.pump === 'on' && equipmentState.pumpSpeed === 'high') ? 1 : 0,
      RELAY_INFLOW: equipmentState.inflowValve === 'spa' ? 1 : 0,
      RELAY_OUTFLOW: equipmentState.outflowValve === 'spa' ? 1 : 0,
      HEATER_SPA: equipmentState.heater === 'on' ? 1 : 0
    };

    // Update stored GPIO states
    this.gpioStates = { ...newGpioStates };

    if (this.simulator) {
      console.log(`[SIMULATOR] Would apply GPIO states:`, newGpioStates);
      return;
    }

    // Apply to actual GPIO pins
    Object.entries(newGpioStates).forEach(([pinKey, state]) => {
      this.gpio[this.pins[pinKey]].digitalWrite(state);
    });

    console.log(`Applied state: pump=${equipmentState.pump}/${equipmentState.pumpSpeed}, valves=${equipmentState.inflowValve}/${equipmentState.outflowValve}, heater=${equipmentState.heater}`);
  }

  applyMode(modeConfig) {
    this.applyEquipmentState(modeConfig.equipment);
  }

  getCurrentState() {
    return this.currentState.copy();
  }

  getGpioStates() {
    return { ...this.gpioStates };
  }
}

const app = express();

// ---- Hardware config (BCM numbering) ----
const PINS = {
  RELAY_INFLOW: 25,
  RELAY_OUTFLOW: 24,
  //HEATER_SPA:   23,
  //PUMP:         18,
  //PUMP_TURBO:   15,
  PUMP: 23,
  PUMP_TURBO: 18,
  HEATER_SPA: 14
};
const VALVE_WAIT_MS = 30_000;
const PORT = process.env.PORT || 8080;

// ---- Simulator mode ----
let simulatorMode = process.env.SIMULATOR_MODE === 'true' || false;
const explicitSimulatorMode = simulatorMode; // Track if user explicitly enabled simulator

if (explicitSimulatorMode) {
  console.log('🎮 Simulator mode explicitly enabled via SIMULATOR_MODE environment variable');
} else {
  console.log('🔍 Checking for GPIO hardware availability...');
}

// Function to toggle simulator mode
function toggleSimulatorMode(enabled) {
  if (!explicitSimulatorMode && !enabled && !gpioHardwareAvailable) {
    console.log('⚠️  Cannot disable simulator mode: GPIO hardware not available');
    return false;
  }

  simulatorMode = enabled;
  poolController.setSimulatorMode(enabled);
  console.log(`Simulator mode toggled: ${enabled ? 'ENABLED' : 'DISABLED'}`);
  return true;
}

// ---- Load modes and initialize controller ----
let modes;
let poolController;

try {
  modes = ModeConfig.loadFromDirectory(path.join(__dirname, 'modes'));
  console.log(`Loaded ${modes.size} modes:`, Array.from(modes.values()).map(m => m.name).join(', '));
} catch (err) {
  console.error('Failed to load modes:', err);
  process.exit(1);
}

// ---- GPIO init with hardware detection ----
const gpio = {};
let gpioHardwareAvailable = false;

// Function to detect GPIO hardware availability
function detectGpioHardware() {
  try {
    // Check for GPIO device accessibility (gpiod uses /dev/gpiochip*)
    if (!fs.existsSync('/dev/gpiochip0')) {
      console.log('GPIO device not accessible - /dev/gpiochip0 not found');
      return false;
    }

    // Test if gpiod can actually initialize (this will fail on non-Pi systems)
    try {
      const chip = new gpiod.Chip(0); // Use chip number instead of path
      const line = chip.getLine(25);
      line.requestOutputMode();
      line.setValue(0);
      line.release();
      chip.close();
      console.log('GPIO hardware validation successful');
      return true;
    } catch (initError) {
      console.log('GPIO initialization test failed:', initError.message);
      return false;
    }

  } catch (error) {
    console.log('GPIO hardware detection failed:', error.message);
    return false;
  }
}

// Check for GPIO hardware unless explicitly in simulator mode
if (!simulatorMode) {
  gpioHardwareAvailable = detectGpioHardware();

  if (!gpioHardwareAvailable) {
    console.log('⚠️  GPIO hardware not detected - automatically enabling simulator mode');
    simulatorMode = true;
  }
}

if (!simulatorMode && gpioHardwareAvailable) {
  console.log('🔌 Initializing GPIO hardware...');
  try {
    // Open GPIO chip
    const chip = new gpiod.Chip(0);
    
    for (const pin of Object.values(PINS)) {
      // Get line and configure as output
      const line = chip.getLine(pin);
      line.requestOutputMode();
      line.setValue(0);
      
      // Create wrapper object for compatibility
      gpio[pin] = {
        line: line,
        digitalWrite: (value) => line.setValue(value)
      };
      
      console.log(`GPIO ${pin} initialized -> LOW`);
    }
    
    // Store chip reference for cleanup
    gpio._chip = chip;
    console.log('✅ GPIO hardware initialized successfully');
  } catch (error) {
    console.error('❌ GPIO initialization failed:', error.message);
    console.log('🔄 Falling back to simulator mode...');
    simulatorMode = true;

    // Clean up any partially initialized GPIO
    try {
      Object.values(gpio).forEach(pinObj => {
        if (pinObj.line) pinObj.line.release();
      });
      if (gpio._chip) gpio._chip.close();
    } catch {}
  }
}

if (simulatorMode) {
  // Create mock GPIO objects for simulator mode
  for (const pin of Object.values(PINS)) {
    gpio[pin] = {
      digitalWrite: (value) => console.log(`[SIMULATOR] GPIO ${pin} -> ${value ? 'ON' : 'OFF'}`)
    };
  }
  console.log('🎮 Running in SIMULATOR MODE - GPIO operations will be logged only');
}

// Initialize pool controller
poolController = new PoolController(PINS, gpio, simulatorMode);

// ---- Helpers ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Status model ----
const status = {
  mode: 'auto',      // current mode key
  target: null,         // target mode key or null (for transitions)
  busy: false,
  lastError: null,
};

// ---- Valve position tracking (server-side; single % drives both suction/return) ----
const valve = {
  percent: 0,        // 0..100 stable value when not moving
  moving: false,
  from: 0,           // 0..100
  to: 0,             // 0..100
  startMs: 0,
  durationMs: VALVE_WAIT_MS,
};
function currentValvePercent() {
  if (!valve.moving) return valve.percent;
  const t = Math.max(0, Math.min(1, (Date.now() - valve.startMs) / valve.durationMs));
  return valve.from + (valve.to - valve.from) * t;
}

function statusPayload() {
  const pct = currentValvePercent(); // float, linear
  const currentMode = modes.get(status.mode);
  const targetMode = status.target ? modes.get(status.target) : null;

  return {
    ok: true,
    mode: status.mode,
    busy: status.busy,
    target: status.target,
    equipment: poolController.getCurrentState(),
    gpio: poolController.getGpioStates(),
    serverNow: Date.now(),
    valveWaitMs: VALVE_WAIT_MS,
    valve: {
      percent: pct,            // float, 0..100
      moving: valve.moving,
      from: valve.from,
      to: valve.to,
      startMs: valve.startMs,
      durationMs: valve.durationMs,
    },
    modes: ModeConfig.getSortedModes(modes).map(m => ({
      key: m.key,
      name: m.name,
      description: m.description,
      color: m.color,
      order: m.order
    })),
    simulator: simulatorMode,
    gpioHardwareAvailable: gpioHardwareAvailable,
    lastError: status.lastError,
  };
}

// ---- Mode switching ----
function getValvePercentForMode(modeKey) {
  const mode = modes.get(modeKey);
  if (!mode) return 0;

  // Calculate valve percentage based on valve positions
  // spa valves = 100%, pool valves = 0%
  if (mode.equipment.inflowValve === 'spa' && mode.equipment.outflowValve === 'spa') {
    return 100;
  } else {
    return 0;
  }
}

async function switchToMode(modeKey) {
  const targetMode = modes.get(modeKey);
  if (!targetMode) {
    throw new Error(`Unknown mode: ${modeKey}`);
  }

  try {
    status.busy = true;
    status.target = modeKey;
    console.log(`Switching to mode: ${targetMode.name}`);

    const currentValvePct = currentValvePercent();
    const targetValvePct = getValvePercentForMode(modeKey);

    // Start valve timeline if valve position needs to change
    if (currentValvePct !== targetValvePct) {
      valve.from = currentValvePct;
      valve.to = targetValvePct;
      valve.startMs = Date.now();
      valve.durationMs = VALVE_WAIT_MS;
      valve.moving = true;
      console.log(`Moving valves from ${currentValvePct}% to ${targetValvePct}%`);
    }

    // Apply equipment state immediately (except for final pump speed for spa mode)
    const equipmentState = targetMode.equipment.copy();
    if (modeKey === 'spa' && targetValvePct > currentValvePct) {
      // For spa mode, start with low speed during valve transition
      equipmentState.pumpSpeed = 'low';
    }

    poolController.applyEquipmentState(equipmentState);

    // Wait for valve transition if needed
    if (valve.moving) {
      console.log('Waiting for valve transition...');
      await sleep(VALVE_WAIT_MS);

      valve.percent = targetValvePct;
      valve.moving = false;

      // Apply final equipment state (e.g., high pump speed for spa)
      if (modeKey === 'spa') {
        poolController.applyEquipmentState(targetMode.equipment);
      }
    }

    status.mode = modeKey;
    console.log(`Mode switch complete: ${targetMode.name}`);

  } catch (e) {
    console.error(`Mode switch error (${modeKey}):`, e);
    status.lastError = String(e);

    // On error, try to go to safe service mode
    const serviceMode = modes.get('service');
    if (serviceMode && modeKey !== 'service') {
      poolController.applyEquipmentState(serviceMode.equipment);
      status.mode = 'service';
      valve.percent = 0;
      valve.moving = false;
    }
  } finally {
    status.busy = false;
    status.target = null;
  }
}

// ---- Routes ----
app.use(express.json());

// Switch to a specific mode
app.get('/mode/:modeKey', async (req, res) => {
  const { modeKey } = req.params;

  // Validate mode exists
  if (!modes.has(modeKey)) {
    return res.status(404).json({ ok: false, message: `Unknown mode: ${modeKey}` });
  }

  // Check if already in this mode and not busy
  if (!status.busy && status.mode === modeKey) {
    return res.json(statusPayload());
  }

  // Check if already switching to this mode
  if (status.busy && status.target === modeKey) {
    return res.json(statusPayload());
  }

  // Check if busy with another operation
  if (status.busy) {
    return res.status(409).json({ ok: false, busy: true, message: 'Busy with another operation' });
  }

  // Start the mode switch (non-blocking)
  switchToMode(modeKey);
  res.json(statusPayload());
});

// Get available modes
app.get('/modes', (req, res) => {
  const modesList = ModeConfig.getSortedModes(modes).map(m => ({
    key: m.key,
    name: m.name,
    description: m.description,
    color: m.color,
    order: m.order
  }));
  res.json({ ok: true, modes: modesList });
});

// Manual equipment control (switches to service mode)
app.post('/equipment/:type', (req, res) => {
  const { type } = req.params;
  const { state } = req.body;

  // Get current equipment state
  const currentState = poolController.getCurrentState();

  // Update specific equipment
  switch (type) {
    case 'pump':
      if (state === 'on' || state === 'off') {
        currentState.pump = state;
      }
      break;
    case 'pumpSpeed':
      if (state === 'low' || state === 'high') {
        currentState.pumpSpeed = state;
      }
      break;
    case 'inflowValve':
      if (state === 'pool' || state === 'spa') {
        currentState.inflowValve = state;
      }
      break;
    case 'outflowValve':
      if (state === 'pool' || state === 'spa') {
        currentState.outflowValve = state;
      }
      break;
    case 'heater':
      if (state === 'on' || state === 'off') {
        currentState.heater = state;
      }
      break;
    default:
      return res.status(400).json({ ok: false, message: `Unknown equipment type: ${type}` });
  }

  // Apply the updated state
  poolController.applyEquipmentState(currentState);

  // Switch to service mode
  status.mode = 'service';

  res.json(statusPayload());
});

// Legacy spa endpoints
app.get('/spa/on', async (req, res) => {
  req.params = { modeKey: 'spa' };
  const handler = app._router.stack.find(layer => 
    layer.route && layer.route.path === '/mode/:modeKey'
  );
  if (handler) {
    return handler.route.stack[0].handle(req, res);
  }
  res.status(500).json({ ok: false, message: 'Route handler not found' });
});

app.get('/spa/off', async (req, res) => {
  req.params = { modeKey: 'auto' };
  const handler = app._router.stack.find(layer => 
    layer.route && layer.route.path === '/mode/:modeKey'
  );
  if (handler) {
    return handler.route.stack[0].handle(req, res);
  }
  res.status(500).json({ ok: false, message: 'Route handler not found' });
});

app.get('/status', (_req, res) => res.json(statusPayload()));

// Simulator mode control
app.post('/simulator', (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, message: 'enabled field must be boolean' });
  }

  const success = toggleSimulatorMode(enabled);
  if (!success) {
    return res.status(400).json({ 
      ok: false, 
      message: 'Cannot disable simulator mode: GPIO hardware not available',
      simulator: simulatorMode,
      gpioHardwareAvailable: gpioHardwareAvailable
    });
  }

  res.json(statusPayload());
});

app.get('/simulator', (req, res) => {
  res.json({ ok: true, simulator: simulatorMode });
});

// ---- Static/template serving ----
app.use(express.static(path.join(__dirname, 'templates')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));

// ---- Cleanup on exit ----
process.on('SIGINT', () => {
  console.log('Cleaning up GPIO (setting all LOW)…');
  if (!simulatorMode && gpioHardwareAvailable) {
    try {
      // Set all pins LOW before cleanup
      for (const pin of Object.values(PINS)) {
        if (gpio[pin] && gpio[pin].line) {
          gpio[pin].line.setValue(0);
        }
      }
      
      // Release all lines and close chip
      Object.values(gpio).forEach(pinObj => {
        if (pinObj.line) pinObj.line.release();
      });
      if (gpio._chip) gpio._chip.close();
    } catch (error) {
      console.error('GPIO cleanup error:', error.message);
    }
  }
  process.exit();
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`SPA control server listening on port ${PORT}`);
  console.log(`Open http://<pi-ip>:${PORT}/`);
});

