/* 设备运行时管理器
 * 职责：为每台设备创建传输实例、心跳监控、离线判定、自动重连、状态历史、操作日志。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  var HISTORY_LIMIT = 180;   // 约 3 分钟（按 1s 采样）

  function numOf(v) {
    if (v == null || v === 'null' || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* 自适应监控指标表：网页扫描 state，某个指标有数据才缓存/画曲线。
     get() 返回 null 表示该指标当前无数据（对应传感器/字段不存在）。
     新增传感器时只需在这里加一行，监控页与曲线页会自动适配。 */
  var METRICS = [
    // ---- 环境监测（state.env）----
    { key: 'temperature', label: '温度', unit: '℃', color: '#ff6b7a', get: function (s) { return numOf(s.env && s.env.temperature); } },
    { key: 'humidity', label: '湿度', unit: '%RH', color: '#7ee0b0', get: function (s) { return numOf(s.env && s.env.humidity); } },
    { key: 'lux_bh1750', label: '光照 BH1750', unit: 'lx', color: '#ffd479', get: function (s) { return numOf(s.env && s.env.lux_bh1750); } },
    { key: 'lux_ldr', label: '光照 LDR', unit: 'lx', color: '#c9a0ff', get: function (s) { return numOf(s.env && s.env.lux_ldr); } },
    { key: 'fan_level', label: '风扇档位', unit: '档', color: '#53d6c6', get: function (s) { return numOf(s.env && s.env.fan_level); } },
    { key: 'pir', label: '人体感应', unit: '', color: '#7aa5ff', get: function (s) { if (!s.env || s.env.pir == null) return null; return s.env.pir ? 1 : 0; } },
    // ---- 电子指南针（state.compass，将来接入自动生效）----
    { key: 'heading', label: '航向', unit: '°', color: '#7aa5ff', get: function (s) { return numOf(s.compass && s.compass.heading); } },
    { key: 'pitch', label: '俯仰', unit: '°', color: '#7ee0b0', get: function (s) { return numOf(s.compass && s.compass.pitch); } },
    { key: 'roll', label: '横滚', unit: '°', color: '#ffd479', get: function (s) { return numOf(s.compass && s.compass.roll); } },
    { key: 'mag_x', label: '磁场 X', unit: 'µT', color: '#ff6b7a', get: function (s) { var m = s.compass && s.compass.mag; return numOf(m && m[0]); } },
    { key: 'mag_y', label: '磁场 Y', unit: 'µT', color: '#7ee0b0', get: function (s) { var m = s.compass && s.compass.mag; return numOf(m && m[1]); } },
    { key: 'mag_z', label: '磁场 Z', unit: 'µT', color: '#7aa5ff', get: function (s) { var m = s.compass && s.compass.mag; return numOf(m && m[2]); } },
    { key: 'accel_x', label: '加速度 X', unit: 'g', color: '#ff6b7a', get: function (s) { var a = s.compass && s.compass.accel; return numOf(a && a[0]); } },
    { key: 'accel_y', label: '加速度 Y', unit: 'g', color: '#7ee0b0', get: function (s) { var a = s.compass && s.compass.accel; return numOf(a && a[1]); } },
    { key: 'accel_z', label: '加速度 Z', unit: 'g', color: '#7aa5ff', get: function (s) { var a = s.compass && s.compass.accel; return numOf(a && a[2]); } }
  ];
  ESP.devMetrics = METRICS;   // 供监控页扫描并绘制曲线

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
      onSeen: function (ts) {
        node.lastSeen = ts || Date.now();
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
    var point = {
      ts: Date.now(),
      heap_free: d.heap_free,
      rssi: d.rssi,
      online: true
    };
    // 自适应：把当前所有有数值的监控指标一并缓存
    METRICS.forEach(function (m) {
      var v = m.get(state);
      if (v != null) point[m.key] = v;
    });
    node.history.push(point);
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
      case 'env.thresholds': return '环境阈值 低温' + args.lo + ' / 高温' + args.hi + ' / 报警' + args.alarm;
      case 'env.fan.level': return '风扇档位设为 ' + args.level;
      case 'env.fan.auto': return '风扇自动模式 ' + (args.enabled ? '开启' : '关闭');
      case 'env.speak': return '语音播报';
      case 'compass.set_offset': return '航向补偿设为 ' + (args.degrees != null ? args.degrees : args.offset) + '°';
      case 'compass.set_mag_north_offset': return '磁北校正设为 ' + (args.degrees != null ? args.degrees : args.offset) + '°';
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
      // MQTT 走公网 + 心跳 5s，抖动/后台节流更明显，给足 60s 余量，避免误判离线。
      var deviceTimeout = d.transport === 'mqtt' ? Math.max(timeout, 60000) : timeout;
      if (node.online && node.lastSeen && now - node.lastSeen > deviceTimeout) {
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
