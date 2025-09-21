# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Raspberry Pi-based spa/pool controller system that provides a web interface for controlling spa equipment via GPIO pins. The system controls pumps, valves, and heaters through relays connected to GPIO pins using the pigpio library.

## Architecture

**Backend (`spa-server.js`)**:
- Express.js REST API server that controls GPIO hardware
- Uses pigpio library for GPIO control via BCM pin numbering
- Implements non-blocking mode switching with valve timing
- Provides real-time status API with valve position tracking
- Hardware configuration in PINS object (lines 18-28)

**Frontend (`templates/`)**:
- Single Page Application with custom web components
- Real-time valve animation synchronized across multiple clients
- CSS custom properties for theming and component styling
- Custom elements: `<pool-diagram>`, `<pool-equipment-valve>`, `<pool-equipment-pump>`, `<pool-equipment-heater>`

**Key Patterns**:
- Server-side valve timeline synchronization prevents client desync
- Clock skew compensation for multi-client consistency
- CSS-in-JS shadow DOM styling with shared stylesheet adoption
- Non-blocking async operations with busy state management

## Development Commands

**Install dependencies**:
```bash
npm install
```

**Run the server**:
```bash
npm start
# or directly: sudo node spa-server.js
```

**Development with auto-reload**:
```bash
npm run start:dev
# Uses nodemon for automatic restarts on file changes
```

**Simulator mode** (for testing without GPIO hardware):
```bash
# Explicitly enable simulator mode
SIMULATOR_MODE=true npm start
# or
SIMULATOR_MODE=true npm run start:dev

# On non-Pi systems, simulator mode is automatically enabled
npm start  # Will auto-detect no GPIO and enable simulator
```

**Environment variables**:
- `PORT`: Server port (default: 8080)
- `SIMULATOR_MODE`: Set to 'true' to bypass GPIO operations (default: false)

**Development on non-Pi systems**:
```bash
# No sudo required, GPIO hardware auto-detected
npm install
npm start
```

**Production on Raspberry Pi**:
```bash
# Requires sudo for GPIO access
sudo npm start
```

**Note**: The system automatically detects GPIO hardware availability. On non-Pi systems or when GPIO is unavailable, simulator mode is automatically enabled.

## Hardware Configuration

GPIO pins (BCM numbering) defined in `spa-server.js:19-28`:
- Pin 25: RELAY_INFLOW (suction valve)
- Pin 24: RELAY_OUTFLOW (return valve)  
- Pin 23: PUMP (main pump)
- Pin 18: PUMP_TURBO (high speed mode)
- Pin 14: HEATER_SPA (spa heater)

Valve operation timing: 30 seconds (`VALVE_WAIT_MS`)

## API Endpoints

**Core endpoints**:
- `GET /` - Serves web interface
- `GET /status` - Current system status with valve position and simulator state
- `GET /modes` - List all available pool modes
- `GET /mode/:modeKey` - Switch to specific mode (auto, spa, turbo-clean, service)

**Equipment control**:
- `POST /equipment/:type` - Manual equipment control (pump, pumpSpeed, inflowValve, outflowValve, heater)

**Simulator mode**:
- `GET /simulator` - Get current simulator mode status
- `POST /simulator` - Toggle simulator mode (body: `{"enabled": boolean}`)

**Legacy endpoints**:
- `GET /spa/on` - Switch to spa mode (legacy)
- `GET /spa/off` - Switch to auto mode (legacy)

## Key Files

- `spa-server.js` - Main server and hardware control logic
- `templates/index.html` - Web interface HTML
- `templates/app.js` - Frontend JavaScript with custom components
- `templates/app.css` - Main UI styling
- `templates/diagram.css` - Component-specific styles loaded into shadow roots

## Development Notes

- System uses fail-safe LOW state for all GPIO pins on startup
- Valve positions are tracked server-side with linear interpolation
- Frontend uses requestAnimationFrame for smooth valve animations
- Clock skew compensation keeps multiple clients synchronized
- All GPIO operations include console logging for debugging

## Simulator Mode

Simulator mode allows safe testing of the pool controller without affecting real hardware:

- **Auto-detection**: Automatically enabled when GPIO hardware is not available
- **Manual enable**: Set `SIMULATOR_MODE=true` environment variable
- **GPIO bypass**: All GPIO operations are logged instead of executed
- **UI indication**: Clear simulator banner shown when active
- **Smart toggle**: Can only be disabled if GPIO hardware is available
- **Development friendly**: Perfect for testing on laptops, desktops, or non-Pi systems

### GPIO Hardware Detection

The system automatically detects GPIO availability on startup:
- ✅ **Pi with GPIO**: Initializes real GPIO control
- ⚠️ **No GPIO detected**: Automatically enables simulator mode
- 🚫 **GPIO init fails**: Falls back to simulator mode
- 🎮 **Explicit simulator**: Honors `SIMULATOR_MODE=true` setting