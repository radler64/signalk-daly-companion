'use strict';
/*
 * signalk-daly-companion
 *
 *  - "Daly-App-Modus": pauses signalk-daly-bms-ble for N minutes and drops the
 *    BLE links so the Daly phone app can connect. Auto-resumes. Survives a
 *    server restart (state file). Controlled via PUT on
 *    electrical.batteries.dalyAppMode (KIP switch) or GET /plugins/<id>/pause|resume.
 *  - Alarms: Signal K notifications for BMS error bits, cell delta, temperature,
 *    low SOC and stale data.
 *  - Web view: /signalk-daly-companion/ (Daly-app style, both banks, pause button).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const MODE_PATH = 'electrical.batteries.dalyAppMode';
const UNTIL_PATH = 'electrical.batteries.dalyAppModeUntil';
const K0 = 273.15;

module.exports = function (app) {
  const plugin = { id: 'signalk-daly-companion', name: 'Daly Companion (App-Modus + Alarme)' };
  plugin.description = 'Pause button for the Daly BLE plugin (frees Bluetooth for the Daly app), battery alarms, compact web view.';

  let opts = {};
  let resumeTimer = null;
  let tickTimer = null;
  let pausedUntil = null;
  const unsubs = [];
  const alarmState = {}; // key -> 'normal' | 'warn' | 'alarm'
  const lastSeen = {};   // batteryId -> ms
  let solarHist = {};    // { mpptId: { 'YYYY-MM-DD': { wh: number, peakW: number } } }
  let histDirty = false;

  plugin.schema = {
    type: 'object',
    properties: {
      dalyPluginId: { type: 'string', title: 'ID des Daly-Plugins', default: 'signalk-daly-bms-ble' },
      pauseMinutes: { type: 'number', title: 'Pause-Dauer (min), danach automatisch weiter', default: 30 },
      labels: {
        type: 'string', title: 'Anzeigenamen (batteryId=Name, kommagetrennt)',
        default: 'service24=24 V Service,service12=12 V Service'
      },
      alarms: {
        type: 'object', title: 'Alarme',
        properties: {
          enabled: { type: 'boolean', title: 'Alarme aktiv', default: true },
          cellDeltaV: { type: 'number', title: 'Zell-Delta Alarm (V)', default: 0.1 },
          tempC: { type: 'number', title: 'Temperatur Alarm (°C)', default: 45 },
          socLow: { type: 'number', title: 'SOC niedrig (0–1)', default: 0.2 },
          staleSec: { type: 'number', title: 'Keine Daten seit (s) → Warnung', default: 120 }
        }
      }
    }
  };

  // ------------------------------------------------------------- helpers
  const dataDir = () => app.getDataDirPath();
  const stateFile = () => path.join(dataDir(), 'state.json');
  const dalyCfgFile = () => path.join(app.config.configPath, 'plugin-config-data', `${opts.dalyPluginId}.json`);
  const port = () => (app.config.settings && app.config.settings.port) || 3000;

  function readDalyCfg() {
    try { return JSON.parse(fs.readFileSync(dalyCfgFile(), 'utf8')); } catch (e) { return null; }
  }
  function batteries() {
    const cfg = readDalyCfg();
    return ((cfg && cfg.configuration && cfg.configuration.batteries) || [])
      .filter((b) => b.batteryId && b.device);
  }
  function labelMap() {
    const m = {};
    String(opts.labels || '').split(',').forEach((kv) => {
      const [k, v] = kv.split('=').map((s) => (s || '').trim());
      if (k && v) m[k] = v;
    });
    return m;
  }
  function saveState() {
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({ pausedUntil, solarHist }));
    } catch (e) { app.debug(`state save failed: ${e.message}`); }
  }
  function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return {}; }
  }
  function emit(values) {
    app.handleMessage(plugin.id, { updates: [{ values }] });
  }
  function emitMode() {
    emit([
      { path: MODE_PATH, value: !!pausedUntil },
      { path: UNTIL_PATH, value: pausedUntil ? new Date(pausedUntil).toISOString() : null }
    ]);
  }
  function status() {
    if (pausedUntil) {
      const min = Math.max(0, Math.round((pausedUntil - Date.now()) / 60000));
      app.setPluginStatus(`Daly-App-Modus aktiv – noch ${min} min, dann automatisch weiter`);
    } else {
      const cfg = readDalyCfg();
      app.setPluginStatus(cfg && cfg.enabled === false
        ? 'Daly-Plugin ist manuell deaktiviert – /resume oder Schalter aus→ein schaltet es wieder ein'
        : `Bereit – Daly-Plugin läuft (${batteries().length} Bänke überwacht)`);
    }
  }

  async function setDalyEnabled(enabled) {
    const cfg = readDalyCfg();
    if (!cfg) throw new Error(`config of ${opts.dalyPluginId} not found`);
    cfg.enabled = enabled;
    const res = await fetch(`http://127.0.0.1:${port()}/skServer/plugins/${opts.dalyPluginId}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg)
    });
    if (!res.ok) throw new Error(`plugin API HTTP ${res.status}`);
  }
  function btDisconnect(mac) {
    return new Promise((resolve) => execFile('bluetoothctl', ['disconnect', mac], { timeout: 8000 }, () => resolve()));
  }

  // ------------------------------------------------------------- pause / resume
  async function pause(minutes) {
    const min = Number(minutes) > 0 ? Number(minutes) : opts.pauseMinutes || 30;
    pausedUntil = Date.now() + min * 60000;
    saveState();
    await setDalyEnabled(false);
    // give the plugin a moment to stop, then make sure BlueZ really let go
    setTimeout(() => batteries().forEach((b) => btDisconnect(b.device)), 3000);
    scheduleResume();
    emitMode(); status();
    app.debug(`paused for ${min} min`);
    return { paused: true, until: new Date(pausedUntil).toISOString() };
  }
  async function resume() {
    clearTimeout(resumeTimer); resumeTimer = null;
    pausedUntil = null;
    saveState();
    await setDalyEnabled(true);
    emitMode(); status();
    app.debug('resumed');
    return { paused: false };
  }
  function scheduleResume() {
    clearTimeout(resumeTimer);
    if (!pausedUntil) return;
    resumeTimer = setTimeout(() => resume().catch((e) => app.setPluginError(`resume failed: ${e.message}`)),
      Math.max(1000, pausedUntil - Date.now()));
  }

  // ------------------------------------------------------------- alarms
  function notify(key, state, message) {
    if (alarmState[key] === state) return;
    alarmState[key] = state;
    emit([{
      path: `notifications.electrical.batteries.${key}`,
      value: state === 'normal'
        ? { state: 'normal', method: [], message }
        : { state, method: state === 'alarm' ? ['visual', 'sound'] : ['visual'], message }
    }]);
  }
  function watch(pathStr, fn) {
    const un = app.streambundle.getSelfStream(pathStr).onValue(fn);
    unsubs.push(un);
  }
  function setupAlarms() {
    const a = opts.alarms || {};
    if (a.enabled === false) return;
    const labels = labelMap();
    for (const b of batteries()) {
      const id = b.batteryId, name = labels[id] || id, base = `electrical.batteries.${id}`;
      const seen = () => { lastSeen[id] = Date.now(); };

      watch(`${base}.voltage`, seen);
      watch(`${base}.cells.deltaVoltage`, (v) => {
        seen();
        if (typeof v !== 'number') return;
        const lim = a.cellDeltaV || 0.1;
        notify(`${id}.cellDelta`, v >= lim ? 'alarm' : v >= lim * 0.7 ? 'warn' : 'normal',
          `${name}: Zell-Delta ${(v * 1000).toFixed(0)} mV`);
      });
      watch(`${base}.bms.maximumTemperature`, (v) => {
        if (typeof v !== 'number') return;
        const c = v - K0, lim = a.tempC || 45;
        notify(`${id}.temperature`, c >= lim ? 'alarm' : c >= lim - 5 ? 'warn' : 'normal',
          `${name}: Temperatur ${c.toFixed(1)} °C`);
      });
      watch(`${base}.capacity.stateOfCharge`, (v) => {
        if (typeof v !== 'number') return;
        const lim = a.socLow || 0.2;
        notify(`${id}.soc`, v <= lim ? 'alarm' : v <= lim + 0.1 ? 'warn' : 'normal',
          `${name}: SOC ${(v * 100).toFixed(0)} %`);
      });
      watch(`${base}.bms.errors`, (v) => {
        const errs = Array.isArray(v) ? v : [];
        notify(`${id}.bms`, errs.length ? 'alarm' : 'normal',
          errs.length ? `${name}: BMS-Fehler ${errs.join(', ')}` : `${name}: BMS ok`);
      });
      watch(`${base}.bms.chargeMosfet`, (v) => {
        if (typeof v !== 'boolean') return;
        notify(`${id}.chargeMosfet`, v ? 'normal' : 'warn', `${name}: Lade-MOSFET ${v ? 'ein' : 'AUS'}`);
      });
      watch(`${base}.bms.dischargeMosfet`, (v) => {
        if (typeof v !== 'boolean') return;
        notify(`${id}.dischargeMosfet`, v ? 'normal' : 'alarm', `${name}: Entlade-MOSFET ${v ? 'ein' : 'AUS'}`);
      });
    }
  }
  // Self-healing: a dropped BLE link can leave BlueZ with a pending connect
  // ("In Progress" / "br-connection-canceled") that the Daly plugin never clears
  // and that also blocks the phone app. Step 1: disconnect the device in BlueZ.
  // Step 2 (still no data): restart the Daly plugin.
  const heal = {};        // batteryId -> { step, at }
  let healBusy = false;
  async function selfHeal(id, device, staleFor) {
    if (healBusy || cmdBusy) return;
    const h = (heal[id] = heal[id] || { step: 0, at: 0 });
    if (Date.now() - h.at < 90000) return;         // one action per 90 s
    healBusy = true;
    try {
      if (h.step === 0) {
        app.debug(`heal ${id}: bluetoothctl disconnect ${device} (stale ${Math.round(staleFor / 1000)} s)`);
        await btDisconnect(device);
        h.step = 1;
      } else {
        app.debug(`heal ${id}: restarting Daly plugin`);
        await setDalyEnabled(false);
        await new Promise((r) => setTimeout(r, 3000));
        for (const b of batteries()) await btDisconnect(b.device);
        await setDalyEnabled(true);
        h.step = 0;
      }
      h.at = Date.now();
      app.setPluginStatus(`Selbstheilung ${id}: ${h.step === 1 ? 'BLE getrennt' : 'Daly-Plugin neu gestartet'}`);
    } catch (e) { app.debug(`heal failed: ${e.message}`); }
    finally { healBusy = false; }
  }
  function checkStale() {
    const a = opts.alarms || {};
    if (a.enabled === false || pausedUntil) return; // paused → silence is expected
    const dalyCfg = readDalyCfg();
    if (dalyCfg && dalyCfg.enabled === false) return; // reader off on purpose
    const labels = labelMap(), lim = (a.staleSec || 120) * 1000;
    for (const b of batteries()) {
      const id = b.batteryId, t = lastSeen[id];
      const staleFor = t ? Date.now() - t : Infinity;
      const stale = staleFor > lim;
      notify(`${id}.data`, stale ? 'warn' : 'normal',
        stale ? `${labels[id] || id}: keine BMS-Daten (Bluetooth?)` : `${labels[id] || id}: Daten ok`);
      if (stale && t && !cmdBusy) selfHeal(id, b.device, staleFor);
      if (!stale && heal[id]) heal[id].step = 0;
    }
  }

  // ------------------------------------------------------------- solar history
  const dayKey = (d = new Date()) => {
    const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  };
  function trimHist(h) {
    const keep = Object.keys(h).sort().slice(-14);
    for (const k of Object.keys(h)) if (!keep.includes(k)) delete h[k];
  }
  function setupSolar() {
    // any electrical.solar.<id>.yieldToday / panelPower — discovered via full self bus
    const un = app.streambundle.getSelfBus().onValue((n) => {
      const m = /^electrical\.solar\.([^.]+)\.(yieldToday|panelPower)$/.exec(n.path);
      if (!m || typeof n.value !== 'number') return;
      const id = m[1], key = dayKey();
      const h = (solarHist[id] = solarHist[id] || {});
      const d = (h[key] = h[key] || { wh: 0, peakW: 0 });
      if (m[2] === 'yieldToday') {
        const wh = n.value / 3600; // Signal K: joules
        if (wh > d.wh) { d.wh = Math.round(wh); histDirty = true; }
      } else if (n.value > d.peakW) { d.peakW = Math.round(n.value); histDirty = true; }
      if (Object.keys(h).length > 14) trimHist(h);
    });
    unsubs.push(un);
  }
  function solarSummary() {
    const out = {};
    for (const id of Object.keys(solarHist)) {
      const days = Object.keys(solarHist[id]).sort().slice(-4); // today + 3 previous
      out[id] = days.map((k) => ({ date: k, ...solarHist[id][k] }));
    }
    return out;
  }

  // ------------------------------------------------------------- BMS commands (write)
  let cmdBusy = false;
  async function dalyCommand(batteryId, args) {
    const b = batteries().find((x) => x.batteryId === batteryId);
    if (!b) throw new Error(`unknown battery ${batteryId}`);
    if (cmdBusy) throw new Error('another command is running');
    cmdBusy = true;
    const wasRunning = !pausedUntil && (readDalyCfg() || {}).enabled !== false;
    try {
      if (wasRunning) {           // free the BLE link: BMS accepts one connection only
        await setDalyEnabled(false);
        await new Promise((r) => setTimeout(r, 3000));
        await btDisconnect(b.device);
        await new Promise((r) => setTimeout(r, 1500));
      }
      let out;
      try {
        const r = await execFileP('python3', [path.join(__dirname, 'bin', 'daly-cmd.py'), b.device, ...args], { timeout: 45000 });
        out = r.stdout;
      } catch (e) {
        out = e.stdout || '';
        if (!out) throw new Error((e.stderr || e.message || '').trim().split('\n').pop());
      }
      const res = JSON.parse(out.trim().split('\n').pop());
      app.debug(`daly cmd ${batteryId} ${args.join(' ')} -> ${JSON.stringify(res)}`);
      if (!res.ok) throw new Error('BMS did not acknowledge');
      return res;
    } finally {
      cmdBusy = false;
      if (wasRunning) setDalyEnabled(true).catch((e) => app.setPluginError(`resume failed: ${e.message}`));
    }
  }

  // ------------------------------------------------------------- HTTP
  plugin.registerWithRouter = function (router) {
    const page = (title, body) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:17px system-ui;margin:0;padding:24px;background:#111;color:#eee;text-align:center}
a,button{display:inline-block;margin:10px 6px;padding:14px 22px;border-radius:10px;border:0;font:inherit;text-decoration:none;color:#fff}
.p{background:#0a7}.s{background:#c33}.g{background:#444}h1{font-size:22px}</style><h1>${title}</h1>${body}`;
    const mins = () => Math.max(0, Math.round(((pausedUntil || Date.now()) - Date.now()) / 60000));
    const view = () => pausedUntil
      ? page('Daly-App-Modus aktiv', `<p>Bluetooth frei für die Daly-App – noch <b>${mins()} min</b>, dann übernimmt Signal K wieder.</p>
         <a class=s href="resume">Jetzt beenden</a> <a class=g href="pause?min=${opts.pauseMinutes || 30}">Weitere ${opts.pauseMinutes || 30} min</a>
         <p><a class=g href="/signalk-daly-companion/">Batterie-Ansicht</a></p>`)
      : page('Signal K liest die Daly-BMS', `<a class=p href="pause">Daly-App-Modus starten (${opts.pauseMinutes || 30} min)</a>
         <p><a class=g href="/signalk-daly-companion/">Batterie-Ansicht</a></p>`);
    const wantsJson = (req) => (req.get('accept') || '').includes('json') || req.query.format === 'json';

    router.get('/status', (req, res) => res.json({
      paused: !!pausedUntil, until: pausedUntil ? new Date(pausedUntil).toISOString() : null,
      minutesLeft: pausedUntil ? mins() : 0, pauseMinutes: opts.pauseMinutes || 30,
      batteries: batteries().map((b) => ({ id: b.batteryId, label: labelMap()[b.batteryId] || b.batteryId, device: b.device })),
      solar: solarSummary(),
      busy: cmdBusy || healBusy
    }));
    router.get('/', (req, res) => res.send(view()));
    // POST /cmd/:battery  {action:'charge'|'discharge', on:true|false} | {action:'soc', value:0-100}
    router.post('/cmd/:battery', async (req, res) => {
      const { action, on, value } = req.body || {};
      let args;
      if (action === 'charge' || action === 'discharge') args = [action, on ? 'on' : 'off'];
      else if (action === 'start') args = ['start'];
      else if (action === 'soc') { const v = Number(value); if (!(v >= 0 && v <= 100)) return res.status(400).json({ error: 'soc 0-100' }); args = ['soc', String(v)]; }
      else return res.status(400).json({ error: 'unknown action' });
      try { res.json(await dalyCommand(req.params.battery, args)); }
      catch (e) { res.status(500).json({ error: e.message }); }
    });
    router.get('/pause', async (req, res) => {
      try { const r = await pause(req.query.min); wantsJson(req) ? res.json(r) : res.send(view()); }
      catch (e) { app.setPluginError(e.message); res.status(500).send(page('Fehler', `<p>${e.message}</p>`)); }
    });
    router.get('/resume', async (req, res) => {
      try { const r = await resume(); wantsJson(req) ? res.json(r) : res.send(view()); }
      catch (e) { app.setPluginError(e.message); res.status(500).send(page('Fehler', `<p>${e.message}</p>`)); }
    });
  };

  // ------------------------------------------------------------- lifecycle
  plugin.start = function (options) {
    opts = Object.assign({ dalyPluginId: 'signalk-daly-bms-ble', pauseMinutes: 30 }, options || {});
    opts.alarms = Object.assign({ enabled: true, cellDeltaV: 0.1, tempC: 45, socLow: 0.2, staleSec: 120 }, opts.alarms || {});

    app.setDefaultMetadata && [
      [MODE_PATH, { description: 'Daly-App-Modus: true = Daly-Plugin pausiert, Bluetooth frei', displayName: 'Daly-App-Modus' }],
      [UNTIL_PATH, { description: 'Ende des Daly-App-Modus (ISO)', displayName: 'Daly-App-Modus bis' }]
    ].forEach(([p, m]) => app.setDefaultMetadata(p, m));

    // KIP / any client: PUT true|false on the mode path
    app.registerPutHandler('vessels.self', MODE_PATH, (context, p, value, cb) => {
      (value ? pause() : resume())
        .then(() => cb({ state: 'COMPLETED', statusCode: 200 }))
        .catch((e) => cb({ state: 'COMPLETED', statusCode: 500, message: e.message }));
      return { state: 'PENDING' };
    });

    // restore a pause that was running when the server restarted
    const st = loadState();
    solarHist = (st.solarHist && typeof st.solarHist === 'object') ? st.solarHist : {};
    const dalyCfg = readDalyCfg();
    if (st.pausedUntil && st.pausedUntil > Date.now()) {
      pausedUntil = st.pausedUntil;
      scheduleResume();
    } else if (st.pausedUntil && dalyCfg && dalyCfg.enabled === false) {
      // expired while server was down → bring the Daly plugin back
      setTimeout(() => resume().catch((e) => app.setPluginError(e.message)), 5000);
    }

    setupAlarms();
    setupSolar();
    tickTimer = setInterval(() => { emitMode(); status(); checkStale(); if (histDirty) { saveState(); histDirty = false; } }, 15000);
    emitMode(); status();
  };

  plugin.stop = function () {
    if (histDirty) saveState();
    clearTimeout(resumeTimer); clearInterval(tickTimer);
    unsubs.splice(0).forEach((u) => { try { u(); } catch (e) { /* ignore */ } });
    Object.keys(alarmState).forEach((k) => delete alarmState[k]);
    app.setPluginStatus('Stopped');
  };

  return plugin;
};
