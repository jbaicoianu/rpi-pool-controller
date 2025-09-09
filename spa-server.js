#!/usr/bin/env node
/**
 * SPA control REST API + UI using pigpio.
 *   GET /           -> serves templates/index.html
 *   GET /spa/on     -> start spa ON sequence (non-blocking)
 *   GET /spa/off    -> start spa OFF sequence (non-blocking)
 *   GET /status     -> { ok, state, busy, target, valve: { suction, return }, valveWaitMs }
 *
 * Run: sudo node spa-server.js
 */

const express = require('express');
const path = require('path');
const { Gpio } = require('pigpio');

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

// ---- GPIO init (fail-safe LOW) ----
const gpio = {};
for (const pin of Object.values(PINS)) {
  gpio[pin] = new Gpio(pin, { mode: Gpio.OUTPUT });
  gpio[pin].digitalWrite(0);
  console.log(`GPIO ${pin} initialized -> LOW`);
}

// ---- Helpers ----
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gpioOn  = (...pins) => pins.forEach(p => (gpio[p].digitalWrite(1), console.log(`Pin ${p} -> ON`)));
const gpioOff = (...pins) => pins.forEach(p => (gpio[p].digitalWrite(0), console.log(`Pin ${p} -> OFF`)));

// ---- Status model ----
const status = {
  state: 'off',         // "on" | "off" | "working"
  target: null,         // "on" | "off" | null
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
  return {
    ok: true,
    state: status.state,
    busy: status.busy,
    target: status.target,
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
    lastError: status.lastError,
  };
}

// ---- Non-blocking actions ----
async function doSpaOn() {
  try {
    status.busy = true;
    status.state = 'working';
    status.target = 'on';
    console.log('Spa ON: begin');

    // Start valve timeline now so all clients can reflect % immediately
    valve.from = currentValvePercent();
    valve.to = 100;
    valve.startMs = Date.now();
    valve.durationMs = VALVE_WAIT_MS;
    valve.moving = true;

    console.log('- Switch pump speed to LOW');
    gpioOff(PINS.PUMP_TURBO);

    console.log('- Turn on pump + heater, open relays');
    gpioOn(PINS.PUMP, PINS.RELAY_INFLOW, PINS.RELAY_OUTFLOW, PINS.HEATER_SPA);

    console.log('- Waiting for valves to finish…');
    await sleep(VALVE_WAIT_MS);

    console.log('- Switch pump speed to HIGH');
    gpioOn(PINS.PUMP_TURBO);

    valve.percent = 100;
    valve.moving = false;

    status.state = 'on';
    console.log('Spa ON: complete');
  } catch (e) {
    console.error('Spa ON error:', e);
    status.lastError = String(e);
    gpioOff(PINS.PUMP, PINS.PUMP_TURBO, PINS.RELAY_INFLOW, PINS.RELAY_OUTFLOW, PINS.HEATER_SPA);
    valve.percent = 0;
    valve.moving = false;
    status.state = 'off';
  } finally {
    status.busy = false;
    status.target = null;
  }
}

async function doSpaOff() {
  try {
    status.busy = true;
    status.state = 'working';
    status.target = 'off';
    console.log('Spa OFF: begin');

    // Start valve timeline back to 0%
    valve.from = currentValvePercent();
    valve.to = 0;
    valve.startMs = Date.now();
    valve.durationMs = VALVE_WAIT_MS;
    valve.moving = true;

    console.log('- Turn off pump + heater, close relays');
    gpioOff(PINS.PUMP, PINS.PUMP_TURBO, PINS.RELAY_INFLOW, PINS.RELAY_OUTFLOW, PINS.HEATER_SPA);

    console.log('- Waiting for valves to swing back…');
    await sleep(VALVE_WAIT_MS);

    valve.percent = 0;
    valve.moving = false

    status.state = 'off';
    console.log('Spa OFF: complete');
  } catch (e) {
    console.error('Spa OFF error:', e);
    status.lastError = String(e);
  } finally {
    status.busy = false;
    status.target = null;
  }
}

// ---- Routes (GET) ----
app.get('/spa/on', (req, res) => {
  if (!status.busy && status.state === 'on') return res.json(statusPayload());
  if (status.busy && status.target === 'on') return res.json(statusPayload());
  if (status.busy) return res.status(409).json({ ok: false, busy: true, message: 'Busy with another operation' });
  doSpaOn();
  res.json(statusPayload());
});

app.get('/spa/off', (req, res) => {
  if (!status.busy && status.state === 'off') return res.json(statusPayload());
  if (status.busy && status.target === 'off') return res.json(statusPayload());
  if (status.busy) return res.status(409).json({ ok: false, busy: true, message: 'Busy with another operation' });
  doSpaOff();
  res.json(statusPayload());
});
app.get('/pump/quickclean', (req, res) => {
  gpioOn(PINS.PUMP, PINS.PUMP_TURBO);
  gpioOff(PINS.RELAY_INFLOW, PINS.RELAY_OUTFLOW, PINS.HEATER_SPA);
  res.json(statusPayload());
});

app.get('/status', (_req, res) => res.json(statusPayload()));

// ---- Static/template serving ----
app.use(express.static(path.join(__dirname, 'templates')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));

// ---- Cleanup on exit ----
process.on('SIGINT', () => {
  console.log('Cleaning up GPIO (setting all LOW)…');
  for (const pin of Object.values(PINS)) {
    try { gpio[pin].digitalWrite(0); } catch {}
  }
  process.exit();
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`SPA control server listening on port ${PORT}`);
  console.log(`Open http://<pi-ip>:${PORT}/`);
});

