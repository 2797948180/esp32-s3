/* 本地持久化：设备清单、全局设置、操作日志
 * 数据保存在浏览器 localStorage，属于本机配置，未上传任何服务器。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  var KEY = 'esp32s3.platform.v1';
  var LOG_LIMIT = 500;

  var defaults = {
    version: 1,
    settings: {
      pollMs: 1500,
      monitorRefreshMs: 1000,   // 监控页刷新间隔：100/500/1000/2000/3000/5000 ms
      theme: 'default',         // 主题：default / glass / light / dark
      metricThresholds: {},     // 自适应阈值：{ deviceId: { metricKey: 值 } }
      offlineTimeoutMs: 6000,
      wsReconnectMs: 3000,
      httpTimeoutMs: 2500,
      showRiskPins: false,
      defaultBoard: 'esp32-s3-devkitc-1-n16r8',
      autoOpenDevicePage: true,
      simulate: false,
      mqtt: {
        enabled: false,
        host: '',            // EMQX Serverless 示例：xxxxx.eu-central-1.emqxsl.com
        port: 8084,          // MQTT over WebSocket Secure 端口
        path: '/mqtt',
        secure: true,
        username: '',
        password: '',
        clientPrefix: 'esp32s3-web',
        keepalive: 60,
        autoReconnect: true
      },
      cloud: {
        enabled: false,
        apiBase: '',         // Cloudflare Workers 地址，如 https://xxx.workers.dev
        tokenPath: '/api/mqtt-credential'
      }
    },
    devices: [],
    activeDeviceId: null,
    logs: []
  };

  function mergeDefaults(saved) {
    var out = U.deepClone(defaults);
    if (!saved || typeof saved !== 'object') return out;
    out.settings = Object.assign(out.settings, saved.settings || {});
    out.settings.mqtt = Object.assign(defaults.settings.mqtt, (saved.settings && saved.settings.mqtt) || {});
    out.settings.cloud = Object.assign(defaults.settings.cloud, (saved.settings && saved.settings.cloud) || {});
    out.devices = Array.isArray(saved.devices) ? saved.devices : [];
    out.activeDeviceId = saved.activeDeviceId || null;
    out.logs = Array.isArray(saved.logs) ? saved.logs.slice(-LOG_LIMIT) : [];
    return out;
  }

  var state = defaults;

  function load() {
    try {
      state = mergeDefaults(JSON.parse(localStorage.getItem(KEY)));
    } catch (e) {
      console.warn('[store] 读取本地数据失败，使用默认配置', e);
      state = U.deepClone(defaults);
    }
    return state;
  }

  var saveTimer = null;
  function save(immediate) {
    if (saveTimer) clearTimeout(saveTimer);
    var doSave = function () {
      saveTimer = null;
      try { localStorage.setItem(KEY, JSON.stringify(state)); }
      catch (e) { console.error('[store] 保存失败（可能超出配额）', e); }
    };
    if (immediate) doSave(); else saveTimer = setTimeout(doSave, 200);
  }

  function get() { return state; }
  function settings() { return state.settings; }

  function updateSettings(patch) {
    Object.assign(state.settings, patch || {});
    save();
    ESP.bus.emit('settings:changed', state.settings);
    return state.settings;
  }

  /* ------------------------------- 设备 ------------------------------- */
  function devices() { return state.devices; }

  function deviceById(id) {
    for (var i = 0; i < state.devices.length; i++) if (state.devices[i].id === id) return state.devices[i];
    return null;
  }

  function deviceByKey(key) {
    // key = transport|host|port，用于去重
    for (var i = 0; i < state.devices.length; i++) {
      var d = state.devices[i];
      if (deviceKey(d) === key) return d;
    }
    return null;
  }

  function deviceKey(d) { return d.transport + '|' + d.host + '|' + (d.port || ''); }

  function addDevice(input) {
    var d = {
      id: input.id || U.uuid(),
      name: input.name || ('ESP32-S3 ' + (input.host || '')),
      transport: input.transport || 'lan',
      board: input.board || state.settings.defaultBoard,
      host: input.host || '',
      port: input.port || (input.transport === 'mqtt' ? 8084 : 80),
      secure: !!input.secure,
      token: input.token || '',
      remoteId: input.remoteId || '',          // MQTT topic 中的 device_id
      meta: input.meta || {},                  // chip / mac / firmware / deviceId
      mqtt: input.mqtt || null,
      notes: input.notes || '',
      createdAt: Date.now()
    };
    var exist = deviceByKey(deviceKey(d));
    if (exist) { Object.assign(exist, d, { id: exist.id, createdAt: exist.createdAt }); save(true); ESP.bus.emit('devices:changed'); return exist; }
    state.devices.push(d);
    if (!state.activeDeviceId) state.activeDeviceId = d.id;
    save(true);
    ESP.bus.emit('devices:changed');
    return d;
  }

  function updateDevice(id, patch) {
    var d = deviceById(id);
    if (!d) return null;
    Object.assign(d, patch || {});
    save(true);
    ESP.bus.emit('devices:changed');
    ESP.bus.emit('device:updated', d);
    return d;
  }

  function removeDevice(id) {
    var idx = -1;
    for (var i = 0; i < state.devices.length; i++) if (state.devices[i].id === id) idx = i;
    if (idx < 0) return false;
    state.devices.splice(idx, 1);
    if (state.activeDeviceId === id) state.activeDeviceId = state.devices.length ? state.devices[0].id : null;
    save(true);
    ESP.bus.emit('devices:changed');
    return true;
  }

  function setActive(id) {
    state.activeDeviceId = id;
    save();
    ESP.bus.emit('active:changed', id);
  }

  function activeDevice() {
    var d = deviceById(state.activeDeviceId);
    if (d) return d;
    return state.devices.length ? state.devices[0] : null;
  }

  /* -------------------------------- 日志 -------------------------------- */
  /* entry: {level:'info'|'ok'|'warn'|'error', action, message, deviceId, deviceName} */
  function pushLog(entry) {
    var row = {
      id: U.uuid(),
      ts: Date.now(),
      level: entry.level || 'info',
      action: entry.action || '',
      message: entry.message || '',
      deviceId: entry.deviceId || '',
      deviceName: entry.deviceName || '',
      simulated: !!entry.simulated
    };
    state.logs.unshift(row);
    if (state.logs.length > LOG_LIMIT) state.logs.length = LOG_LIMIT;
    ESP.bus.emit('log:added', row);
    save();
    return row;
  }

  function logs(filter) {
    var l = state.logs;
    if (filter && filter.deviceId) l = l.filter(function (x) { return x.deviceId === filter.deviceId; });
    if (filter && filter.limit) l = l.slice(0, filter.limit);
    return l;
  }

  function clearLogs() {
    state.logs = [];
    save(true);
    ESP.bus.emit('log:cleared');
  }

  function exportAll() { return JSON.stringify({ app: 'ESP32-S3 Platform', exportedAt: new Date().toISOString(), data: state }, null, 2); }

  function importAll(jsonText) {
    var parsed = JSON.parse(jsonText);
    if (!parsed || !parsed.data) throw new Error('文件格式不正确：缺少 data 字段');
    state = mergeDefaults(parsed.data);
    save(true);
    ESP.bus.emit('devices:changed');
    ESP.bus.emit('settings:changed', state.settings);
    return state;
  }

  load();

  ESP.store = {
    KEY: KEY,
    get: get, settings: settings, updateSettings: updateSettings,
    devices: devices, deviceById: deviceById, deviceByKey: deviceByKey, deviceKey: deviceKey,
    addDevice: addDevice, updateDevice: updateDevice, removeDevice: removeDevice,
    setActive: setActive, activeDevice: activeDevice,
    pushLog: pushLog, logs: logs, clearLogs: clearLogs,
    exportAll: exportAll, importAll: importAll,
    save: save
  };
})(window);
