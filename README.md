# signalk-daly-companion

Companion plugin for [signalk-daly-bms-ble](https://github.com/marvin75/signalk-daly-bms-ble).

A Daly BMS accepts only **one** Bluetooth connection. While Signal K holds it, the Daly phone app cannot connect. This plugin adds:

- **Daly-App-Modus** – one tap pauses the Daly plugin for N minutes (default 30), drops the BLE links so the phone app can connect, and resumes automatically. Survives a server restart.
  - Web: `http://<server>:3000/plugins/signalk-daly-companion/pause` (bookmark it), `/resume`, `/status` (JSON)
  - Signal K: `PUT electrical.batteries.dalyAppMode` `true|false` → works as a switch in KIP; `electrical.batteries.dalyAppModeUntil` shows the end time
- **Alarms** as Signal K notifications (`notifications.electrical.batteries.<id>.*`): BMS error bits, cell delta, max temperature, low SOC, MOSFET off, stale data
- **Web view** `http://<server>:3000/signalk-daly-companion/` – both banks Daly-app style: V/A/W/SOC, remaining Ah, cycles, cell voltages with min/max/balancing, temperatures, MOSFETs, alarms, pause button

Banks and MAC addresses are read from the Daly plugin's own configuration – nothing to duplicate.

> Uses the server's plugin API on localhost to stop/start the Daly plugin; with server security enabled, allow the plugin's requests (token) or run with security off.

MIT
