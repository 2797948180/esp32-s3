/* 局域网传输：HTTP/REST + WebSocket 实时推送
 *
 * 优先走 WebSocket（低延迟、服务端主动推送状态）；
 * WebSocket 不可用（如旧固件、断线）时自动降级为 HTTP 轮询。
 *
 * 固件接口约定（见 firmware/ 与 docs/LOCAL-CONTROL.md）：
 *   GET  /api/v1/info       设备信息
 *   GET  /api/v1/state      完整状态快照
 *   POST /api/v1/command    {"op":"gpio.write","args":{...},"id":"..."}
 *   WS   /ws                {"type":"state"|"ack"|"hello"|"event"}
 *   兼容旧固件： GET /api/status、 POST /api/pin
 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  var cmdSeq = 0;

  function LanTransport(device, cb) {
    this.device = device;
    this.cb = cb || {};
    this.ws = null;
    this.wsReady = false;
    this.pending = Object.create(null);
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.retryDelay = 1000;
    this.stopped = true;
    this.online = false;
    this.lastError = null;
    this.schema = null;          // 1 = 新固件, 'legacy' = 旧固件
    this.lastState = null;
    this.lastChangeSeq = 0;
  }

  LanTransport.prototype.base = function () { return U.baseUrl(this.device); };

  LanTransport.prototype.http = function (path, options) {
    var self = this;
    options = options || {};
    var timeout = options.timeout || (ESP.store ? ESP.store.settings().httpTimeoutMs : 2500);
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var init = {
      method: options.method || 'GET',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit'
    };
    if (ctrl) init.signal = ctrl.signal;
    var headers = { 'Accept': 'application/json' };
    if (options.body != null) {
      init.body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
    if (this.device.token) headers['X-Device-Token'] = this.device.token;
    init.headers = Object.assign(headers, options.headers || {});

    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('HTTP 请求超时：' + path));
      }, timeout);
      fetch(self.base() + path, init).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) {
          // 401/403 时提示需要访问令牌
          var err = new Error('设备返回 HTTP ' + r.status + ' ' + r.statusText);
          err.status = r.status;
          return r.text().then(function (t) { err.bodyText = t.slice(0, 300); reject(err); }, function () { reject(err); });
        }
        return r.json().then(resolve, function () { reject(new Error('响应不是合法 JSON：' + path)); });
      }).catch(function (e) {
        clearTimeout(timer);
        var msg = String(e && e.message || e);
        if (msg.indexOf('Failed to fetch') >= 0 || e instanceof TypeError) {
          msg = '无法访问 ' + self.base() + '（可能是 IP/端口错误、设备离线、或未允许跨域 CORS）';
        }
        var err = new Error(msg);
        err.cause = e;
        reject(err);
      });
    });
  };

  /* ------------------------------ 生命周期 ------------------------------ */
  LanTransport.prototype.start = function () {
    this.stopped = false;
    this.openWebSocket();
    this.schedulePoll(0);
  };

  LanTransport.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.pollTimer); this.pollTimer = null;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.onerror = null; this.ws.onmessage = null; this.ws.onopen = null; this.ws.close(); } catch (e) { }
      this.ws = null;
    }
    this.wsReady = false;
    this.flushPending(new Error('连接已关闭'));
  };

  LanTransport.prototype.flushPending = function (err) {
    Object.keys(this.pending).forEach(function (k) {
      var p = this.pending[k]; if (!p) return;
      clearTimeout(p.timer);
      p.reject(err);
      delete this.pending[k];
    }, this);
  };

  /* ------------------------------ WebSocket ----------------------------- */
  LanTransport.prototype.wsUrl = function () {
    // 固件约定：HTTP 在 80 端口，WebSocket 在 81 端口
    var port = this.device.port === 80 ? 81 : this.device.port;
    return (this.device.secure ? 'wss' : 'ws') + '://' + U.normalizeHost(this.device.host) + ':' + (port || 81) + '/ws';
  };

  LanTransport.prototype.openWebSocket = function () {
    var self = this;
    if (this.stopped) return;
    if (typeof WebSocket === 'undefined') return;                 // 环境不支持则纯 HTTP 模式
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    var url = this.wsUrl();
    try { this.ws = new WebSocket(url); } catch (e) { this.scheduleWsReconnect(); return; }

    this.ws.onopen = function () {
      self.wsReady = true;
      self.retryDelay = 1000;
      ESP.bus.emit('log', { level: 'ok', action: 'WS', message: '已建立 WebSocket 实时连接', deviceId: self.device.id });
    };

    this.ws.onmessage = function (ev) { self.handleWsFrame(ev.data); };

    this.ws.onerror = function () {
      // 旧固件没有 /ws，会在 close 时走重连；这里不再打扰用户
    };

    this.ws.onclose = function () {
      self.wsReady = false;
      self.ws = null;
      if (!self.stopped) self.scheduleWsReconnect();
    };
  };

  LanTransport.prototype.scheduleWsReconnect = function () {
    var self = this;
    if (this.stopped || this.reconnectTimer) return;
    var delay = Math.min(this.retryDelay, 15000);
    this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = null;
      self.openWebSocket();
    }, delay);
  };

  LanTransport.prototype.handleWsFrame = function (data) {
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'hello') {
      this.schema = msg.schema >= 1 ? 1 : 'legacy';
      this.applyState(msg.state);
      this.setOnline(true, 'websocket');
    } else if (msg.type === 'state') {
      this.applyState(msg.state);
      this.setOnline(true, 'websocket');
    } else if (msg.type === 'ack') {
      var p = this.pending[msg.id];
      if (p) {
        clearTimeout(p.timer);
        delete this.pending[msg.id];
        this.setOnline(true, 'websocket');
        if (msg.ok === false) p.reject(new Error((msg.error && (msg.error.message || msg.error)) || '设备拒绝执行'));
        else p.resolve(msg.result || msg);
      }
      if (msg.state) this.applyState(msg.state);
    } else if (msg.type === 'event') {
      this.setOnline(true, 'websocket');
      ESP.bus.emit('device:event', { deviceId: this.device.id, event: msg.event, data: msg.data });
    }
  };

  LanTransport.prototype.applyState = function (state) {
    if (!state) return;
    this.lastState = state;
    this.lastChangeSeq = state.seq || 0;
    if (this.cb.onState) this.cb.onState(state, this.schema);
  };

  LanTransport.prototype.setOnline = function (online, source) {
    var changed = online !== this.online;
    this.online = online;
    this.lastSeen = online ? Date.now() : this.lastSeen;
    if (changed && this.cb.onStatus) this.cb.onStatus(online, source);
  };

  /* -------------------------------- 轮询 -------------------------------- */
  LanTransport.prototype.schedulePoll = function (delay) {
    var self = this;
    var period = ESP.store ? ESP.store.settings().pollMs : 1500;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(function () { self.pollOnce(); }, delay == null ? period : delay);
  };

  LanTransport.prototype.pollOnce = function () {
    var self = this;
    if (this.stopped) return;
    // WebSocket 可用时降低轮询频率，只作为心跳兜底
    if (this.wsReady) { this.schedulePoll(5000); return; }

    if (this.schema === 'legacy') {
      this.http('/api/status').then(function (s) {
        self.applyState(adaptLegacyState(s, self.device));
        self.setOnline(true, 'http-legacy');
        self.schedulePoll();
      }).catch(function (e) { self.pollFailed(e); });
      return;
    }

    this.http('/api/v1/state').then(function (s) {
      self.schema = 1;
      self.applyState(s);
      self.setOnline(true, 'http');
      self.schedulePoll();
    }).catch(function (e) {
      if (e.status === 404 || e.status === 400) {
        // 可能是本项目早期固件：退到旧接口
        return self.http('/api/status').then(function (s) {
          self.schema = 'legacy';
          self.applyState(adaptLegacyState(s, self.device));
          self.setOnline(true, 'http-legacy');
          ESP.bus.emit('log', { level: 'warn', action: '固件兼容', message: '检测到旧版固件（v0），已切换到 /api/status 兼容模式。建议升级到 v1 固件以获得全部功能。', deviceId: self.device.id });
          self.schedulePoll();
        }).catch(function (e2) { self.pollFailed(e2); });
      }
      self.pollFailed(e);
    });
  };

  LanTransport.prototype.pollFailed = function (e) {
    this.lastError = e;
    this.setOnline(false, 'poll-failed');
    if (this.cb.onError) this.cb.onError(e);
    this.schedulePoll();
  };

  /* ------------------------------ 下发命令 ------------------------------ */
  LanTransport.prototype.invoke = function (op, args, opts) {
    var self = this;
    opts = opts || {};
    var id = 'c' + (Date.now() % 100000) + '-' + (++cmdSeq);

    // WebSocket 优先
    if (this.wsReady && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete self.pending[id];
          reject(new Error('设备未在 ' + (opts.timeout || 4000) + 'ms 内应答：' + op));
        }, opts.timeout || 4000);
        self.pending[id] = { resolve: resolve, reject: reject, timer: timer };
        try {
          self.ws.send(JSON.stringify({ type: 'cmd', id: id, op: op, args: args || {} }));
        } catch (e) {
          clearTimeout(timer); delete self.pending[id];
          reject(e);
        }
      }).catch(function (err) {
        // WS 应答失败时最后再尝试一次 HTTP，避免误判命令丢失
        if (opts.noFallback) return Promise.reject(err);
        return self.invokeHttp(op, args, opts);
      });
    }
    return this.invokeHttp(op, args, opts);
  };

  LanTransport.prototype.invokeHttp = function (op, args, opts) {
    var self = this;
    if (this.schema === 'legacy') {
      var legacy = toLegacyCommand(op, args);
      if (!legacy) return Promise.reject(new Error('旧版固件不支持该操作：' + op + '（请升级固件）'));
      return this.http('/api/pin', { method: 'POST', body: legacy, timeout: opts.timeout }).then(function (r) {
        if (r && r.error) return Promise.reject(new Error(legacyErrorText(r.error)));
        return self.refresh(r);
      });
    }
    return this.http('/api/v1/command', {
      method: 'POST',
      body: { id: id2(), op: op, args: args || {} },
      timeout: opts.timeout
    }).then(function (r) {
      if (r && r.ok === false) {
        var e = new Error((r.error && (r.error.message || r.error.code)) || '设备拒绝执行');
        e.code = r.error && r.error.code;
        return Promise.reject(e);
      }
      if (r && r.state) self.applyState(r.state);
      self.setOnline(true, 'http');
      return r;
    });
  };

  LanTransport.prototype.refresh = function () {
    var self = this;
    return this.http('/api/v1/state').catch(function () {
      return self.http('/api/status').then(function (s) { return adaptLegacyState(s, self.device); });
    }).then(function (s) { self.applyState(s); self.setOnline(true, 'http'); return s; });
  };

  function id2() { return 'h' + (Date.now() % 100000) + '-' + (++cmdSeq); }

  function legacyErrorText(code) {
    var map = {
      invalid_json: '固件无法解析请求（JSON 格式错误）',
      pin_or_value_not_allowed: '该引脚或取值不在固件白名单内',
      mode_not_allowed: '旧固件不支持该模式',
      pwm_write_failed: 'PWM 写入失败'
    };
    return map[code] || ('设备返回错误：' + code);
  }

  /* -------------------- 旧固件（v0）数据与命令适配 -------------------- */
  function adaptLegacyState(s, device) {
    var pins = {};
    if (s && Array.isArray(s.pins)) {
      s.pins.forEach(function (p) {
        var mode = p.type === 'input' ? 'input' : p.type === 'pwm' ? 'pwm' : 'output';
        var entry = { gpio: p.pin, mode: mode, level: p.value ? 1 : 0, value: p.value, legacy: true };
        if (p.type === 'pwm') entry.pwm = { enabled: true, frequency: 1000, duty_percent: Math.round(p.value / 255 * 100), resolution_bits: 8, duty_raw: p.value };
        pins[p.pin] = entry;
      });
    }
    return {
      seq: 0,
      legacy: true,
      ts: Date.now(),
      device: {
        id: device.meta.deviceId || device.id,
        name: device.name,
        chip: device.meta.chip || 'ESP32-S3',
        firmware: device.meta.firmware || 'v0(旧固件)',
        ip: s && s.ip || device.host,
        mac: device.meta.mac || '',
        wifiMode: s && s.mode,
        uptime_ms: null,
        heap_free: null,
        rssi: null
      },
      pins: pins
    };
  }

  function toLegacyCommand(op, args) {
    if (op === 'gpio.write') return { pin: args.gpio, mode: 'digital', value: args.value ? 1 : 0 };
    if (op === 'gpio.set_pwm') return { pin: args.gpio, mode: 'pwm', value: Math.round((args.duty_percent || 0) / 100 * 255) };
    return null;
  }

  ESP.LanTransport = LanTransport;
  ESP.adaptLegacyState = adaptLegacyState;
})(window);
