/* ESP32-S3 远程监控与控制平台 —— 核心工具
 * 无框架、无构建步骤，使用传统 script 标签加载，兼容本地 file:// 打开。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    var d = Date.now().toString(16);
    return 'id-' + d + '-' + Math.random().toString(16).slice(2, 10);
  }

  function shortId(len) {
    len = len || 8;
    var s = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < len; i++) out += s.charAt(Math.floor(Math.random() * s.length));
    return out;
  }

  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

  function isInt(v, min, max) {
    var n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n) return false;
    return (typeof min === 'number' ? n >= min : true) && (typeof max === 'number' ? n <= max : true);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* 轻量 DOM 构造器：el('div.card', {onclick:fn}, [子节点或字符串]) */
  function el(spec, attrs, children) {
    var parts = String(spec).split('.');
    var node = document.createElement(parts.shift() || 'div');
    if (parts.length) node.className = parts.join(' ');
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className += (node.className ? ' ' : '') + v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    append(node, children);
    return node;
  }

  function append(parent, children) {
    if (children == null) return parent;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return append(parent, c);
      parent.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
    });
    return parent;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  function debounce(fn, wait) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function throttle(fn, wait) {
    var last = 0, timer = null;
    return function () {
      var ctx = this, args = arguments, now = Date.now();
      var remain = wait - (now - last);
      if (remain <= 0) { last = now; fn.apply(ctx, args); }
      else if (!timer) {
        timer = setTimeout(function () { timer = null; last = Date.now(); fn.apply(ctx, args); }, remain);
      }
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtDuration(ms) {
    if (ms == null || !isFinite(ms)) return '-';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    if (d) return d + '天 ' + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
    return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  function fmtBytes(n) {
    if (n == null) return '-';
    if (n >= 1048576) return (n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(n % 1024 === 0 ? 0 : 1) + ' KB';
    return n + ' B';
  }

  function ago(ts) {
    if (!ts) return '从未';
    var d = Date.now() - ts;
    if (d < 3000) return '刚刚';
    if (d < 60000) return Math.floor(d / 1000) + ' 秒前';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return; done = true;
        reject(new Error(message || ('请求超时（' + ms + 'ms）')));
      }, ms);
      Promise.resolve(promise).then(function (v) { clearTimeout(t); if (!done) { done = true; resolve(v); } },
        function (e) { clearTimeout(t); if (!done) { done = true; reject(e); } });
    });
  }

  function normalizeHost(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    if (s.indexOf('.') > 0 && !/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s; // mDNS 域名
    if (/^[a-fA-F0-9]*:[a-fA-F0-9]{2}/.test(s)) return '[' + s + ']';     // IPv6
    return s;
  }

  function baseUrl(device) {
    var scheme = device.secure ? 'https' : 'http';
    return scheme + '://' + normalizeHost(device.host) + ':' + (device.port || 80);
  }

  function isIpv4(s) { return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(s || '')); }

  /* 根据本机局域网 IP 推断待扫描的子网前缀（仅用于"扫描发现"辅助功能） */
  function localSubnetHint() {
    return window.__ESP_SUBNET_HINT__ || null;
  }

  ESP.util = {
    uuid: uuid, shortId: shortId, clamp: clamp, isInt: isInt, escapeHtml: escapeHtml,
    qs: qs, qsa: qsa, el: el, append: append, clear: clear, debounce: debounce, throttle: throttle,
    fmtTime: fmtTime, fmtDuration: fmtDuration, fmtBytes: fmtBytes, ago: ago, pad2: pad2,
    deepClone: deepClone, withTimeout: withTimeout, normalizeHost: normalizeHost,
    baseUrl: baseUrl, isIpv4: isIpv4, localSubnetHint: localSubnetHint
  };

  /* ----------------------------- 事件总线 ----------------------------- */
  ESP.bus = (function () {
    var map = Object.create(null);
    return {
      on: function (name, fn) { (map[name] = map[name] || []).push(fn); return function () { ESP.bus.off(name, fn); }; },
      off: function (name, fn) {
        var l = map[name]; if (!l) return;
        var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
      },
      emit: function (name, payload) {
        var l = (map[name] || []).slice();
        for (var i = 0; i < l.length; i++) {
          try { l[i](payload); } catch (e) { console.error('[bus] ' + name, e); }
        }
      }
    };
  })();

})(window);
