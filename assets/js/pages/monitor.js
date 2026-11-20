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

  /* 显示屏实时画面（自适应）——实物 OLED 上显示什么就画什么：
     state 里有 env 就画环境监测画面（对齐固件 taskDisplay 三页），
     有 compass 就画指南针罗盘/数据页；两者都没有才提示等待。
     逻辑坐标 128x64，按 canvas 宽度自动缩放。 */
  function drawSimOLED(canvas, state) {
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var S = canvas.width / 128;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.fillStyle = '#8fd0ff';
    ctx.textBaseline = 'top';
    ctx.font = '8px ui-monospace,monospace';

    var env = (state && state.env) || null;
    var cp = (state && state.compass) || null;
    var hasEnv = env && (env.temperature != null || env.humidity != null || env.lux_bh1750 != null);
    var hasCp = cp && (cp.heading != null || cp.mag || cp.accel);

    if (hasEnv) {
      drawEnvPanel(ctx, env);
    } else if (hasCp) {
      drawCompassPanel(ctx, cp, (state && state.compassInfo) || {});
    } else {
      ctx.fillStyle = '#8fd0ff'; ctx.font = 'bold 12px ui-monospace,monospace';
      ctx.fillText('SSD1306 128x64', 24, 22);
      ctx.font = '9px ui-monospace,monospace';
      ctx.fillText('waiting for screen data', 18, 40);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // 环境画面：与固件 envstation.cpp taskDisplay() 布局一致（状态栏 + 3 页）
  function drawEnvPanel(ctx, e) {
    function n1(v, d) { return (v == null || v === 'null' || isNaN(v)) ? null : Number(v).toFixed(d == null ? 1 : d); }
    var comfort = ['GOOD', 'OKAY', 'FAIR', 'POOR!'][e.comfort] || '';
    var net = (e.net_mode === 'AP') ? 'AP' : (e.ip && e.ip !== '0.0.0.0' ? 'WiFi' : 'OFF');
    ctx.fillStyle = '#8fd0ff'; ctx.font = '8px ui-monospace,monospace';
    ctx.fillText(e.pir ? 'P' : '-', 0, 0);
    ctx.fillText(net, 14, 0);
    ctx.fillText('FAN:' + (e.fan_auto ? 'A' : 'M') + (e.fan_level || 0), 52, 0);
    ctx.fillText(comfort, 96, 0);
    ctx.fillRect(0, 9, 128, 1);

    var page = e.page == null ? 0 : Number(e.page);
    var t = n1(e.temperature, 1);
    if (page === 0) {
      ctx.fillStyle = '#cfe8ff'; ctx.font = 'bold 24px ui-monospace,monospace';
      ctx.fillText(t == null ? '--.-' : t, 0, 16);
      var tw = ctx.measureText(t == null ? '--.-' : t).width;
      ctx.font = '8px ui-monospace,monospace'; ctx.fillText(' C', tw + 1, 32);
      var h = n1(e.humidity, 1);
      ctx.fillStyle = '#7ee0b0';
      ctx.fillText('RH ' + (h == null ? '--.-' : ('    ' + h).slice(-5)) + '%', 0, 40);
      ctx.fillStyle = '#8fd0ff'; ctx.strokeRect(0.5, 50.5, 51, 7);
      ctx.fillRect(1, 51, 50 * Math.max(0, Math.min(100, Number(e.humidity) || 0)) / 100, 6);
      var lux = Number(e.lux_bh1750) || 0;
      ctx.fillStyle = '#8fd0ff';
      ctx.fillText(('    ' + (lux > 0 ? Math.round(lux) : '-')).slice(-5) + 'lx', 70, 40);
      ctx.strokeRect(70.5, 50.5, 51, 7);
      var lv = lux < 1 ? 0 : Math.min(100, Math.log(lux) / Math.LN10 * 25);
      ctx.fillRect(71, 51, 50 * lv / 100, 6);
    } else if (page === 1) {
      ctx.fillStyle = '#8fd0ff'; ctx.font = '8px ui-monospace,monospace';
      ctx.fillText('BH1750 : ' + (n1(e.lux_bh1750) || '  --.-') + ' lx', 0, 14);
      ctx.fillText('LDR AO : ' + (('      ' + (e.ldr_raw == null ? '-' : e.ldr_raw)).slice(-6)) + ' raw', 0, 22);
      ctx.fillText('LDR lux: ' + (n1(e.lux_ldr) || '  --.-') + ' lx (k=' + (e.ldr_calib != null ? Number(e.ldr_calib).toFixed(2) : '0.35') + ')', 0, 30);
      ctx.fillText('PIR    : ' + (e.pir ? 'PERSON' : 'NO ONE'), 0, 38);
      ctx.fillText('IP     : ' + (e.ip || '-'), 0, 46);
    } else if (page === 2) {
      var sel = e.setting_sel == null ? 0 : Number(e.setting_sel);
      ctx.fillStyle = '#8fd0ff'; ctx.font = '8px ui-monospace,monospace';
      ctx.fillText((sel === 0 ? '> ' : '  ') + 'Fan LOW  : ' + (n1(e.th_lo) || '-') + ' C', 0, 14);
      ctx.fillText((sel === 1 ? '> ' : '  ') + 'Fan HIGH : ' + (n1(e.th_hi) || '-') + ' C', 0, 22);
      ctx.fillText((sel === 2 ? '> ' : '  ') + 'ALARM    : ' + (n1(e.th_al) || '-') + ' C', 0, 30);
      ctx.fillText((sel === 3 ? '> ' : '  ') + 'Fan MODE : ' + (e.fan_auto ? 'AUTO' : 'MANUAL'), 0, 38);
      ctx.fillText('SW1:next SW2:+ SW3:-', 0, 54);
    }
  }

  // 指南针画面：保留罗盘页/数据页（逻辑坐标 128x64）
  function drawCompassPanel(ctx, cp, info) {
    var mode = info.display_mode != null ? info.display_mode : 0;
    if (mode === 0) {
      var cx = 64, cy = 40, r = 22;
      ctx.strokeStyle = '#4a7fb5'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#cfe8ff'; ctx.font = '8px ui-monospace,monospace';
      ctx.fillText('N', cx - 3, cy - r - 8);
      ctx.fillText('S', cx - 3, cy + r + 2);
      ctx.fillText('E', cx + r + 2, cy - 4);
      ctx.fillText('W', cx - r - 7, cy - 4);
      var rad = (Number(cp.heading) || 0) * Math.PI / 180;
      var ex = cx + Math.sin(rad) * (r - 5), ey = cy - Math.cos(rad) * (r - 5);
      ctx.strokeStyle = '#ff6b7a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = '#8fd0ff'; ctx.font = 'bold 9px ui-monospace,monospace';
      ctx.fillText('HDG ' + Number(cp.heading).toFixed(1), 4, 4);
      ctx.font = '8px ui-monospace,monospace';
      ctx.fillText((cp.dir || '-') + '  ' + (cp.calibrated ? 'CAL OK' : 'SW1=CAL'), 4, 58);
    } else {
      var m = cp.mag || [];
      ctx.fillStyle = '#8fd0ff'; ctx.font = '8px ui-monospace,monospace';
      ctx.fillText('MAG X' + (m[0] != null ? m[0] : '-'), 4, 8);
      ctx.fillText('    Y' + (m[1] != null ? m[1] : '-'), 4, 24);
      ctx.fillText('    Z' + (m[2] != null ? m[2] : '-'), 4, 40);
      ctx.fillStyle = '#ffd479';
      ctx.fillText('HDG ' + Number(cp.heading).toFixed(1), 70, 8);
      ctx.fillText('P' + Number(cp.pitch || 0).toFixed(1) + ' R' + Number(cp.roll || 0).toFixed(1), 70, 24);
      ctx.fillStyle = '#7ee0b0';
      ctx.fillText('IMU:' + (cp.imu_ok ? 'OK' : '--') + ' MAG:' + (cp.mag_ok ? 'OK' : '--'), 70, 40);
    }
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

        // 监控设置：刷新间隔与主题风格（保存在本机浏览器）
        var curRefresh = Number(ESP.store.settings().monitorRefreshMs || 1000);
        if (curRefresh < 100) curRefresh = 100;
        var curTheme = ESP.store.settings().theme || 'default';

        var refreshSel = U.el('select.sel.sm', {});
        [[100, '0.1 秒'], [500, '0.5 秒'], [1000, '1 秒'], [2000, '2 秒'], [3000, '3 秒'], [5000, '5 秒']].forEach(function (o) {
          refreshSel.appendChild(U.el('option', { value: String(o[0]), text: o[1] }));
        });
        refreshSel.value = String(curRefresh);
        refreshSel.addEventListener('change', function () {
          var ms = Number(refreshSel.value);
          ESP.store.updateSettings({ monitorRefreshMs: ms });
          ESP.ui.toast('刷新间隔已设为 ' + refreshSel.options[refreshSel.selectedIndex].text, 'ok');
          ESP.app.render();
        });

        var themeSel = U.el('select.sel.sm', {});
        [['default', '默认风格'], ['glass', '苹果玻璃风'], ['light', '白色'], ['dark', '黑色']].forEach(function (o) {
          themeSel.appendChild(U.el('option', { value: o[0], text: o[1] }));
        });
        themeSel.value = curTheme;
        themeSel.addEventListener('change', function () {
          ESP.store.updateSettings({ theme: themeSel.value });
          ESP.ui.toast('主题已切换为 ' + themeSel.options[themeSel.selectedIndex].text, 'ok');
        });

        box.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '监控设置' }),
            U.el('span.hint', { text: '仅保存在本机浏览器' })
          ]),
          U.el('div.row', { style: { gap: '18px' } }, [
            U.el('div.row', { style: { gap: '8px' } }, [
              U.el('span.small.muted', { text: '数据刷新间隔' }), refreshSel
            ]),
            U.el('div.row', { style: { gap: '8px' } }, [
              U.el('span.small.muted', { text: '主题风格' }), themeSel
            ])
          ])
        ]));

        // 仿真 OLED 屏 + 实时参数（仅真实设备、拿到状态时显示）
        if (state && !isSim) {
          var canvas = U.el('canvas.sim-oled', { width: 256, height: 128 });
          var screenWrap = U.el('div.oled-frame', {}, [canvas]);
          var env = state.env || {};
          var cp = state.compass || {};
          var hasEnv = env.temperature != null || env.humidity != null || env.lux_bh1750 != null;
          var f1 = function (v) { return (v == null || v === 'null' || isNaN(v)) ? '-' : Number(v).toFixed(1); };
          // 实时参数跟随实物屏数据：有环境数据显示环境行，有指南针数据显示姿态行
          var liveRows = hasEnv ? [
            ['温度', f1(env.temperature) + ' ℃'],
            ['湿度', f1(env.humidity) + ' %RH'],
            ['光照 BH1750', f1(env.lux_bh1750) + ' lx'],
            ['光照 LDR', f1(env.lux_ldr) + ' lx (raw ' + (env.ldr_raw != null ? env.ldr_raw : '-') + ')'],
            ['人体感应 PIR', env.pir ? '有人' : '无人'],
            ['风扇', '档 ' + (env.fan_level != null ? env.fan_level : '-') + '（' + (env.fan_auto ? '自动' : '手动') + '）']
          ] : [
            ['航向 HDG', cp.heading != null ? Number(cp.heading).toFixed(1) + '° ' + (cp.dir || '') : '-'],
            ['俯仰 / 横滚', (cp.pitch != null ? Number(cp.pitch).toFixed(1) : '-') + '° / ' + (cp.roll != null ? Number(cp.roll).toFixed(1) : '-') + '°'],
            ['姿态传感器', (cp.imu_ok ? 'MPU6050 正常' : '未连接') + ' · 磁力计 ' + (cp.mag_ok ? '正常' : '未连接')],
            ['校准状态', cp.calibrating ? ('校准中 ' + (cp.cal_progress || 0) + '%') : (cp.calibrated ? '已校准' : '未校准')],
            ['磁场 X/Y/Z', cp.mag ? cp.mag.join(' / ') : '-'],
            ['加速度 X/Y/Z', cp.accel ? cp.accel.join(' / ') : '-']
          ];
          var liveGrid = U.el('div.stat-grid');
          liveRows.forEach(function (r) { liveGrid.appendChild(ESP.ui.statRow(r[0], r[1])); });
          box.appendChild(U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: '显示屏实时画面' }), U.el('span.hint', { text: 'SSD1306 128×64 · ' + (hasEnv ? '环境数据' : (cp.heading != null ? '指南针数据' : '等待数据')) })]),
            U.el('div.oled-layout', {}, [
              screenWrap,
              U.el('div', {}, [
                U.el('div.small.muted', { text: '与实物 OLED 屏幕内容一致，页面每 ' + (curRefresh / 1000) + ' 秒刷新' }),
                liveGrid
              ])
            ])
          ]));
          // 绘制（DOM 已入树）
          drawSimOLED(canvas, state);
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

        // 自适应变化曲线：扫描指标表，有数据的指标才画曲线
        var metrics = ESP.devMetrics || [];
        var history = n.history || [];
        var activeCharts = metrics.filter(function (m) {
          return history.some(function (h) { return typeof h[m.key] === 'number' && isFinite(h[m.key]); });
        });
        if (activeCharts.length) {
          var chartGrid = U.el('div.grid.two');
          activeCharts.forEach(function (m) {
            var vals = history.map(function (h) { return h[m.key]; });
            var valid = vals.filter(function (v) { return typeof v === 'number' && isFinite(v); });
            var cur = valid.length ? valid[valid.length - 1] : null;
            var label = m.label + (m.unit ? ' (' + m.unit + ')' : '');
            chartGrid.appendChild(U.el('div', { style: { marginBottom: '10px' } }, [
              U.el('div.row', { style: { justifyContent: 'space-between' } }, [
                U.el('div.small.muted', { text: label }),
                U.el('div.small', { text: cur != null ? Number(cur).toFixed(1) : '-' })
              ]),
              ESP.ui.sparkline(vals, { color: m.color, height: 52 })
            ]));
          });
          box.appendChild(U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: '实时变化曲线' }), U.el('span.hint', { text: '自动识别 ' + activeCharts.length + ' 项有数据的指标 · 本地缓存' })]),
            chartGrid
          ]));
        }

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

      var refreshMs = Number(ESP.store.settings().monitorRefreshMs || 1000);
      if (refreshMs < 100) refreshMs = 100;
      ctx.onBus('device:state', U.throttle(draw, refreshMs));
      ctx.onBus('device:status', draw);
      ctx.onBus('active:changed', draw);
      ctx.onBus('log:added', U.throttle(draw, Math.max(refreshMs, 1200)));
      ctx.timer(draw, refreshMs);
    }
  };
})(window);
