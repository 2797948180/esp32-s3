/* 设备运行时管理器
 * 职责：为每台设备创建传输实例、心跳监控、离线判定、自动重连、状态历史、操作日志。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  var HISTORY_LIMIT = 180;   // 约 3 分钟（按 1s 采样）

  var runtime = Object.create(null);   // deviceId -> RuntimeNode
  var tickTimer = null;

  function RuntimeNode(record) {
    this.record = record;
    this.transport = null;
    this.online = false;
    this.source = '-';
    this.lastSeen = 0;
    this.state = null;
    this.schema = null;
    this.simulated = false;
    this.lastError = null;
    this.history = [];          // [{ts, heap_free, rssi, pins}]
    this.stateHistory = [];     // [{ts, label, detail}]
    this.started = false;
  }

  function createTransport(record) {
    var node = runtime[record.id];
    var cb = {
      onState: function (state, schema) {
        node.state = state;
        node.schema = schema;
        node.simulated = !!(state && state.simulated) || record.transport === 'sim';
        node.lastSeen = Date.now();
        pushHistory(node, state);
        ESP.bus.emit('device:state', { deviceId: record.id, state: state });
      },
      onStatus: function (online, source) {
        node.online = !!online;
        node.source = source || '-';
        if (online) node.lastSeen = Date.now();
        ESP.bus.emit('device:status', { deviceId: record.id, online: node.online, source: node.source });
        pushEvent(node, 'status', node.online ? '已上线（' + node.source + '）' : '已离线');
        ESP.bus.emit('log', {
          level: online ? 'ok' : 'warn', action: '连接',
          message: (online ? '设备上线：' : '设备离线：') + record.name + '（' + node.source + '）',
          deviceId: record.id, deviceName: record.name, simulated: node.simulated
        });
      },
      onError: function (e) {
        node.lastError = { ts: Date.now(), message: e.message };
      }
    };

    if (record.transport === 'sim') {
      node.transport = new ESP.SimTransport(record, cb);
    } else if (record.transport === 'mqtt') {
      node.transport = new ESP.MqttTransport(record, cb);
    } else {
      node.transport = new ESP.LanTransport(record, cb);
    }
    return node.transport;
  }

  function pushHistory(node, state) {
    if (!state) return;
    var d = state.device || {};
    var last = node.history[node.history.length - 1];
    // 采样节流：同一秒内只保留一条
    if (last && Date.now() - last.ts < 1000) return;
    node.history.push({
      ts: Date.now(),
      heap_free: d.heap_free,
      rssi: d.rssi,
      online: true
    });
    if (node.history.length > HISTORY_LIMIT) node.history.shift();
  }

  function pushEvent(node, label, detail) {
    node.stateHistory.unshift({ ts: Date.now(), label: label, detail: detail });
    if (node.stateHistory.length > 200) node.stateHistory.pop();
  }

  var Manager = {
    all: function () { return ESP.store.devices(); },

    nodes: function () { return runtime; },

    get: function (id) {
      if (!runtime[id]) {
        var rec = ESP.store.deviceById(id);
        if (!rec) return null;
        runtime[id] = new RuntimeNode(rec);
      }
      return runtime[id];
    },

    ensure: function (id) { return Manager.get(id); },

    start: function (id) {
      var node = Manager.get(id);
      if (!node) return;
      if (node.started && node.transport) return;
      node.record = ESP.store.deviceById(id) || node.record;
      if (!node.transport) createTransport(node.record);
      node.started = true;
      try { node.transport.start(); } catch (e) { node.lastError = { ts: Date.now(), message: e.message }; }
    },

    stop: function (id) {
      var node = runtime[id];
      if (!node || !node.transport) return;
      node.started = false;
      try { node.transport.stop(); } catch (e) { }
      node.transport = null;
      node.online = false;
    },

    restart: function (id) {
      Manager.stop(id);
      var node = runtime[id];
      if (node) { node.transport = null; node.state = null; node.history = []; }
      Manager.start(id);
    },

    /* 传输方式或地址改变后必须重建连接 */
    reload: function (id) {
      var node = runtime[id];
      if (node) {
        Manager.stop(id);
        node.transport = null;
        node.state = null;
        node.history = [];
        node.record = ESP.store.deviceById(id) || node.record;
        createTransport(node.record);
        Manager.start(id);
      } else Manager.start(id);
    },

    startAll: function () {
      ESP.store.devices().forEach(function (d) { Manager.start(d.id); });
      if (!tickTimer) tickTimer = setInterval(tick, 1000);
    },

    stopAll: function () {
      ESP.store.devices().forEach(function (d) { Manager.stop(d.id); });
    },

    remove: function (id) {
      Manager.stop(id);
      delete runtime[id];
      ESP.store.removeDevice(id);
    },

    activeId: function () {
      var a = ESP.store.activeDevice();
      return a ? a.id : null;
    },

    activeNode: function () {
      var id = Manager.activeId();
      return id ? Manager.get(id) : null;
    },

    /* 供页面调用的统一命令入口：自动写日志、自动刷新状态 */
    invoke: function (id, op, args, opts) {
      opts = opts || {};
      var node = Manager.get(id);
      if (!node) return Promise.reject(new Error('设备不存在'));
      if (!node.transport) { createTransport(node.record); node.started = true; try { node.transport.start(); } catch (e) { } }
      var started = Date.now();
      var isSim = node.record.transport === 'sim';
      return node.transport.invoke(op, args, opts).then(function (r) {
        ESP.bus.emit('log', {
          level: isSim ? 'info' : 'ok',
          action: op,
          message: describe(op, args) + ' → 成功（' + (Date.now() - started) + 'ms）' + (isSim ? ' [模拟]' : ''),
          deviceId: id, deviceName: node.record.name, simulated: isSim
        });
        if (isSim) ESP.bus.emit('sim:used', node.record.id);
        return r;
      }).catch(function (e) {
        node.lastError = { ts: Date.now(), message: e.message };
        ESP.bus.emit('log', {
          level: 'error', action: op,
          message: describe(op, args) + ' → 失败：' + e.message,
          deviceId: id, deviceName: node.record.name, simulated: isSim
        });
        return Promise.reject(e);
      });
    },

    onlineCount: function () {
      var n = 0;
      ESP.store.devices().forEach(function (d) { var node = runtime[d.id]; if (node && node.online) n++; });
      return n;
    },

    simCount: function () {
      return ESP.store.devices().filter(function (d) { return d.transport === 'sim'; }).length;
    }
  };

  function describe(op, args) {
    args = args || {};
    switch (op) {
      case 'gpio.set_mode': return 'GPIO' + args.gpio + ' 设为 ' + (args.mode || '');
      case 'gpio.write': return 'GPIO' + args.gpio + ' 输出 ' + (args.value ? '高电平' : '低电平');
      case 'gpio.set_pwm': return 'GPIO' + args.gpio + ' PWM ' + (args.duty_percent + '% @ ' + (args.frequency || '') + 'Hz / ' + (args.resolution_bits || '') + 'bit');
      case 'gpio.batch': return '批量操作 ' + ((args.commands || []).length) + ' 条';
      case 'device.rename': return '重命名设备为 ' + args.name;
      case 'device.reboot': return '重启设备';
      case 'config.wifi': return '配置 Wi-Fi：' + args.ssid;
      case 'state': return '读取完整状态';
      case 'info': return '读取设备信息';
      default: return op + ' ' + JSON.stringify(args);
    }
  }

  /* 每秒巡检：离线判定 + 自动重连 */
  function tick() {
    var timeout = ESP.store.settings().offlineTimeoutMs;
    var now = Date.now();
    ESP.store.devices().forEach(function (d) {
      var node = runtime[d.id];
      if (!node || !node.started) return;
      // 离线判定：超过阈值没有收到任何来自设备的消息
      if (node.online && node.lastSeen && now - node.lastSeen > timeout) {
        node.online = false;
        node.source = 'timeout';
        ESP.bus.emit('device:status', { deviceId: d.id, online: false, source: 'timeout' });
        pushEvent(node, 'status', '心跳超时，判定离线');
        ESP.bus.emit('log', { level: 'warn', action: '心跳', message: '超过 ' + Math.round((now - node.lastSeen) / 1000) + 's 未收到数据，' + d.name + ' 判定离线', deviceId: d.id, deviceName: d.name });
      }
      // MQTT 传输会在内部自动重连；局域网传输由 WS + HTTP 轮询自带重连
      if (!node.transport) { node.transport = null; try { Manager.start(d.id); } catch (e) { } }
    });
  }

  /* 设备变更后同步 runtime */
  ESP.bus.on('devices:changed', function () {
    ESP.store.devices().forEach(function (d) {
      if (!runtime[d.id]) runtime[d.id] = new RuntimeNode(d);
      else runtime[d.id].record = d;
    });
    Object.keys(runtime).forEach(function (id) {
      if (!ESP.store.deviceById(id)) { try { Manager.stop(id); } catch (e) { } delete runtime[id]; }
    });
  });

  Manager.describe = describe;
  Manager.pushEvent = pushEvent;
  ESP.devices = Manager;
})(window);
