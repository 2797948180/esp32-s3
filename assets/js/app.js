/* 应用外壳：路由、设备选择器、全局状态、页面生命周期管理 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  var ROUTES = ['dashboard', 'devices', 'gpio', 'pwm', 'monitor', 'serial', 'settings', 'voltage'];
  var pageCtx = null;       // 当前页 { key, cleanups:[] }

  function routeFromHash() {
    var r = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES.indexOf(r) >= 0 ? r : 'dashboard';
  }

  function scope() {
    return {
      cleanups: [],
      onBus: function (name, fn) {
        ESP.bus.on(name, fn);
        this.cleanups.push(function () { ESP.bus.off(name, fn); });
        return fn;
      },
      timer: function (fn, ms) {
        var id = setInterval(fn, ms);
        this.cleanups.push(function () { clearInterval(id); });
        return id;
      },
      cleanup: function (fn) { this.cleanups.push(fn); }
    };
  }

  function clearPage() {
    if (!pageCtx) return;
    pageCtx.cleanups.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
    pageCtx = null;
  }

  function render(saveHash) {
    var key = routeFromHash();
    var page = ESP.pages[key];
    if (!page) key = 'dashboard';
    if (!ESP.pages[key]) { location.hash = '#/dashboard'; return; }

    clearPage();
    pageCtx = scope();

    // 侧栏 / 底栏高亮
    U.qsa('.nav-item').forEach(function (n) { n.classList.toggle('active', n.dataset.route === key); });
    U.qsa('.bb-item').forEach(function (n) { n.classList.toggle('active', n.dataset.route === key); });

    var root = document.getElementById('view');
    U.clear(root);
    document.getElementById('pageTitle').textContent = ESP.pages[key].title || '';
    document.getElementById('pageSub').textContent = ESP.pages[key].sub || '';

    closeMobileNav();
    try {
      ESP.pages[key].render(root, pageCtx, ESP.app);
    } catch (e) {
      console.error('[page] ' + key, e);
      root.appendChild(U.el('div.banner.err', {}, '页面渲染出错：' + e.message));
    }
    refreshGlobal();
    if (window.scrollY) window.scrollTo(0, 0);
  }

  function refreshGlobal() {
    var devices = ESP.store.devices();
    var node = ESP.devices.activeNode();
    var online = ESP.devices.onlineCount();
    var sim = ESP.devices.simCount();

    var sel = document.getElementById('deviceSelect');
    var cur = ESP.store.activeDevice();
    if (sel) {
      U.clear(sel);
      if (!devices.length) {
        sel.appendChild(U.el('option', { value: '', text: '暂无设备' }));
      } else {
        sel.appendChild(U.el('option', { value: '', text: '未选择设备' }));
        devices.forEach(function (d) {
          var n = ESP.devices.get(d.id);
          var tag = d.transport === 'sim' ? ' [模拟]' : '';
          var state = n && n.online ? '● ' : '○ ';
          sel.appendChild(U.el('option', { value: d.id, text: state + d.name + ' (' + (d.host || d.remoteId || '-') + ')' + tag }));
        });
        sel.value = cur ? cur.id : '';
      }
    }

    var dot = document.getElementById('globalDot');
    var status = document.getElementById('globalStatus');
    if (dot && status) {
      dot.className = 'dot';
      if (!devices.length) { status.textContent = '无设备'; }
      else if (online === 0) { dot.classList.add('off'); status.textContent = '全部离线'; }
      else if (sim && online === sim) { dot.classList.add('purple'); status.textContent = '仅模拟设备在线'; }
      else { dot.classList.add('on'); status.textContent = '在线 ' + online + '/' + devices.length; }
    }

    var sideNode = document.getElementById('sidebarMode');
    if (sideNode) {
      U.clear(sideNode);
      sideNode.appendChild(U.el('i.dot' + (online ? '.on' : '.off')));
      sideNode.appendChild(U.el('span.muted', { text: cur ? cur.name : '未选择设备' }));
    }
    var cnt = document.getElementById('navDeviceCount');
    if (cnt) cnt.textContent = String(devices.length);
  }

  function closeMobileNav() {
    var sb = document.getElementById('sidebar'), sc = document.getElementById('scrim');
    if (sb) sb.classList.remove('open');
    if (sc) sc.classList.remove('show');
  }

  /* ------------------------------ 初始化 ------------------------------ */
  function boot() {
    // 来自 transport / devices 的日志统一写入本地存储的日志区
    ESP.bus.on('log', function (e) { ESP.store.pushLog(e); });

    U.qsa('.nav-item,.bb-item').forEach(function (n) {
      n.addEventListener('click', function () {
        location.hash = '#/' + n.dataset.route;
        refreshGlobal();
      });
    });

    document.getElementById('menuBtn').addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('scrim').classList.toggle('show');
    });
    document.getElementById('scrim').addEventListener('click', closeMobileNav);

    document.getElementById('deviceSelect').addEventListener('change', function (e) {
      ESP.store.setActive(e.target.value || null);
      render();
    });

    window.addEventListener('hashchange', function () { render(); });

    // 设备状态变化时刷新全局指示；状态更新不需要重绘页面（页面自行订阅）
    ESP.bus.on('device:status', function () { refreshGlobal(); });
    ESP.bus.on('devices:changed', function () { refreshGlobal(); });

    ESP.devices.startAll();
    ESP.app.started = true;

    if (!ESP.store.devices().length) {
      location.hash = '#/devices';
      ESP.ui.toast('尚未添加设备 —— 请先在「设备管理」中添加一台 ESP32-S3', 'warn', 6000);
    }
    render();
  }

  ESP.app = {
    ROUTES: ROUTES,
    navigate: function (key) { location.hash = '#/' + key; },
    route: routeFromHash,
    render: render,
    refreshGlobal: refreshGlobal,
    renderPage: function () { render(); },
    started: false
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
