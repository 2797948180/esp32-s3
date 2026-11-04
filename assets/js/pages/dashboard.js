/* 首页：全局概览 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  function ensureSimulatedDevice() {
    // 明确标记为模拟设备，仅用于无硬件时演示界面
    return ESP.store.addDevice({
      name: '模拟设备（非真实硬件）',
      transport: 'sim',
      host: 'simulator',
      notes: '本地模拟，不含任何真实硬件操作'
    });
  }

  ESP.pages.dashboard = {
    title: '首页',
    sub: '设备总览与最近操作',
    render: function (root, ctx) {
      var devicesRoot = U.el('div');

      function kpi(cls, label, value, foot) {
        return U.el('div.card.kpi.' + cls, {}, [
          U.el('div.label', { text: label }),
          U.el('div.value', { text: String(value) }),
          U.el('div.foot', { text: foot || '' })
        ]);
      }

      function draw() {
        U.clear(devicesRoot);
        var devices = ESP.store.devices();
        var total = devices.length;
        var online = ESP.devices.onlineCount();
        var offline = total - online;
        var sim = ESP.devices.simCount();
        var logs = ESP.store.logs({ limit: 12 });

        // 模拟设备警示横幅
        if (sim > 0) {
          devicesRoot.appendChild(U.el('div.banner.sim', {}, [
            U.el('div', {}, [
              U.el('b', { text: '检测到 ' + sim + ' 台模拟设备。' }),
              document.createTextNode('模拟设备的数据全部由浏览器本地生成，绝对不代表真实 ESP32-S3 硬件状态。要控制真实硬件，请添加传输方式为「局域网」或「MQTT 云端」的设备。')
            ])
          ]));
        }

        // KPI
        var kpis = U.el('div.grid.kpi-md', {}, [
          kpi('', '设备总数', total, total ? '已登记设备' : '尚未添加设备'),
          kpi('ok', '在线设备', online, '实时连接中'),
          kpi('off', '离线设备', offline, '超时未心跳'),
          kpi('sim', '模拟设备', sim, sim ? '仅用于演示' : '无'),
          kpi('', '最近操作', ESP.store.logs().length, '本地保留 500 条')
        ]);
        devicesRoot.appendChild(kpis);

        // 系统连接状态
        var mqttCfg = ESP.store.settings().mqtt;
        var conn = U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '系统连接状态' }),
            U.el('span.hint', { text: '本地优先：即使没有互联网，局域网控制仍可正常使用' })
          ]),
          U.el('div.stat-row', {}, [
            U.el('span.k', { text: '局域网直连（HTTP / WebSocket）' }),
            U.el('span.v', { html: '<span class="badge green">可用</span>' })
          ]),
          U.el('div.stat-row', {}, [
            U.el('span.k', { text: 'MQTT 云端（异地远程）' }),
            U.el('span.v', { html: mqttCfg.enabled && mqttCfg.host
              ? '<span class="badge blue">已配置 ' + U.escapeHtml(mqttCfg.host) + '</span>'
              : '<span class="badge ghost">未启用</span>' })
          ]),
          U.el('div.stat-row', {}, [
            U.el('span.k', { text: '本地运行方式' }),
            U.el('span.v', { text: location.protocol === 'file:' ? 'file:// 本地文件（推荐改用本地静态服务器）' : location.origin })
          ]),
          U.el('div.row.small.muted', { style: { marginTop: '10px' } }, [
            U.el('span', { text: '注意：本页面若通过 HTTPS 打开，浏览器会阻止访问 http:// 的局域网设备（混合内容），此时请改用 MQTT 云端模式。' })
          ])
        ]);
        devicesRoot.appendChild(conn);

        // 设备概览
        var cards = U.el('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))' } });
        if (!total) {
          cards.appendChild(U.el('div.empty', {}, [
            U.el('div.big', { text: '还没有设备' }),
            U.el('div', { text: '添加一台 ESP32-S3 后即可开始控制 GPIO 与 PWM。' }),
            U.el('div', { style: { marginTop: '12px' } }, [
              U.el('button.btn.primary.sm', { text: '去添加设备', onclick: function () { ESP.app.navigate('devices'); } })
            ])
          ]));
        } else {
          devices.forEach(function (d) {
            var n = ESP.devices.get(d.id);
            var isSim = d.transport === 'sim';
            var st = n && n.state && n.state.device;
            var transportLabel = { lan: '局域网', mqtt: 'MQTT 云端', sim: '模拟' }[d.transport] || d.transport;
            cards.appendChild(U.el('div.card', {}, [
              U.el('div.card-head', {}, [
                U.el('i.dot' + (isSim ? '.purple' : (n && n.online ? '.on' : '.off'))),
                U.el('h3', { text: d.name }),
                U.el('span.badge.' + (isSim ? 'purple' : (n && n.online ? 'green' : 'ghost')), { text: transportLabel }),
                U.el('span.right.small.muted', { text: n && n.lastSeen ? U.ago(n.lastSeen) : '从未连接' })
              ]),
              U.el('div.stat-row', {}, [U.el('span.k', { text: '地址' }), U.el('span.v', { text: (d.transport === 'mqtt' ? d.remoteId : d.host) || '-' })]),
              U.el('div.stat-row', {}, [U.el('span.k', { text: '开发板' }), U.el('span.v', { text: (ESP.pins.boardById(d.board) || {}).name || '-' })]),
              U.el('div.stat-row', {}, [U.el('span.k', { text: '固件 / 芯片' }), U.el('span.v', { text: ((st && st.firmware) || d.meta.firmware || '未知') + ' / ' + ((st && st.chip) || d.meta.chip || '未知') })]),
              U.el('div.stat-row', {}, [U.el('span.k', { text: 'IP / RSSI' }), U.el('span.v', { text: ((st && st.ip) || d.meta.ip || '-') + ' / ' + (st && st.rssi != null ? st.rssi + ' dBm' : '-') })]),
              U.el('div.row', { style: { marginTop: '11px' } }, [
                U.el('button.btn.sm.primary', { text: 'GPIO 控制', onclick: function () { ESP.store.setActive(d.id); ESP.app.navigate('gpio'); } }),
                U.el('button.btn.sm', { text: 'PWM', onclick: function () { ESP.store.setActive(d.id); ESP.app.navigate('pwm'); } }),
                U.el('button.btn.sm', { text: '监控', onclick: function () { ESP.store.setActive(d.id); ESP.app.navigate('monitor'); } })
              ])
            ]));
          });
        }
        devicesRoot.appendChild(cards);

        // 最近操作
        var logBox = U.el('div.card', {}, [U.el('div.card-head', {}, [U.el('h3', { text: '最近操作记录' }), U.el('span.hint', { text: '本地存储 · 最多 500 条' })])]);
        if (!logs.length) {
          logBox.appendChild(U.el('div.empty', { text: '暂无操作记录。' }));
        } else {
          var list = U.el('div.log-list');
          logs.forEach(function (l) {
            list.appendChild(U.el('div.log-item.lv-' + l.level, {}, [
              U.el('span.ts', { text: U.fmtTime(l.ts) }),
              U.el('span.who', { text: (l.deviceName || '-') + (l.simulated ? ' [模拟]' : '') }),
              U.el('span.msg', { html: U.escapeHtml(l.action ? '[' + l.action + '] ' : '') + U.escapeHtml(l.message) })
            ]));
          });
          logBox.appendChild(list);
        }
        devicesRoot.appendChild(logBox);

        // 快速动作
        devicesRoot.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [U.el('h3', { text: '快速开始' }), U.el('span.hint', { text: '没有硬件也可以先看界面' })]),
          U.el('div.row', {}, [
            U.el('button.btn.primary.sm', { text: '添加真实设备', onclick: function () { ESP.app.navigate('devices'); } }),
            U.el('button.btn.sm', { text: '创建模拟设备', onclick: function () { var d = ensureSimulatedDevice(); ESP.store.setActive(d.id); ESP.devices.reload(d.id); ESP.ui.toast('已创建模拟设备（不会操作真实硬件）', 'warn'); } }),
            U.el('button.btn.sm', { text: '打开串口工具', onclick: function () { ESP.app.navigate('serial'); } }),
            U.el('button.btn.sm', { text: '查看全部日志', onclick: function () { ESP.app.navigate('monitor'); } })
          ])
        ]));
      }

      devicesRoot.appendChild(U.el('div'));
      root.appendChild(devicesRoot);
      draw();

      ctx.onBus('devices:changed', draw);
      ctx.onBus('device:status', draw);
      ctx.onBus('log:added', U.throttle(draw, 800));
      ctx.timer(U.throttle(draw, 1500), 1500);
    }
  };
})(window);
