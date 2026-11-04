/* 模拟设备 —— 仅用于无硬件时验证界面与交互
 *
 * 【重要】本文件中的一切数据都是本地伪造的，不会、也不能驱动任何真实 ESP32-S3 硬件。
 * 界面中凡是来自模拟设备的卡片、状态、数值都会带蓝色"模拟"角标。
 * 真实控制请使用传输方式为「局域网」或「MQTT 云端」的设备。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  function SimTransport(device, cb) {
    this.device = device;
    this.cb = cb || {};
    this.stopped = true;
    this.online = false;
    this.seq = 0;
    this.startedAt = Date.now();
    this.pins = Object.create(null);
    this.timer = null;
    this.simulated = true;
    this.schema = 1;

    // 默认给几个常用引脚，模拟一套典型配置
    [4, 5, 6, 7, 8, 9, 10].forEach(function (g) {
      this.pins[g] = { gpio: g, mode: 'unset', level: 0, value: 0, pwm: null };
    }, this);
    this.pins[7].mode = 'pwm';
    this.pins[7].pwm = { enabled: true, frequency: 1000, duty_percent: 50, resolution_bits: 8, duty_raw: 128, channel: 0 };
    this.pins[8].mode = 'pwm';
    this.pins[8].pwm = { enabled: true, frequency: 5000, duty_percent: 75, resolution_bits: 10, duty_raw: 768, channel: 1 };
    this.pins[5].mode = 'output';
    this.pins[4].mode = 'input_pullup';
    this.pins[4].level = 1; this.pins[4].value = 1;
  }

  SimTransport.prototype.start = function () {
    var self = this;
    this.stopped = false;
    this.online = true;
    this.push();
    this.timer = setInterval(function () {
      self.seq++;
      // 模拟输入引脚偶尔翻转，便于验证"实时输入状态"
      Object.keys(self.pins).forEach(function (g) {
        var p = self.pins[g];
        if (p.mode === 'input' || p.mode === 'input_pullup' || p.mode === 'input_pulldown') {
          if (Math.random() < 0.02) { p.level = p.level ? 0 : 1; p.value = p.level; self.seq++; }
        }
      });
      self.push();
    }, 1000);
    if (this.cb.onStatus) this.cb.onStatus(true, 'simulator');
  };

  SimTransport.prototype.stop = function () {
    this.stopped = true;
    clearInterval(this.timer); this.timer = null;
    this.online = false;
    if (this.cb.onStatus) this.cb.onStatus(false, 'stopped');
  };

  SimTransport.prototype.push = function () {
    if (this.cb.onState) this.cb.onState(this.buildState(), 1);
  };

  SimTransport.prototype.buildState = function () {
    var self = this;
    var pins = {};
    Object.keys(this.pins).forEach(function (g) { pins[g] = U.deepClone(self.pins[g]); });
    return {
      seq: this.seq,
      ts: Date.now(),
      simulated: true,
      device: {
        id: this.device.remoteId || 'sim-' + this.device.id.slice(0, 6),
        name: this.device.name,
        chip: 'ESP32-S3',
        firmware: 'SIMULATOR',
        mac: '00:00:00:00:00:00',
        ip: '127.0.0.1',
        heap_free: 240000,
        heap_size: 380000,
        rssi: -52,
        uptime_ms: Date.now() - this.startedAt,
        wifiMode: 'SIM',
        mqtt: { configured: false, connected: false }
      },
      pins: pins,
      pwm: { channels: 8, used: Object.keys(this.pins).filter(function (g) { return self.pins[g].mode === 'pwm'; }).length }
    };
  };

  SimTransport.prototype.invoke = function (op, args) {
    var self = this;
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var r = self.exec(op, args || {});
          self.seq++;
          resolve({ ok: true, result: r, state: self.buildState() });
          setTimeout(function () { self.push(); }, 0);
        } catch (e) {
          reject(e);
        }
      }, 60 + Math.random() * 120);
    });
  };

  SimTransport.prototype.refresh = function () {
    this.push();
    return Promise.resolve(this.buildState());
  };

  SimTransport.prototype.exec = function (op, args) {
    var self = this;
    var p = this.pins[args.gpio];
    if (!p && !(op === 'gpio.batch' || op === 'device.rename' || op === 'device.reboot' || op === 'info')) {
      throw new Error('模拟固件：引脚 GPIO' + args.gpio + ' 不存在');
    }
    switch (op) {
      case 'gpio.set_mode':
        return this.setMode(p, args.mode);
      case 'gpio.write':
        if (p.mode !== 'output' && p.mode !== 'output_od') throw new Error('GPIO' + p.gpio + ' 当前不是数字输出模式');
        p.level = args.value ? 1 : 0; p.value = p.level;
        return { gpio: p.gpio, mode: p.mode, level: p.level };
      case 'gpio.set_pwm':
        return this.setPwm(p, args);
      case 'gpio.batch':
        var results = (args.commands || []).map(function (c) {
          try { return { ok: true, result: self.exec(c.op, c.args || {}) }; }
          catch (e) { return { ok: false, gpio: (c.args || {}).gpio, error: { message: e.message } }; }
        });
        return { results: results };
      case 'device.rename':
        this.device.name = args.name;
        return { name: args.name };
      case 'device.reboot':
        this.startedAt = Date.now();
        return { rebooting: true };
      case 'info':
        return this.buildState().device;
      default:
        throw new Error('模拟固件暂不支持的操作：' + op);
    }
  };

  SimTransport.prototype.setMode = function (p, mode) {
    if (mode === 'pwm') {
      if (!p.pwm) p.pwm = { enabled: false, frequency: 1000, duty_percent: 0, resolution_bits: 10, duty_raw: 0, channel: Object.keys(this.pins).length };
      p.mode = 'pwm';
    } else if (mode === 'output') {
      if (p.pwm) p.pwm.enabled = false;
      p.mode = 'output'; p.level = 0; p.value = 0;
    } else if (mode === 'input' || mode === 'input_pullup' || mode === 'input_pullup_pulldown' || mode === 'input_pulldown') {
      if (p.pwm) p.pwm.enabled = false;
      p.mode = mode; p.level = 0; p.value = 0;
    } else if (mode === 'unset') {
      p.mode = 'unset'; p.level = 0; p.value = 0;
      if (p.pwm) p.pwm.enabled = false;
    } else {
      throw new Error('不支持的引脚模式：' + mode);
    }
    return { gpio: p.gpio, mode: p.mode };
  };

  SimTransport.prototype.setPwm = function (p, args) {
    if (p.mode !== 'pwm') { this.setMode(p, 'pwm'); p = this.pins[p.gpio]; p.mode = 'pwm'; }
    var res = args.resolution_bits || (p.pwm.resolution_bits || 10);
    if (res < 1 || res > 14) throw new Error('分辨率超出范围（1-14 bit）');
    var freq = args.frequency || (p.pwm.frequency || 1000);
    if (freq < 10 || freq > 80000000) throw new Error('频率超出范围');
    var duty = U.clamp(Number(args.duty_percent || (p.pwm.duty_percent || 0)), 0, 100);
    var max = (Math.pow(2, res) - 1);
    p.pwm.resolution_bits = res;
    p.pwm.frequency = freq;
    p.pwm.duty_percent = Math.round(duty * 100) / 100;
    p.pwm.duty_raw = Math.round(duty / 100 * max);
    p.pwm.enabled = args.enabled !== false;
    p.level = p.pwm.duty_percent > 0 ? 1 : 0;
    return { gpio: p.gpio, mode: 'pwm', pwm: U.deepClone(p.pwm) };
  };

  ESP.SimTransport = SimTransport;
})(window);
