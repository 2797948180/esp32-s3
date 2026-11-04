/* Web Serial 串口工具 + 设备信息解析 + 局域网探测
 *
 * 兼容性：Web Serial API 仅在桌面版 Chrome / Edge / Opera（含 Android）可用。
 * iOS Safari、Firefox 不支持，此时本模块会给出替代方案（设备热点配网 / 手动输入 IP / 二维码配网）。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  var BAUD = 115200;

  function supported() {
    return !!(navigator && navigator.serial);
  }

  function SerialSession() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = '';
    this.running = false;
    this.lines = [];                 // {ts, dir, text}
    this.parsed = {
      ip: '', mac: '', chip: '', firmware: '', deviceId: '', name: '', ssid: '', mode: '', apIp: ''
    };
    this.listeners = [];
    this.decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
  }

  /* 返回取消订阅函数 */
  SerialSession.prototype.on = function (fn) {
    this.listeners.push(fn);
    var self = this;
    return function () {
      var i = self.listeners.indexOf(fn);
      if (i >= 0) self.listeners.splice(i, 1);
    };
  };
  SerialSession.prototype.emit = function () { this.listeners.forEach(function (f) { f(this); }, this); };

  SerialSession.prototype.push = function (dir, text) {
    this.lines.push({ ts: Date.now(), dir: dir, text: text });
    if (this.lines.length > 3000) this.lines.shift();
    this.emit();
  };

  SerialSession.prototype.isOpen = function () { return !!(this.port && this.running); };

  SerialSession.prototype.connect = async function () {
    if (!supported()) throw new Error('当前浏览器不支持 Web Serial API（iOS Safari / Firefox 不支持）。请使用手机热点配网或在「设备管理」手动输入 IP。');
    var self = this;
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: BAUD, bufferSize: 4096 });
    this.running = true;
    this.push('sys', '串口已打开 @ ' + BAUD + 'bps');
    this.readLoop();
    return true;
  };

  SerialSession.prototype.disconnect = async function () {
    this.running = false;
    try { if (this.reader) await this.reader.cancel(); } catch (e) { }
    try { if (this.writer) await this.writer.abort(); } catch (e) { }
    try { if (this.port) await this.port.close(); } catch (e) { }
    this.port = null; this.reader = null; this.writer = null;
    this.push('sys', '串口已关闭');
  };

  SerialSession.prototype.readLoop = async function () {
    var self = this;
    if (!this.port || !this.port.readable) return;
    this.reader = this.port.readable.getReader();
    try {
      while (this.running) {
        var res = await this.reader.read();
        if (res.done) break;
        if (!res.value) continue;
        var chunk = this.decoder ? this.decoder.decode(res.value, { stream: true }) : String(res.value);
        this.buffer += chunk;
        var idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          var line = this.buffer.slice(0, idx).replace(/\r$/, '');
          this.buffer = this.buffer.slice(idx + 1);
          this.push('rx', line);
          this.parseLine(line);
        }
      }
    } catch (e) {
      this.push('err', '读取异常：' + e.message);
    } finally {
      try { this.reader.releaseLock(); } catch (e) { }
    }
  };

  SerialSession.prototype.send = async function (text, options) {
    if (!this.port || !this.port.writable) throw new Error('串口未连接');
    options = options || {};
    var lineEnd = options.rawLineEnding ? '\n' : '\r\n';
    var data = new TextEncoder().encode(String(text) + lineEnd);
    this.writer = this.port.writable.getWriter();
    try {
      await this.writer.write(data);
    } finally {
      try { this.writer.releaseLock(); } catch (e) { }
    }
    this.push('tx', text);
  };

  /* ------------------------- 设备信息解析 ------------------------- */
  SerialSession.prototype.parseLine = function (line) {
    var before = JSON.stringify(this.parsed);
    var trimmed = line.trim();

    // 1) JSON 行（固件开机自检输出 {"boot":{...}}、AT+INFO 返回 {"info":{...}}）
    if ((trimmed.charAt(0) === '{' || trimmed.indexOf('{"') >= 0)) {
      var jsonStart = trimmed.indexOf('{');
      try {
        var obj = JSON.parse(trimmed.slice(jsonStart));
        var payload = obj.info || obj.boot || obj;
        if (payload && typeof payload === 'object') {
          this.parsed.ip = payload.ip || this.parsed.ip;
          this.parsed.apIp = payload.ap_ip || this.parsed.apIp;
          this.parsed.mac = payload.mac || this.parsed.mac;
          this.parsed.chip = payload.chip || this.parsed.chip;
          this.parsed.firmware = payload.firmware || payload.fw || this.parsed.firmware;
          this.parsed.deviceId = payload.device_id || payload.id || this.parsed.deviceId;
          this.parsed.name = payload.name || this.parsed.name;
          this.parsed.ssid = payload.ssid || this.parsed.ssid;
          this.parsed.mode = payload.wifi_mode || payload.mode || this.parsed.mode;
        }
      } catch (e) { /* 非 JSON，走正则 */ }
    }

    // 2) IP 地址：形如 "Open: http://192.168.1.50" / "STA IP: 192.168.1.50"
    var ipMatch = trimmed.match(/(?:open|http|ip|addr)[^\d]{0,12}(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i);
    if (ipMatch) {
      var ip = ipMatch[1];
      if (/^192\.168\.4\.\d+$/.test(ip) || /AP/i.test(this.parsed.mode)) this.parsed.apIp = ip;
      else this.parsed.ip = ip;
    }
    // 3) MAC
    var macMatch = trimmed.match(/([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/);
    if (macMatch) this.parsed.mac = macMatch[1].toUpperCase();
    // 4) 芯片型号
    if (/ESP32-S3/i.test(trimmed)) this.parsed.chip = 'ESP32-S3';
    // 5) 固件版本
    var fw = trimmed.match(/(?:firmware|fw|version)\s*[:= ]\s*v?([0-9][\w.\-]*)/i);
    if (fw) this.parsed.firmware = fw[1];
    // 6) Wi-Fi SSID
    var ssid = trimmed.match(/(?:ssid)\s*[:= ]\s*(\S+)/i);
    if (ssid) this.parsed.ssid = ssid[1];
    // 7) 连接模式
    if (/mode\s*:?\s*STA/i.test(trimmed) || /Wi-Fi connected/i.test(trimmed)) this.parsed.mode = 'STA';
    if (/mode\s*:?\s*AP/i.test(trimmed) || /Access point/i.test(trimmed)) this.parsed.mode = 'AP';

    if (JSON.stringify(this.parsed) !== before) {
      ESP.bus.emit('serial:parsed', this.parsed);
      this.emit();
    }
  };

  /* ------------------------- 指令快捷方式 ------------------------- */
  var AT = {
    help: 'AT+HELP',
    info: 'AT+INFO',
    status: 'AT+STATUS',
    reboot: 'AT+REBOOT',
    wifiScan: 'AT+SCAN',
    wifiSet: function (ssid, pass) { return 'AT+WIFI=' + ssid + ',' + pass; },
    wifiClear: 'AT+WIFICLR',
    name: function (n) { return 'AT+NAME=' + n; },
    board: function (b) { return 'AT+BOARD=' + b; },
    mqtt: function (host, user, pass) { return 'AT+MQTT=' + host + ',' + user + ',' + pass; }
  };

  /* ------------------------- 局域网探测 ------------------------- */
  /* 用设备串口读到的 IP 去探测 HTTP 接口是否可达（在浏览器可路由到该网段时有效） */
  function probe(ip, timeoutMs) {
    timeoutMs = timeoutMs || 2500;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    return new Promise(function (resolve, reject) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); reject(new Error('探测超时')); }, timeoutMs);
      fetch('http://' + ip + '/api/v1/info', { method: 'GET', cache: 'no-store', mode: 'cors', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) return reject(new Error('HTTP ' + r.status));
          return r.json().then(resolve, function () { reject(new Error('响应不是 JSON')); });
        })
        .catch(function (e) { clearTimeout(timer); reject(new Error('无法访问 http://' + ip + ' ：' + (e.message || e))); });
    });
  }

  ESP.serialSession = new SerialSession();
  ESP.serial = { supported: supported, AT: AT, probe: probe, BAUD: BAUD, SerialSession: SerialSession };
})(window);
