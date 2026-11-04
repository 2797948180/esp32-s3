/* 设备监控：实时状态、信号强度、运行时间、GPIO/PWM 快照、事件与操作日志 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  function modeLabel(m) {
    return ({
      unset: '未配置', input: '浮空输入', input_pullup: '上拉输入', input_pulldown: '下拉输入',
      output: '数字输出', pwm: 'PWM 输出'
    })[m] || m || '-';
  }

  function pinList(state) {
    if (!state || !state.pins) return [];
    if (Array.isArray(state.pins)) return state.pins.slice();
    return Object.keys(state.pins).map(function (k) { return state.pins[k]; });
  }

  ESP.pages.monitor = {
    title: '设备监控',
    sub: '实时状态、心跳与历史记录',
    render: function (root, ctx) {
      var box = null;

      function device() { return ESP.store.activeDevice(); }
      function node() { return ESP.devices.activeNode(); }

      function draw() {
        U.clear(box);
        var d = device();
        if (!d) { box.appendChild(ESP.ui.noDevice('添加设备后才能看到监控数据。', '去添加设备', function () { ESP.app.navigate('devices'); })); return; }
        var n = ESP.devices.get(d.id);
        var state = n && n.state;
        var dev = (state && state.device) || {};
        var isSim = d.transport === 'sim';

        if (isSim) {
          box.appendChild(U.el('div.banner.sim', {}, [
            U.el('div', { html: '<b>模拟设备：</b>以下数据由浏览器本地生成，不代表任何真实硬件。' })
          ]));
        }
        if (!n || !n.online) {
          box.appendChild(U.el('div.banner.warn', {}, [
            U.el('div', { html: '<b>设备当前离线。</b>系统会持续自动重试连接（WebSocket 指数退避 + HTTP 轮询）。请检查供电、Wi-Fi 信号、IP 是否变化。' })
          ]));
        }

        // KPI
        var heapVals = (n.history || []).map(function (h) { return h.heap_free; });
        var rssiVals = (n.history || []).map(function (h) { return h.rssi; });
        box.appendChild(U.el('div.grid.kpi-md', {}, [
          U.el('div.card.kpi.' + (n && n.online ? 'ok' : 'off'), {}, [
            U.el('div.label', { text: '在线状态' }),
            U.el('div.value', { text: (n && n.online ? (isSim ? '模拟在线' : '在线') : '离线') }),
            U.el('div.foot', { text: '通道：' + (n && n.source || '-') })
          ]),
          U.el('div.card.kpi', {}, [
            U.el('div.label', { text: 'Wi-Fi 信号' }),
            U.el('div.value', { text: dev.rssi != null ? dev.rssi : '-' }),
            U.el('div.foot', { text: dev.rssi != null ? 'dBm · ' + (dev.rssi >= -55 ? '很好' : dev.rssi >= -70 ? '良好' : '偏弱') : '未知' })
          ]),
          U.el('div.card.kpi', {}, [
            U.el('div.label', { text: '运行时间' }),
            U.el('div.value', {}, U.el('span', { style: { fontSize: '19px' }, text: U.fmtDuration(dev.uptime_ms) })),
            U.el('div.foot', { text: '自设备启动至今' })
          ]),
          U.el('div.card.kpi', {}, [
            U.el('div.label', { text: '空闲堆内存' }),
            U.el('div.value', {}, U.el('span', { style: { fontSize: '19px' }, text: dev.heap_free != null ? U.fmtBytes(dev.heap_free) : '-' })),
            U.el('div.foot', { text: dev.heap_size ? '总 ' + U.fmtBytes(dev.heap_size) : '未知容量' })
          ]),
          U.el('div.card.kpi', {}, [
            U.el('div.label', { text: '最后通信' }),
            U.el('div.value', {}, U.el('span', { style: { fontSize: '19px' }, text: n && n.lastSeen ? U.ago(n.lastSeen) : '从未' })),
            U.el('div.foot', { text: n && n.lastSeen ? U.fmtTime(n.lastSeen) : '-' })
          ])
        ]));

        // 趋势图
        box.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [U.el('h3', { text: '趋势（近 3 分钟）' }), U.el('span.hint', { text: '采样自本地记录' })]),
          U.el('div.grid.two', {}, [
            U.el('div', {}, [
              U.el('div.small.muted', { text: '空闲堆内存' }),
              heapVals.length > 1 ? ESP.ui.sparkline(heapVals, { color: '#53d6c6' }) : U.el('div.small.muted', { text: '数据不足' })
            ]),
            U.el('div', {}, [
              U.el('div.small.muted', { text: 'Wi-Fi RSSI (dBm)' }),
              rssiVals.length > 1 ? ESP.ui.sparkline(rssiVals, { color: '#7aa5ff' }) : U.el('div.small.muted', { text: '数据不足' })
            ])
          ])
        ]));

        // 设备身份
        box.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '设备信息' }),
            U.el('div.right.row', { style: { gap: '6px' } }, [
              U.el('button.btn.sm', { text: '立即刷新', onclick: function () { if (n.transport) n.transport.refresh(); ESP.ui.toast('已请求状态刷新'); } }),
              U.el('button.btn.sm', { text: '重连', onclick: function () { ESP.devices.reload(d.id); ESP.ui.toast('正在重连…'); } }),
              U.el('button.btn.sm.danger', { text: '重启固件', onclick: reboot })
            ])
          ]),
          U.el('div.grid.two', {}, [
            U.el('div', {}, [
              ESP.ui.statRow('设备名称', dev.name || d.name),
              ESP.ui.statRow('芯片型号', dev.chip || d.meta.chip || '-'),
              ESP.ui.statRow('设备 ID', dev.id || d.remoteId || d.meta.deviceId || '-'),
              ESP.ui.statRow('MAC 地址', dev.mac || d.meta.mac || '-'),
              ESP.ui.statRow('固件版本', dev.firmware || d.meta.firmware || '-')
            ]),
            U.el('div', {}, [
              ESP.ui.statRow('IP 地址', dev.ip || d.host || '-'),
              ESP.ui.statRow('Wi-Fi 模式 / SSID', (dev.wifiMode || '-') + ' / ' + (dev.ssid || '-')),
              ESP.ui.statRow('开发板配置', (ESP.pins.boardById(d.board) || {}).name || d.board),
              ESP.ui.statRow('通信方式', ({ lan: '局域网直连', mqtt: 'MQTT 云端', sim: '模拟' })[d.transport]),
              ESP.ui.statRow('MQTT 链路', dev.mqtt ? (dev.mqtt.connected ? '已连接' : (dev.mqtt.configured ? '已配置，未连接' : '未配置')) : '-')
            ])
          ])
        ]));

        function reboot() {
          ESP.ui.confirm('重启设备', '即将向 ' + d.name + ' 下发重启指令，设备会断开数秒。确定继续？', '立即重启').then(function (ok) {
            if (!ok) return;
            ESP.devices.invoke(d.id, 'device.reboot', {}).then(function () {
              ESP.ui.toast('重启指令已下发', 'ok');
              setTimeout(function () { ESP.devices.reload(d.id); }, 3000);
            }).catch(function (e) { ESP.ui.toast('重启失败：' + e.message, 'err'); });
          });
        }

        // GPIO / PWM 快照
        var pins = pinList(state);
        if (!pins.length) {
          box.appendChild(U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: 'GPIO / PWM 实时快照' })]),
            U.el('div.empty', { text: '尚未读取到引脚数据（设备可能离线或仍是旧固件）。' })
          ]));
        } else {
          var wrap = U.el('div.tbl-wrap');
          var tbl = U.el('table.tbl');
          tbl.appendChild(U.el('thead', {}, U.el('tr', {}, [
            U.el('th', { text: '引脚' }), U.el('th', { text: '模式' }), U.el('th', { text: '当前电平' }),
            U.el('th', { text: 'PWM 频率' }), U.el('th', { text: '占空比' }), U.el('th', { text: '分辨率' }), U.el('th', { text: '原始占空比' })
          ])));
          var tb = U.el('tbody');
          pins.slice().sort(function (a, b) { return a.gpio - b.gpio; }).forEach(function (p) {
            tb.appendChild(U.el('tr', {}, [
              U.el('td.mono', { text: 'GPIO' + p.gpio }),
              U.el('td', {}, U.el('span.badge.' + (p.mode === 'output' ? 'blue' : p.mode === 'pwm' ? 'purple' : p.mode === 'unset' ? 'ghost' : 'green'), { text: modeLabel(p.mode) })),
              U.el('td', {}, U.el('span.badge.' + (p.level ? 'green' : 'ghost'), { text: p.level ? '高 (' + p.level + ')' : '低 (' + (p.level == null ? '-' : p.level) + ')' })),
              U.el('td.mono', { text: p.pwm ? (p.pwm.frequency + ' Hz') : '-' }),
              U.el('td.mono', { text: p.pwm ? (p.pwm.duty_percent + ' %') : '-' }),
              U.el('td.mono', { text: p.pwm ? (p.pwm.resolution_bits + ' bit') : '-' }),
              U.el('td.mono', { text: p.pwm ? (p.pwm.duty_raw + ' / ' + (Math.pow(2, p.pwm.resolution_bits || 10) - 1)) : '-' })
            ]));
          });
          tbl.appendChild(tb);
          wrap.appendChild(tbl);
          box.appendChild(U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: 'GPIO / PWM 实时快照' }), U.el('span.hint', { text: pins.length + ' 个引脚' })]),
            wrap
          ]));
        }

        // 事件历史
        box.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [U.el('h3', { text: '状态变化历史' }), U.el('span.hint', { text: '最多保留 200 条' })]),
          (function () {
            var h = (n && n.stateHistory) || [];
            if (!h.length) return U.el('div.empty', { text: '暂无状态变化记录。' });
            var l = U.el('div.log-list');
            h.slice(0, 40).forEach(function (e) {
              l.appendChild(U.el('div.log-item', {}, [
                U.el('span.ts', { text: U.fmtTime(e.ts) }),
                U.el('span.who', { text: e.label }),
                U.el('span.msg', { text: e.detail })
              ]));
            });
            return l;
          })()
        ]));

        // 操作日志
        box.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '操作日志' }),
            U.el('div.right.row', { style: { gap: '6px' } }, [
              U.el('button.btn.sm.ghost', { text: '清空全部日志', onclick: function () { ESP.ui.confirm('清空日志', '将删除本机保存的全部 500 条操作日志。', '清空').then(function (ok) { if (ok) { ESP.store.clearLogs(); ESP.ui.toast('已清空', 'ok'); draw(); } }); } })
            ])
          ]),
          (function () {
            var logs = ESP.store.logs({ deviceId: d.id, limit: 60 });
            if (!logs.length) return U.el('div.empty', { text: '该设备暂无操作记录。' });
            var l = U.el('div.log-list');
            logs.forEach(function (lg) {
              l.appendChild(U.el('div.log-item.lv-' + lg.level, {}, [
                U.el('span.ts', { text: U.fmtTime(lg.ts) }),
                U.el('span.who', { text: lg.action || 'info' }),
                U.el('span.msg', { text: lg.message + (lg.simulated ? ' [模拟]' : '') })
              ]));
            });
            return l;
          })()
        ]));
      }

      box = U.el('div');
      root.appendChild(box);
      draw();

      ctx.onBus('device:state', U.throttle(draw, 800));
      ctx.onBus('device:status', draw);
      ctx.onBus('active:changed', draw);
      ctx.onBus('log:added', U.throttle(draw, 1200));
      ctx.timer(U.throttle(draw, 1000), 1000);
    }
  };
})(window);
