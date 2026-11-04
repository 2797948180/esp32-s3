/* MQTT over WebSocket 传输（用于互联网异地远程控制）
 *
 * 内含一个零依赖的 MQTT 3.1.1 客户端实现（只用到 CONNECT/SUBSCRIBE/PUBLISH/PUBACK/PING/DISCONNECT），
 * 因此不需要引入 mqtt.js、不需要 npm、不依赖 CDN。
 *
 * Topic 约定（与固件一致）：
 *   devices/{device_id}/command    网页 -> 设备
 *   devices/{device_id}/response   设备 -> 网页（带 command_id）
 *   devices/{device_id}/status     设备 -> 网页（全量状态 + 遗嘱离线消息）
 *   devices/{device_id}/heartbeat  设备 -> 网页（心跳）
 *
 * 安全说明：
 *  - 必须使用 wss://（EMQX Serverless 提供 8084 端口的 MQTT over WSS）。
 *  - 网页里的用户名/密码保存在本机 localStorage；正式上线前建议改为通过
 *    Cloudflare Worker 换取短期凭证（见 docs/CLOUDFLARE.md）。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  /* ============================ 编码工具 ============================ */
  var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  var decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

  function utf8Bytes(str) {
    if (encoder) return encoder.encode(str);
    var out = [], i, c;
    var s = unescape(encodeURIComponent(str));
    for (i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return new Uint8Array(out);
  }

  function utf8String(bytes) {
    if (decoder) return decoder.decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  function Writer() { this.buf = []; }
  Writer.prototype.byte = function (b) { this.buf.push(b & 0xff); return this; };
  Writer.prototype.u16 = function (n) { this.buf.push((n >> 8) & 0xff, n & 0xff); return this; };
  Writer.prototype.raw = function (arr) { for (var i = 0; i < arr.length; i++) this.buf.push(arr[i]); return this; };
  Writer.prototype.str = function (s) { var b = utf8Bytes(s); this.u16(b.length); this.raw(b); return this; };
  Writer.prototype.toArray = function () { return new Uint8Array(this.buf); };

  function remainingLengthBytes(n) {
    var out = [];
    do {
      var b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    return out;
  }

  function buildPacket(first, body) {
    var w = new Writer();
    w.byte(first);
    w.raw(remainingLengthBytes(body.length));
    w.raw(body);
    return w.toArray();
  }

  /* ============================ MQTT 客户端 ============================ */
  function MqttClient(opts) {
    this.opts = opts;
    this.ws = null;
    this.connected = false;
    this.packetId = 1;
    this.pendingAck = Object.create(null);
    this.subAckWait = Object.create(null);
    this.pending = Object.create(null);          // command_id -> {resolve,reject,timer}
    this.pingTimer = null;
    this.retryDelay = 1000;
    this.reconnectTimer = null;
    this.stopped = true;
    this.rxBuffer = null;
    this.rxOffset = 0;
  }

  MqttClient.prototype.nextPacketId = function () {
    var id = this.packetId++;
    if (this.packetId > 65535) this.packetId = 1;
    return id;
  };

  MqttClient.prototype.connect = function () {
    var self = this;
    this.stopped = false;
    if (typeof WebSocket === 'undefined') { this.fail(new Error('当前环境不支持 WebSocket')); return; }
    try { this.ws = new WebSocket(this.opts.url, 'mqtt'); }
    catch (e) { this.fail(e); return; }
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = function () { self.sendConnect(); };
    this.ws.onmessage = function (ev) { self.feed(ev.data); };
    this.ws.onerror = function (e) { /* close 里统一处理 */ };
    this.ws.onclose = function () {
      self.connected = false;
      clearInterval(self.pingTimer);
      self.flushPending(new Error('MQTT 连接已断开'));
      if (!self.stopped) self.scheduleReconnect();
      if (self.opts.onClose) self.opts.onClose();
    };
  };

  MqttClient.prototype.close = function () {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(buildPacket(0xe0, [])); } catch (e) { }
    }
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) { } }
    this.ws = null;
    this.connected = false;
  };

  MqttClient.prototype.fail = function (e) {
    if (this.opts.onError) this.opts.onError(e);
    if (!this.stopped) this.scheduleReconnect();
  };

  MqttClient.prototype.scheduleReconnect = function () {
    var self = this;
    if (this.stopped || this.reconnectTimer) return;
    var d = Math.min(this.retryDelay, 20000);
    this.retryDelay = Math.min(this.retryDelay * 2, 20000);
    this.reconnectTimer = setTimeout(function () { self.reconnectTimer = null; self.connect(); }, d);
  };

  MqttClient.prototype.send = function (arr) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('MQTT 未连接');
    this.ws.send(arr);
  };

  MqttClient.prototype.sendConnect = function () {
    var self = this;
    var o = this.opts;
    var w = new Writer();
    w.str('MQTT');
    w.byte(4);                                   // MQTT 3.1.1
    var flags = 0x02;                            // clean session
    if (o.username) flags |= 0x80;
    if (o.password) flags |= 0x40;
    if (o.lwt) flags |= 0x04;                    // WillQoS=0, WillRetain=0
    w.byte(flags);
    w.u16(o.keepalive || 60);
    w.str(o.clientId || ('esp32s3-web-' + U.shortId(8)));
    if (o.lwt) { w.str(o.lwt.topic); w.raw(utf8Bytes(o.lwt.payload || '')); }
    if (o.username) w.str(o.username);
    if (o.password) w.str(o.password);

    try { this.send(buildPacket(0x10, w.toArray())); }
    catch (e) { return this.fail(e); }

    this.pingTimer = setInterval(function () {
      try { self.send(buildPacket(0xc0, [])); } catch (e) { }
    }, (o.keepalive || 60) * 1000 / 2);

    // CONNACK 超时保护
    setTimeout(function () {
      if (!self.connected && self.ws && self.ws.readyState === WebSocket.OPEN) {
        self.fail(new Error('MQTT 认证失败或 Broker 未响应（请检查地址/用户名/密码）'));
        try { self.ws.close(); } catch (e) { }
      }
    }, 8000);
  };

  MqttClient.prototype.subscribe = function (topic, qos) {
    var self = this;
    var pid = this.nextPacketId();
    var w = new Writer();
    w.u16(pid);
    w.str(topic);
    w.byte(qos || 0);
    this.send(buildPacket(0x82, w.toArray()));
    return new Promise(function (resolve, reject) {
      self.subAckWait[pid] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (self.subAckWait[pid]) { var p = self.subAckWait[pid]; delete self.subAckWait[pid]; p.reject(new Error('订阅超时：' + topic)); }
      }, 6000);
    });
  };

  /* QoS 1 发布，等待 PUBACK */
  MqttClient.prototype.publish = function (topic, payload, qos) {
    var self = this;
    qos = qos == null ? 1 : qos;
    var pid = this.nextPacketId();
    var bodyBytes = typeof payload === 'string' ? utf8Bytes(payload) : payload;
    var w = new Writer();
    w.str(topic);
    if (qos > 0) w.u16(pid);
    w.raw(bodyBytes);
    var first = 0x30 | (qos << 1);
    this.send(buildPacket(first, w.toArray()));
    if (qos === 0) return Promise.resolve(true);
    return new Promise(function (resolve, reject) {
      self.pendingAck[pid] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (self.pendingAck[pid]) { var p = self.pendingAck[pid]; delete self.pendingAck[pid]; p.reject(new Error('PUBLISH 未收到 PUBACK')); }
      }, 8000);
    });
  };

  /* --------------------------- 接收解析 --------------------------- */
  MqttClient.prototype.feed = function (data) {
    var incoming;
    if (typeof data === 'string') {
      incoming = new Uint8Array(data.length);
      for (var j = 0; j < data.length; j++) incoming[j] = data.charCodeAt(j) & 0xff;
    } else incoming = new Uint8Array(data);

    var buf;
    if (this.rxBuffer && this.rxOffset < this.rxBuffer.length) {
      buf = new Uint8Array(this.rxBuffer.length - this.rxOffset + incoming.length);
      buf.set(this.rxBuffer.subarray(this.rxOffset), 0);
      buf.set(incoming, this.rxBuffer.length - this.rxOffset);
    } else buf = incoming;
    this.rxBuffer = buf; this.rxOffset = 0;

    while (this.rxOffset < this.rxBuffer.length) {
      var start = this.rxOffset;
      if (this.rxBuffer.length - start < 2) break;
      var first = this.rxBuffer[start];
      var mult = 1, len = 0, i = start + 1, digit;
      do {
        if (i >= this.rxBuffer.length) return;               // 数据不完整，等待更多
        digit = this.rxBuffer[i++];
        len += (digit & 0x7f) * mult;
        mult *= 128;
      } while ((digit & 0x80) !== 0);
      if (this.rxBuffer.length - i < len) return;            // 包体未收全
      this.handlePacket(first, this.rxBuffer.subarray(i, i + len));
      this.rxOffset = i + len;
    }
    this.rxBuffer = null;
  };

  MqttClient.prototype.handlePacket = function (first, body) {
    var type = first >> 4;
    var dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (type === 2) {                                        // CONNACK
      if (body.length < 2) return;
      if (body[1] !== 0) {
        this.fail(new Error('MQTT Broker 拒绝连接，返回码 ' + body[1]));
        return;
      }
      this.connected = true;
      this.retryDelay = 1000;
      if (this.opts.onConnect) this.opts.onConnect();
      if (this.opts.topics) {
        var self = this;
        this.opts.topics.forEach(function (t) { self.subscribe(t, self.opts.qos || 0); });
      }
      return;
    }
    if (type === 4) {                                        // PUBACK
      var pid = dv.getUint16(0);
      if (this.pendingAck[pid]) { var pa = this.pendingAck[pid]; delete this.pendingAck[pid]; pa.resolve(true); }
      return;
    }
    if (type === 9) {                                        // SUBACK
      var sid = dv.getUint16(0);
      if (this.subAckWait[sid]) { var sa = this.subAckWait[sid]; delete this.subAckWait[sid]; sa.resolve(true); }
      return;
    }
    if (type === 13) return;                                 // PINGRESP
    if (type === 3) {                                        // PUBLISH
      var qos = (first & 0x06) >> 1;
      var tlen = dv.getUint16(0);
      var topic = utf8String(body.subarray(2, 2 + tlen));
      var rest = 2 + tlen;
      if (qos > 0) rest += 2;
      var payload = utf8String(body.subarray(rest));
      if (this.opts.onMessage) this.opts.onMessage(topic, payload);
      return;
    }
  };

  MqttClient.prototype.flushPending = function (err) {
    Object.keys(this.pending).forEach(function (k) {
      var p = this.pending[k]; if (!p) return;
      clearTimeout(p.timer); p.reject(err); delete this.pending[k];
    }, this);
  };

  /* ======================== 平台用 MQTT 传输层 ======================== */
  function MqttTransport(device, cb) {
    this.device = device;
    this.cb = cb || {};
    this.client = null;
    this.online = false;
    this.lastState = null;
    this.stopped = true;
    this.deviceId = device.remoteId || device.meta.deviceId || '';
    this.schema = 1;
    this.simulated = false;
  }

  MqttTransport.prototype.topic = function (kind) { return 'devices/' + this.deviceId + '/' + kind; };

  MqttTransport.prototype.start = function () {
    var self = this;
    var s = ESP.store.settings().mqtt;
    this.stopped = false;
    if (!this.deviceId) {
      ESP.bus.emit('log', { level: 'error', action: 'MQTT', message: '设备未设置 MQTT device_id，无法建立云端连接', deviceId: this.device.id });
      return;
    }
    if (!s.host) {
      ESP.bus.emit('log', { level: 'error', action: 'MQTT', message: '尚未在系统设置中配置 MQTT Broker 地址', deviceId: this.device.id });
      return;
    }
    var scheme = s.secure === false ? 'ws' : 'wss';
    var url = scheme + '://' + s.host + ':' + (s.port || 8084) + (s.path || '/mqtt');

    this.client = new MqttClient({
      url: url,
      clientId: (s.clientPrefix || 'esp32s3-web') + '-' + U.shortId(8),
      username: s.username || undefined,
      password: s.password || undefined,
      keepalive: s.keepalive || 60,
      topics: [this.topic('response'), this.topic('status'), this.topic('heartbeat')],
      onConnect: function () {
        ESP.bus.emit('log', { level: 'ok', action: 'MQTT', message: '云端 Broker 连接成功（' + url + '）', deviceId: self.device.id });
        self.setOnline(false);                               // 仍需等待设备自身上线
        // 主动请求一次状态
        self.invoke('state', {});
      },
      onClose: function () { self.setOnline(false); },
      onError: function (e) { ESP.bus.emit('log', { level: 'error', action: 'MQTT', message: e.message, deviceId: self.device.id }); },
      onMessage: function (topic, payload) { self.onMessage(topic, payload); }
    });
    this.client.connect();
  };

  MqttTransport.prototype.stop = function () {
    this.stopped = true;
    if (this.client) this.client.close();
    this.client = null;
    this.setOnline(false);
  };

  MqttTransport.prototype.setOnline = function (v) {
    if (this.online === v) return;
    this.online = v;
    if (this.cb.onStatus) this.cb.onStatus(v, 'mqtt');
  };

  MqttTransport.prototype.onMessage = function (topic, payload) {
    var self = this;
    var data;
    try { data = JSON.parse(payload); } catch (e) { return; }
    var suffix = topic.split('/').pop();

    if (suffix === 'status') {
      this.setOnline(data.online !== false);
      if (data.state) this.applyState(data.state);
      else this.applyState(data);
    } else if (suffix === 'heartbeat') {
      this.lastHeartbeat = Date.now();
      this.setOnline(true);
      if (this.lastState) {
        var st = U.deepClone(this.lastState);
        st.ts = Date.now();
        if (st.device) { st.device.uptime_ms = data.uptime_ms; st.device.rssi = data.rssi; st.device.ip = data.ip || st.device.ip; }
        this.applyState(st);
      }
    } else if (suffix === 'response') {
      var cid = data.command_id;
      var p = cid && this.client && this.client.pending[cid];
      this.setOnline(true);
      if (p) {
        clearTimeout(p.timer);
        delete this.client.pending[cid];
        if (data.ok === false) p.reject(new Error((data.error && (data.error.message || data.error)) || '设备执行失败'));
        else p.resolve(data);
      }
      if (data.state) this.applyState(data.state);
    }
  };

  MqttTransport.prototype.applyState = function (state) {
    if (!state) return;
    this.lastState = state;
    if (this.cb.onState) this.cb.onState(state, 1);
  };

  MqttTransport.prototype.invoke = function (op, args, opts) {
    var self = this;
    opts = opts || {};
    if (!this.client || !this.client.connected) return Promise.reject(new Error('MQTT Broker 未连接（请检查系统设置中的 Broker 配置）'));
    var commandId = opts.id || ('cmd-' + Date.now().toString(36) + '-' + U.shortId(6));
    var envelope = {
      command_id: commandId,
      device_id: this.deviceId,
      command: op,
      params: args || {},
      timestamp: Date.now()
    };
    var timeout = opts.timeout || 8000;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (self.client) delete self.client.pending[commandId];
        reject(new Error('设备未在 ' + timeout + 'ms 内返回结果（本地? 云端延迟? 设备离线?）'));
      }, timeout);
      self.client.pending[commandId] = { resolve: resolve, reject: reject, timer: timer };
      self.client.publish(self.topic('command'), JSON.stringify(envelope), 1).catch(function (e) {
        clearTimeout(timer);
        delete self.client.pending[commandId];
        reject(e);
      });
    });
  };

  MqttTransport.prototype.refresh = function () { return this.invoke('state', {}); };

  ESP.MqttTransport = MqttTransport;
  ESP.MqttClient = MqttClient;
})(window);
