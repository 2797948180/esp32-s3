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

  /* 自适应阈值控件表：键与 ESP.devMetrics 对应。
     有 op/opFor 的指标会下发到设备；其余指标保存在本机，用于页面状态提示。 */
  var THRESHOLD_CONTROLS = {
    temperature: {
      fields: [
        { key: 'lo', label: '风扇低温 ℃', def: 26, min: -20, max: 80, step: 0.5 },
        { key: 'hi', label: '风扇高温 ℃', def: 30, min: -20, max: 80, step: 0.5 },
        { key: 'alarm', label: '报警温度 ℃', def: 33, min: -20, max: 80, step: 0.5 }
      ],
      op: 'env.thresholds',
      args: function (v) { return { lo: Number(v.lo), hi: Number(v.hi), alarm: Number(v.alarm) }; }
    },
    humidity:       { field: { key: 'value', label: '湿度上限', def: 70,   min: 0,    max: 100,   step: 1 } },
    lux_bh1750:     { field: { key: 'value', label: '光照上限', def: 1000, min: 0,    max: 200000, step: 10 } },
    lux_ldr:        { field: { key: 'value', label: '光照上限', def: 1000, min: 0,    max: 200000, step: 10 } },
    fan_level: {
      type: 'select',
      options: [['auto', '自动模式'], ['0', '0 档 停止'], ['1', '1 档 低速'], ['2', '2 档 中速'], ['3', '3 档 高速']],
      opFor:  function (v) { return v === 'auto' ? 'env.fan.auto' : 'env.fan.level'; },
      argsFor: function (v) { return v === 'auto' ? { enabled: true } : { level: Number(v) }; }
    },
    pir:          { type: 'select', options: [[0, '无人'], [1, '有人']] },
    heading:      { field: { key: 'value', label: '航向阈值', def: 180, min: 0,    max: 360,  step: 1 } },
    pitch:        { field: { key: 'value', label: '俯仰阈值', def: 0,   min: -90,  max: 90,   step: 1 } },
    roll:         { field: { key: 'value', label: '横滚阈值', def: 0,   min: -90,  max: 90,   step: 1 } },
    mag_x:        { field: { key: 'value', label: '磁场 X 阈值', def: 0, min: -200, max: 200, step: 1 } },
    mag_y:        { field: { key: 'value', label: '磁场 Y 阈值', def: 0, min: -200, max: 200, step: 1 } },
    mag_z:        { field: { key: 'value', label: '磁场 Z 阈值', def: 0, min: -200, max: 200, step: 1 } },
    accel_x:      { field: { key: 'value', label: '加速度 X 阈值', def: 0, min: -2, max: 2, step: 0.01 } },
    accel_y:      { field: { key: 'value', label: '加速度 Y 阈值', def: 0, min: -2, max: 2, step: 0.01 } },
    accel_z:      { field: { key: 'value', label: '加速度 Z 阈值', def: 0, min: -2, max: 2, step: 0.01 } }
  };

  var COMPASS_METRIC_KEYS = {
    heading: 1, pitch: 1, roll: 1,
    mag_x: 1, mag_y: 1, mag_z: 1,
    accel_x: 1, accel_y: 1, accel_z: 1
  };
  function metricGroup(m) { return (m && COMPASS_METRIC_KEYS[m.key]) ? 'compass' : 'env'; }

  function hasEnvData(env) {
    return !!(env && (env.temperature != null || env.humidity != null || env.lux_bh1750 != null ||
                      env.lux_ldr != null || env.fan_level != null || env.pir != null));
  }
  function hasCompassData(cp) {
    return !!(cp && (cp.heading != null || cp.pitch != null || cp.roll != null || cp.mag || cp.accel));
  }
  function sigPart(v) {
    if (v == null) return '-';
    return (typeof v === 'object') ? JSON.stringify(v) : String(v);
  }
  function envSignature(env) {
    if (!env) return '';
    return [env.temperature, env.humidity, env.lux_bh1750, env.lux_ldr, env.ldr_raw,
            env.pir, env.fan_level, env.fan_auto, env.page, env.comfort].map(sigPart).join('|');
  }
  function compassSignature(cp) {
    if (!cp) return '';
    return [cp.heading, cp.pitch, cp.roll, cp.dir, cp.mag, cp.accel,
            cp.mag_ok, cp.imu_ok, cp.calibrated].map(sigPart).join('|');
  }

  /* 显示屏实时画面（自适应）——实物 OLED 上显示什么就画什么：
     state 里有 env 就画环境监测画面（对齐固件 taskDisplay 三页），
     有 compass 就画指南针罗盘/数据页；两者都没有才提示等待。
     逻辑坐标 128x64，按 canvas 宽度自动缩放。 */
  function drawSimOLED(canvas, state, prefer, displayInfo) {
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
    var hasEnv = hasEnvData(env);
    var hasCp = hasCompassData(cp);

    if (prefer === 'compass' && hasCp) {
      drawCompassPanel(ctx, cp, displayInfo || (state && state.compassInfo) || {});
    } else if (prefer === 'env' && hasEnv) {
      drawEnvPanel(ctx, env);
    } else if (hasEnv) {
      drawEnvPanel(ctx, env);
    } else if (hasCp) {
      drawCompassPanel(ctx, cp, displayInfo || (state && state.compassInfo) || {});
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
      var box2 = null;

      function device() { return ESP.store.activeDevice(); }
      function node() { return ESP.devices.activeNode(); }

      function currentRefreshMs() {
        var ms = Number(ESP.store.settings().monitorRefreshMs || 1000);
        return ms < 100 ? 100 : ms;
      }

      // 工具栏只创建一次，避免定时重绘时替换 select 导致无法操作
      function buildToolbar() {
        var refreshSel = U.el('select.sel.sm', {});
        [[100, '0.1 秒'], [500, '0.5 秒'], [1000, '1 秒'], [2000, '2 秒'], [3000, '3 秒'], [5000, '5 秒']].forEach(function (o) {
          refreshSel.appendChild(U.el('option', { value: String(o[0]), text: o[1] }));
        });
        refreshSel.value = String(currentRefreshMs());
        refreshSel.addEventListener('change', function () {
          ESP.store.updateSettings({ monitorRefreshMs: Number(refreshSel.value) });
          ESP.ui.toast('刷新间隔已设为 ' + refreshSel.options[refreshSel.selectedIndex].text, 'ok');
          ESP.app.render();
        });

        var themeSel = U.el('select.sel.sm', {});
        [['default', '默认风格'], ['glass', '苹果玻璃风'], ['light', '白色'], ['dark', '黑色']].forEach(function (o) {
          themeSel.appendChild(U.el('option', { value: o[0], text: o[1] }));
        });
        themeSel.value = ESP.store.settings().theme || 'default';
        themeSel.addEventListener('change', function () {
          ESP.store.updateSettings({ theme: themeSel.value });
          ESP.ui.toast('主题已切换为 ' + themeSel.options[themeSel.selectedIndex].text, 'ok');
        });

        return U.el('div.card', { style: { marginBottom: '14px' } }, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '监控设置' }),
            U.el('span.hint', { text: '仅保存在本机浏览器' })
          ]),
          U.el('div.row', { style: { gap: '18px' } }, [
            U.el('div.row', { style: { gap: '8px' } }, [
              U.el('span.small.muted', { text: '数据刷新间隔（主动请求）' }), refreshSel
            ]),
            U.el('div.row', { style: { gap: '8px' } }, [
              U.el('span.small.muted', { text: '主题风格' }), themeSel
            ])
          ])
        ]);
      }

      // 自适应阈值区：节点只移动不重建，避免刷新时覆盖正在编辑的输入框
      var thresholdBox = U.el('div');
      var thresholdSig = '';

      function thresholdAll() {
        var s = ESP.store.settings();
        if (!s.metricThresholds) s.metricThresholds = {};
        return s.metricThresholds;
      }
      function thresholdGet(d, key) {
        return (thresholdAll()[d.id] || {})[key];
      }
      function thresholdSet(d, key, vals) {
        var all = thresholdAll();
        if (!all[d.id]) all[d.id] = {};
        all[d.id][key] = vals;
        ESP.store.updateSettings({ metricThresholds: all });
      }
      function thresholdDefaults(m, cfg, state) {
        var e = (state && state.env) || {};
        if (cfg.type === 'select') {
          if (m.key === 'fan_level') return { value: e.fan_auto ? 'auto' : String(e.fan_level == null ? 0 : e.fan_level) };
          return { value: String(cfg.options[0][0]) };
        }
        if (cfg.fields) {
          var out = {};
          var stateKey = { lo: 'th_lo', hi: 'th_hi', alarm: 'th_al' };
          cfg.fields.forEach(function (f) {
            var v = e[stateKey[f.key]];
            out[f.key] = (v == null || isNaN(v)) ? f.def : Number(v);
          });
          return out;
        }
        return { value: cfg.field.def };
      }
      function thresholdValues(m, cfg, d, state) {
        var saved = thresholdGet(d, m.key);
        return (saved && typeof saved === 'object') ? saved : thresholdDefaults(m, cfg, state);
      }
      function thresholdApply(m, cfg, vals) {
        var d = device();
        if (!d) return;
        thresholdSet(d, m.key, vals);
        var op = cfg.op || (cfg.opFor ? cfg.opFor(vals.value) : null);
        if (!op) {
          ESP.ui.toast(m.label + ' 阈值已保存到本机（固件暂不支持下发）', 'ok');
          return;
        }
        var args = cfg.args ? cfg.args(vals) : (cfg.argsFor ? cfg.argsFor(vals.value) : {});
        ESP.devices.invoke(d.id, op, args).then(function () {
          ESP.ui.toast(m.label + ' 已下发成功', 'ok');
          var n = ESP.devices.get(d.id);
          if (n && n.transport) n.transport.refresh();
        }).catch(function (e) {
          ESP.ui.toast(m.label + ' 下发失败：' + e.message, 'err');
        });
      }
      function buildThresholdCard(metrics, state) {
        U.clear(thresholdBox);
        var d = device();
        if (!d || !metrics.length) return;
        var grid = U.el('div.threshold-grid');
        var canPush = metrics.some(function (m) {
          var c = THRESHOLD_CONTROLS[m.key];
          return c && (c.op || c.opFor);
        });
        metrics.forEach(function (m) {
          var cfg = THRESHOLD_CONTROLS[m.key] || {
            field: { key: 'value', label: '阈值上限', def: 1, min: -1000, max: 1000, step: 1 }
          };
          var vals = thresholdValues(m, cfg, d, state);
          var item = U.el('div.threshold-item');
          item.appendChild(U.el('div.head', {}, [
            U.el('div.small', { text: m.label + (m.unit ? ' (' + m.unit + ')' : '') }),
            U.el('span.badge.ghost', { 'data-status': m.key, text: (cfg.op || cfg.opFor) ? '可下发' : '本地' })
          ]));
          item.appendChild(U.el('div.row', { style: { gap: '6px', marginTop: '4px' } }, [
            U.el('span.small.muted', { text: '当前' }),
            U.el('span.small', { 'data-cur': m.key, text: '-' })
          ]));
          var fields = U.el('div.fields');

          if (cfg.type === 'select') {
            var sel = U.el('select.sel.sm', {});
            cfg.options.forEach(function (o) {
              sel.appendChild(U.el('option', { value: String(o[0]), text: o[1] }));
            });
            sel.value = String(vals.value);
            sel.addEventListener('change', function () {
              vals.value = sel.value;
              thresholdApply(m, cfg, vals);
            });
            fields.appendChild(sel);
          } else if (cfg.fields) {
            cfg.fields.forEach(function (f) {
              var input = U.el('input', {
                type: 'number', min: f.min, max: f.max, step: f.step, value: vals[f.key], title: f.label,
                'data-field': f.key
              });
              fields.appendChild(U.el('div', {}, [
                U.el('div.small.muted', { text: f.label }), input
              ]));
            });
            fields.appendChild(U.el('button.btn.sm.primary', {
              text: '下发阈值',
              onclick: function () {
                cfg.fields.forEach(function (f) {
                  var el = fields.querySelector('[data-field="' + f.key + '"]');
                  vals[f.key] = Number(el.value);
                });
                thresholdApply(m, cfg, vals);
              }
            }));
          } else {
            var f = cfg.field;
            var input = U.el('input', {
              type: 'number', min: f.min, max: f.max, step: f.step, value: vals.value, title: f.label,
              'data-field': 'value'
            });
            fields.appendChild(input);
            fields.appendChild(U.el('button.btn.sm.primary', {
              text: '保存',
              onclick: function () { vals.value = Number(input.value); thresholdApply(m, cfg, vals); }
            }));
          }

          item.appendChild(fields);
          grid.appendChild(item);
        });
        thresholdBox.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '自适应阈值 / 档位设置' }),
            U.el('span.hint', { text: '已识别 ' + metrics.length + ' 项 · ' + (canPush ? '支持设备下发' : '本地阈值') })
          ]),
          grid
        ]));
      }
      function updateThresholdCard(metrics, state) {
        var d = device();
        if (!d) return;
        var sig = d.id + '|' + metrics.map(function (m) { return m.key; }).join(',');
        if (sig !== thresholdSig) {
          thresholdSig = sig;
          buildThresholdCard(metrics, state);
        }
        metrics.forEach(function (m) {
          var curEl = thresholdBox.querySelector('[data-cur="' + m.key + '"]');
          var stEl = thresholdBox.querySelector('[data-status="' + m.key + '"]');
          if (!curEl) return;
          var n = ESP.devices.get(d.id);
          var value = (n && n.state) ? m.get(n.state) : null;
          curEl.textContent = value == null ? '-' : Number(value).toFixed(1) + (m.unit || '');
          if (!stEl) return;
          var cfg = THRESHOLD_CONTROLS[m.key] || {};
          var vals = thresholdValues(m, cfg, d, state);
          var cls = 'ghost', txt = '无数据';
          if (value != null) {
            if (m.key === 'fan_level') {
              cls = 'blue'; txt = '档位 ' + Math.round(value);
            } else if (m.key === 'pir') {
              cls = Number(value) >= 1 ? 'amber' : 'green';
              txt = Number(value) >= 1 ? '有人' : '无人';
            } else if (cfg.fields) {
              var t = Number(value);
              if (t >= Number(vals.alarm)) { cls = 'red'; txt = '报警'; }
              else if (t >= Number(vals.hi)) { cls = 'amber'; txt = '偏高'; }
              else { cls = 'green'; txt = '正常'; }
            } else {
              cls = Number(value) >= Number(vals.value) ? 'red' : 'green';
              txt = cls === 'red' ? '超限' : '正常';
            }
          }
          stEl.className = 'badge ' + cls;
          stEl.textContent = txt;
        });
      }

      // 记录 env/compass 各自最近发生变化的时刻，用于“谁最新更新显示谁”
      var sourceSigs = { env: '', compass: '' };
      var sourceTimes = { env: 0, compass: 0 };
      var compassInfo = {};        // 由 compass.info 命令读取，状态帧里不包含 display_mode
      var lastCompassInfoAsk = 0;

      function currentDisplayInfo(state) {
        var info = {};
        if (state && state.compassInfo && typeof state.compassInfo === 'object') {
          Object.keys(state.compassInfo).forEach(function (k) { info[k] = state.compassInfo[k]; });
        }
        if (state && state.compass && state.compass.display_mode != null) info.display_mode = state.compass.display_mode;
        if (state && state.display_mode != null) info.display_mode = state.display_mode;
        Object.keys(compassInfo).forEach(function (k) { if (info[k] == null) info[k] = compassInfo[k]; });
        return info;
      }

      function loadCompassInfo(d) {
        if (!d || Date.now() - lastCompassInfoAsk < 2000) return;
        lastCompassInfoAsk = Date.now();
        ESP.devices.invoke(d.id, 'compass.info', {}).then(function (r) {
          var parsed = r;
          if (typeof r === 'string') { try { parsed = JSON.parse(r); } catch (e) { parsed = {}; } }
          if (parsed && typeof parsed === 'object' && parsed.display_mode != null) {
            compassInfo = parsed;
            draw();
          }
        }).catch(function () {});
      }

      function latestSource(state) {
        var env = (state && state.env) || null;
        var cp = (state && state.compass) || null;
        var hasEnv = hasEnvData(env);
        var hasCp = hasCompassData(cp);
        if (!hasEnv && !hasCp) return null;

        var now = Date.now();
        if (hasEnv) {
          var es = envSignature(env);
          if (es !== sourceSigs.env) { sourceSigs.env = es; sourceTimes.env = now; }
        }
        if (hasCp) {
          var cs = compassSignature(cp);
          if (cs !== sourceSigs.compass) { sourceSigs.compass = cs; sourceTimes.compass = now; }
        }
        if (!hasEnv) return 'compass';
        if (!hasCp) return 'env';
        return sourceTimes.compass >= sourceTimes.env ? 'compass' : 'env';
      }

      function draw() {
        U.clear(box);
        U.clear(box2);
        var d = device();
        if (!d) { box.appendChild(ESP.ui.noDevice('添加设备后才能看到监控数据。', '去添加设备', function () { ESP.app.navigate('devices'); })); return; }
        var n = ESP.devices.get(d.id);
        var state = n && n.state;
        var dev = (state && state.device) || {};
        var isSim = d.transport === 'sim';
        var latest = latestSource(state);  // 当前监控类别：env / compass / null
        if (state && !isSim && latest === 'compass') loadCompassInfo(d);

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

        // 显示屏实时画面 + 实时参数（全自适应：env/compass 有啥显示啥）
        if (state && !isSim) {
          var canvas = U.el('canvas.sim-oled', { width: 256, height: 128 });
          var screenWrap = U.el('div.oled-frame', {}, [canvas]);
          var env = state.env || {};
          var cp = state.compass || {};
          var hasEnv = hasEnvData(env);
          var hasCp = hasCompassData(cp);
          var f1 = function (v) { return (v == null || v === 'null' || isNaN(v)) ? '-' : Number(v).toFixed(1); };

          // 右侧参数只显示当前监控类别的字段
          var envRows = hasEnv ? [
            ['环境·温度', f1(env.temperature) + ' ℃'],
            ['环境·湿度', f1(env.humidity) + ' %RH'],
            ['环境·光照 BH1750', f1(env.lux_bh1750) + ' lx'],
            ['环境·光照 LDR', f1(env.lux_ldr) + ' lx (raw ' + (env.ldr_raw != null ? env.ldr_raw : '-') + ')'],
            ['环境·人体感应 PIR', env.pir ? '有人' : '无人'],
            ['环境·风扇', '档 ' + (env.fan_level != null ? env.fan_level : '-') + '（' + (env.fan_auto ? '自动' : '手动') + '）']
          ] : [];
          var dispInfo = currentDisplayInfo(state);
          var cpRows = hasCp ? [
            ['指南针·OLED 显示模式', Number(dispInfo.display_mode || 0) === 1 ? '数据页' : '罗盘页'],
            ['指南针·航向 HDG', cp.heading != null ? Number(cp.heading).toFixed(1) + '° ' + (cp.dir || '') : '-'],
            ['指南针·俯仰 / 横滚', (cp.pitch != null ? Number(cp.pitch).toFixed(1) : '-') + '° / ' + (cp.roll != null ? Number(cp.roll).toFixed(1) : '-') + '°'],
            ['指南针·姿态传感器', (cp.imu_ok ? 'MPU6050 正常' : '未连接') + ' · 磁力计 ' + (cp.mag_ok ? '正常' : '未连接')],
            ['指南针·校准状态', cp.calibrating ? ('校准中 ' + (cp.cal_progress || 0) + '%') : (cp.calibrated ? '已校准' : '未校准')],
            ['指南针·磁场 X/Y/Z', cp.mag ? cp.mag.join(' / ') : '-'],
            ['指南针·加速度 X/Y/Z', cp.accel ? cp.accel.join(' / ') : '-']
          ] : [];
          var liveRows = (latest === 'compass') ? cpRows : (latest === 'env' ? envRows : envRows.concat(cpRows));
          if (!liveRows.length) liveRows = [['实时参数', '等待设备上报数据']];

          var liveGrid = U.el('div.stat-grid');
          liveRows.forEach(function (r) { liveGrid.appendChild(ESP.ui.statRow(r[0], r[1])); });

          var modeText = latest === 'compass' ? '指南针数据' : (latest === 'env' ? '环境数据' : '等待数据');
          var hintText = 'SSD1306 128×64 · ' + modeText;
          if (latest) hintText += '（最新更新）';

          box.appendChild(U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: '显示屏实时画面' }), U.el('span.hint', { text: hintText })]),
            U.el('div.oled-layout', {}, [
              screenWrap,
              U.el('div', {}, [
                U.el('div.small.muted', { text: '每 ' + (currentRefreshMs() / 1000) + ' 秒请求最新数据；右侧仅显示当前监控类别参数' }),
                liveGrid
              ])
            ])
          ]));
          drawSimOLED(canvas, state, latest, dispInfo);
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
          if (latest && metricGroup(m) !== latest) return false;  // 只保留当前监控类别
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
            U.el('div.card-head', {}, [U.el('h3', { text: '实时变化曲线' }), U.el('span.hint', { text: '自动识别 ' + activeCharts.length + ' 项' + (latest ? '（' + (latest === 'env' ? '环境' : '指南针') + '）' : '') + ' · 本地缓存' })]),
            chartGrid
          ]));
        }

        // 自适应阈值：节点独立挂载，刷新时不摘除，输入框不会失焦
        thresholdBox.style.marginTop = activeCharts.length ? '14px' : '0';
        thresholdBox.style.marginBottom = '14px';
        updateThresholdCard(activeCharts, state);

        // 设备身份
        box2.appendChild(U.el('div.card', {}, [
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
          box2.appendChild(U.el('div.card', {}, [
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
          box2.appendChild(U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: 'GPIO / PWM 实时快照' }), U.el('span.hint', { text: pins.length + ' 个引脚' })]),
            wrap
          ]));
        }

        // 事件历史
        box2.appendChild(U.el('div.card', {}, [
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
        box2.appendChild(U.el('div.card', {}, [
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

      root.appendChild(buildToolbar());
      box = U.el('div');
      box2 = U.el('div');
      root.appendChild(box);
      root.appendChild(thresholdBox);
      root.appendChild(box2);
      draw();

      var refreshMs = currentRefreshMs();
      var requesting = false;
      function requestState() {
        if (requesting) return;
        var d = device();
        var n = d && ESP.devices.get(d.id);
        if (!n || !n.transport || !n.transport.refresh) return;
        requesting = true;
        try {
          var p = n.transport.refresh();
          if (p && typeof p.then === 'function') {
            p.then(function () { requesting = false; }, function () { requesting = false; });
          } else requesting = false;
        } catch (e) { requesting = false; }
      }
      ctx.onBus('device:state', U.throttle(draw, refreshMs));
      ctx.onBus('device:status', draw);
      ctx.onBus('active:changed', draw);
      ctx.onBus('log:added', U.throttle(draw, Math.max(refreshMs, 1200)));
      ctx.timer(requestState, refreshMs);
      ctx.timer(draw, refreshMs);
    }
  };
})(window);
