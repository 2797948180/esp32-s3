/* GPIO 全引脚控制
 * 引脚列表由「开发板型号」动态生成（见 assets/js/core/pinmap.js），
 * 所有切换都会向设备发送真实指令，只有在设备返回成功后才更新界面。 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  var MODE_LABEL = {
    unset: '未配置',
    input: '浮空输入',
    input_pullup: '上拉输入',
    input_pulldown: '下拉输入',
    output: '数字输出',
    pwm: 'PWM 输出'
  };

  function pinStateOf(state, gpio) {
    if (!state || !state.pins) return null;
    if (Array.isArray(state.pins)) {
      for (var i = 0; i < state.pins.length; i++) if (state.pins[i].gpio === gpio) return state.pins[i];
      return null;
    }
    return state.pins[gpio] || state.pins[String(gpio)] || null;
  }

  ESP.pages.gpio = {
    title: 'GPIO 控制',
    sub: '按开发板动态生成的全部安全可用引脚',
    render: function (root, ctx) {
      var selected = Object.create(null);
      var cards = Object.create(null);
      var gridRoot = null;
      var boardSelect = null;
      var riskToggle = null;

      function device() { return ESP.store.activeDevice(); }
      function node() { return ESP.devices.activeNode(); }

      function boardId() {
        var d = device();
        return (d && d.board) || ESP.store.settings().defaultBoard;
      }

      function listPins() {
        var bid = boardId();
        var showRisk = riskToggle ? riskToggle.checked : ESP.store.settings().showRiskPins;
        var table = ESP.pins.buildTable(bid);
        if (!showRisk) table = table.filter(function (p) { return p.level !== 'warn'; });
        return table.filter(function (p) { return p.level !== 'unsafe'; });
      }

      /* --------------------------- 命令封装 --------------------------- */
      function runOp(op, args, label) {
        var d = device();
        if (!d) { ESP.ui.toast('请先选择设备', 'err'); return Promise.resolve(); }
        return ESP.devices.invoke(d.id, op, args).then(function (r) {
          if (label) ESP.ui.toast(label, 'ok', 1400);
          sync();
          return r;
        }).catch(function (e) {
          ESP.ui.toast((label ? label + '失败：' : '') + e.message, 'err', 5000);
          sync();
        });
      }

      function setMode(gpio, mode) {
        var ps = currentState(gpio);
        if (ps && ps.mode === 'pwm' && mode !== 'pwm') {
          ESP.ui.confirm('切换引脚模式', 'GPIO' + gpio + ' 当前是 PWM 输出，切换后会立即停止 PWM 输出。是否继续？', '继续切换')
            .then(function (ok) { if (ok) doSetMode(gpio, mode); });
          return;
        }
        doSetMode(gpio, mode);
      }

      function doSetMode(gpio, mode) {
        runOp('gpio.set_mode', { gpio: gpio, mode: mode }, 'GPIO' + gpio + ' → ' + MODE_LABEL[mode]);
      }

      function writePin(gpio, value) {
        runOp('gpio.write', { gpio: gpio, value: value ? 1 : 0 });
      }

      /* --------------------------- 引脚卡片 --------------------------- */
      function buildCard(pin, bundle) {
        var card = U.el('div.pin-card', { dataset: { gpio: pin.gpio } });
        var ref = { card: card, pin: pin };

        // 顶部
        var chk = U.el('input', { type: 'checkbox', 'aria-label': '选择 GPIO' + pin.gpio });
        chk.addEventListener('change', function () {
          if (chk.checked) selected[pin.gpio] = true; else delete selected[pin.gpio];
          updateBatchBar();
        });
        ref.check = chk;
        var head = U.el('div.pin-top', {}, [
          U.el('span', { style: { display: 'inline-flex' } }, [chk]),
          U.el('div', {}, [
            U.el('div.pin-num', { text: 'GPIO ' + pin.gpio }),
            U.el('div.pin-sub', { text: (pin.adc ? pin.adc + ' · ' : '') + (pin.level === 'warn' ? '风险引脚' : '可用引脚') })
          ]),
          U.el('span.right.badge.ghost.pin-badge', { text: MODE_LABEL.unset })
        ]);
        card.appendChild(head);

        // 模式选择
        var sel = U.el('select.pin-mode', { 'aria-label': 'GPIO' + pin.gpio + ' 模式' }, [
          U.el('option', { value: 'unset', text: MODE_LABEL.unset }),
          U.el('option', { value: 'input', text: MODE_LABEL.input }),
          U.el('option', { value: 'input_pullup', text: MODE_LABEL.input_pullup }),
          U.el('option', { value: 'input_pulldown', text: MODE_LABEL.input_pulldown }),
          U.el('option', { value: 'output', text: MODE_LABEL.output }),
          U.el('option', { value: 'pwm', text: MODE_LABEL.pwm })
        ]);
        sel.addEventListener('change', function () { setMode(pin.gpio, sel.value); });
        ref.mode = sel;
        card.appendChild(sel);

        // 数值区
        var levelBox = U.el('div.pin-body');
        card.appendChild(levelBox);
        ref.body = levelBox;

        // 操作按钮
        var actions = U.el('div.pin-actions');
        card.appendChild(actions);
        ref.actions = actions;

        // 风险提示
        if (pin.level === 'warn') {
          card.classList.add('risk');
          card.appendChild(U.el('div.conflict', { text: '⚠ ' + pin.reason }));
        }
        if (pin.adcNote) card.appendChild(U.el('div.small.muted', { style: { marginTop: '6px' } }, [document.createTextNode(pin.adcNote)]));

        return ref;
      }

      function currentState(gpio) {
        var n = node();
        if (!n || !n.state) return null;
        return pinStateOf(n.state, gpio);
      }

      function rebuildBody(ref) {
        var ps = currentState(ref.pin.gpio);
        var mode = (ps && ps.mode) || 'unset';
        U.clear(ref.body);
        U.clear(ref.actions);

        if (mode === 'output') {
          var swBox = U.el('span.switch', {});
          var sw = U.el('input', { type: 'checkbox', 'aria-label': 'GPIO' + ref.pin.gpio + ' 输出' });
          var track = U.el('span.track');
          swBox.appendChild(sw); swBox.appendChild(track);
          sw.addEventListener('change', function () { writePin(ref.pin.gpio, sw.checked ? 1 : 0); });
          ref.body.appendChild(U.el('div.pin-top', {}, [
            U.el('div.pin-level.' + (ps.level ? 'v1' : 'v0'), {}, [
              document.createTextNode(ps.level ? '高电平' : '低电平'),
              U.el('small', { text: ' · ' + ps.level })
            ]),
            U.el('span.right', {}, [swBox])
          ]));
          ref.sw = sw;
          ref.actions = U.append(ref.actions, [
            U.el('button.btn.sm.primary', { text: '置高', onclick: function () { writePin(ref.pin.gpio, 1); } }),
            U.el('button.btn.sm', { text: '置低', onclick: function () { writePin(ref.pin.gpio, 0); } }),
            U.el('button.btn.sm', { text: '翻转', onclick: function () { writePin(ref.pin.gpio, ps.level ? 0 : 1); } })
          ]);
        } else if (mode === 'pwm') {
          var pwm = ps.pwm || {};
          ref.body.appendChild(U.el('div.pin-level.v1', {}, [
            document.createTextNode((pwm.duty_percent != null ? pwm.duty_percent : 0) + '%'),
            U.el('small', { text: ' · ' + (pwm.frequency || '-') + ' Hz · ' + (pwm.resolution_bits || '-') + ' bit' })
          ]));
          ref.body.appendChild(U.el('div.meter', {}, U.el('i', { style: { width: (pwm.duty_percent || 0) + '%' } })));
          ref.body.appendChild(U.el('div.small.muted', { style: { marginTop: '6px' } }, [document.createTextNode('原始占空比 ' + (pwm.duty_raw != null ? pwm.duty_raw : '-') + ' / ' + (pwm.resolution_bits ? (Math.pow(2, pwm.resolution_bits) - 1) : '-'))]));
          ref.actions = U.append(ref.actions, [
            U.el('button.btn.sm', { text: '打开 PWM 控制', onclick: function () { ESP.app.navigate('pwm'); } }),
            U.el('button.btn.sm', { text: pwm.enabled === false ? '启用 PWM' : '停止输出(占空比0)', onclick: function () { runOp('gpio.set_pwm', { gpio: ref.pin.gpio, duty_percent: 0, enabled: false }); } })
          ]);
        } else if (mode === 'input' || mode === 'input_pullup' || mode === 'input_pulldown') {
          ref.body.appendChild(U.el('div.pin-level.' + (ps.level ? 'v1' : 'v0'), {}, [
            document.createTextNode(ps.level ? '读取到高电平' : '读取到低电平'),
            U.el('small', { text: ' · ' + ps.level })
          ]));
          ref.actions = U.append(ref.actions, [
            U.el('button.btn.sm', { text: '立即读一次', onclick: function () { readOnce(ref.pin.gpio); } })
          ]);
          ref.level = ref.body.querySelector('.pin-level');
        } else {
          ref.body.appendChild(U.el('div.pin-level.v0', {}, [document.createTextNode('未配置')]));
          ref.actions = U.append(ref.actions, [
            U.el('button.btn.sm.primary', { text: '设为输出', onclick: function () { doSetMode(ref.pin.gpio, 'output'); } }),
            U.el('button.btn.sm', { text: '设为上拉输入', onclick: function () { doSetMode(ref.pin.gpio, 'input_pullup'); } }),
            U.el('button.btn.sm', { text: '设为 PWM', onclick: function () { doSetMode(ref.pin.gpio, 'pwm'); } })
          ]);
        }
      }

      function readOnce(gpio) {
        var d = device();
        if (!d) return;
        ESP.devices.invoke(d.id, 'state', {}).then(function (r) {
          if (r && r.state) sync();
        }).catch(function (e) { ESP.ui.toast('读取失败：' + e.message, 'err'); });
      }

      /* --------------------------- 局部刷新 --------------------------- */
      function sync() {
        var list = listPins();
        if (!gridRoot) return;
        Object.keys(cards).forEach(function (g) { if (!isSelected(Number(g))) cards[g] = null; });
        // 重新构建（引脚集合变化时才重建）
        renderGrid(list);
        // 更新每个卡片
        list.forEach(function (pin) {
          var ref = cards[pin.gpio];
          if (!ref) return;
          var ps = currentState(pin.gpio);
          var mode = (ps && ps.mode) || 'unset';
          if (ref.renderedMode !== mode) {
            ref.renderedMode = mode;
            rebuildBody(ref);
          } else if (mode === 'input' || mode === 'input_pullup' || mode === 'input_pulldown') {
            patchInputLevel(ref, ps);
          } else if (mode === 'output') {
            patchOutputLevel(ref, ps);
          } else if (mode === 'pwm') {
            rebuildBody(ref);
          }
          if (ref.mode && document.activeElement !== ref.mode) ref.mode.value = mode;
          var badge = ref.card.querySelector('.pin-badge');
          if (badge) {
            badge.textContent = MODE_LABEL[mode] || mode;
            badge.className = 'right badge pin-badge ' + (mode === 'output' ? 'blue' : mode === 'pwm' ? 'purple' : mode === 'unset' ? 'ghost' : 'green');
          }
          ref.card.classList.toggle('high', !!(ps && ps.level));
          ref.card.classList.toggle('selected', !!selected[pin.gpio]);
        });
        updateBatchBar();
        updateHeader();
      }

      function isSelected(gpio) {
        return listPins().some(function (p) { return p.gpio === gpio; });
      }

      function patchInputLevel(ref, ps) {
        if (!ps || !ref.level) return;
        ref.level.className = 'pin-level ' + (ps.level ? 'v1' : 'v0');
        ref.level.textContent = ps.level ? '读取到高电平' : '读取到低电平';
        ref.level.appendChild(U.el('small', { text: ' · ' + ps.level }));
      }

      function patchOutputLevel(ref, ps) {
        if (!ps) return;
        var lv = ref.body.querySelector('.pin-level');
        if (lv) {
          lv.className = 'pin-level ' + (ps.level ? 'v1' : 'v0');
          lv.textContent = ps.level ? '高电平' : '低电平';
          lv.appendChild(U.el('small', { text: ' · ' + ps.level }));
        }
        if (ref.sw && document.activeElement !== ref.sw) ref.sw.checked = !!ps.level;
      }

      /* --------------------------- 批量操作 --------------------------- */
      var batchBar = null;
      function updateBatchBar() {
        if (!batchBar) return;
        var keys = Object.keys(selected);
        U.clear(batchBar);
        if (!keys.length) {
          batchBar.appendChild(U.el('span.small.muted', { text: '勾选引脚后可进行批量操作。' }));
          return;
        }
        batchBar.appendChild(U.el('span.small', { text: '已选 ' + keys.length + ' 个引脚：' + keys.map(function (g) { return 'GPIO' + g; }).join('、') }));
        var ops = [
          ['设为输出', 'output'], ['设为上拉输入', 'input_pullup'], ['设为浮空输入', 'input'], ['释放引脚', 'unset']
        ];
        ops.forEach(function (o) {
          batchBar.appendChild(U.el('button.btn.sm', {
            text: o[0], onclick: function () { batchMode(o[1]); }
          }));
        });
        batchBar.appendChild(U.el('button.btn.sm.primary', { text: '全部置高', onclick: function () { batchWrite(1); } }));
        batchBar.appendChild(U.el('button.btn.sm', { text: '全部置低', onclick: function () { batchWrite(0); } }));
        batchBar.appendChild(U.el('button.btn.sm.ghost', { text: '清空选择', onclick: function () { selected = Object.create(null); sync(); } }));
      }

      function batchMode(mode) {
        var keys = Object.keys(selected).map(Number);
        if (!keys.length) return;
        runOp('gpio.batch', {
          commands: keys.map(function (g) { return { op: 'gpio.set_mode', args: { gpio: g, mode: mode } }; })
        }, '批量设置 ' + keys.length + ' 个引脚为 ' + MODE_LABEL[mode]);
      }

      function batchWrite(value) {
        var keys = Object.keys(selected).map(Number);
        if (!keys.length) return;
        runOp('gpio.batch', {
          commands: keys.map(function (g) { return { op: 'gpio.write', args: { gpio: g, value: value } }; })
        }, '批量置' + (value ? '高' : '低') + ' ' + keys.length + ' 个引脚');
      }

      /* --------------------------- 渲染 --------------------------- */
      var headerInfo = null;
      function updateHeader() {
        if (!headerInfo) return;
        var d = device(), n = node();
        U.clear(headerInfo);
        if (!d) { headerInfo.appendChild(U.el('span.small.muted', { text: '未选择设备' })); return; }
        var isSim = d.transport === 'sim';
        headerInfo.appendChild(U.el('span.badge.' + (isSim ? 'purple' : (n && n.online ? 'green' : 'ghost')), { text: isSim ? '模拟设备' : (n && n.online ? '在线 · ' + n.source : '离线') }));
        headerInfo.appendChild(U.el('span.small.muted', { text: ' ' + d.name }));
        if (n && n.lastSeen) headerInfo.appendChild(U.el('span.small.muted', { text: ' · 最后通信 ' + U.ago(n.lastSeen) }));
        if (n && n.schema === 'legacy') headerInfo.appendChild(U.el('span.badge.amber', { text: '旧固件（仅白名单引脚可用）' }));
      }

      function renderGrid(list) {
        if (!gridRoot) return;
        // 若引脚集合没变，跳过重建，避免打断用户操作
        var sig = list.map(function (p) { return p.gpio; }).join(',');
        if (gridRoot.dataset.sig === sig) return;
        gridRoot.dataset.sig = sig;
        U.clear(gridRoot);
        cards = Object.create(null);
        list.forEach(function (pin) {
          var ref = buildCard(pin);
          cards[pin.gpio] = ref;
          gridRoot.appendChild(ref.card);
        });
      }

      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [
          U.el('h3', { text: 'GPIO 引脚总览' }),
          headerInfo = U.el('span.right.row.small', {}),
          U.el('div.row', { style: { width: '100%', marginTop: '4px' } }, [
            U.el('div', { style: { minWidth: '240px', flex: '1 1 auto' } }, [
              U.el('label', { style: { display: 'block', fontSize: '11.5px', color: '#91a0ba', marginBottom: '4px' } }, [document.createTextNode('开发板型号（决定开放哪些引脚）')]),
              boardSelect = U.el('select', {}, ESP.pins.BOARDS.map(function (b) {
                return U.el('option', { value: b.id, text: b.name, selected: b.id === boardId() });
              }))
            ]),
            U.el('div.row', { style: { gap: '8px', alignItems: 'flex-end' } }, [
              U.el('div', {}, [
                U.el('label', { style: { display: 'block', fontSize: '11.5px', color: '#91a0ba', marginBottom: '4px' } }, [document.createTextNode('风险引脚')]),
                U.el('span.row', {}, [
                  riskToggle = U.el('span.switch.sm', {}, [
                    (function () {
                      var cb = U.el('input', { type: 'checkbox' });
                      cb.checked = !!ESP.store.settings().showRiskPins;
                      return cb;
                    })(),
                    U.el('span.track')
                  ]),
                  U.el('span.small.muted', { text: '显示' })
                ])
              ]),
              U.el('button.btn.sm', { text: '刷新状态', onclick: function () { readOnce(); } })
            ])
          ])
        ]),
        batchBar = U.el('div.row', { style: { padding: '8px 10px', background: '#131d31', border: '1px solid #26324a', borderRadius: '10px', marginBottom: '12px' } }),
        gridRoot = U.el('div.grid.pin-grid')
      ]));

      boardSelect.addEventListener('change', function () {
        var d = device();
        if (!d) { ESP.ui.toast('请先选择设备后再切换板型', 'warn'); return; }
        ESP.store.updateDevice(d.id, { board: boardSelect.value });
        gridRoot.dataset.sig = '';
        sync();
      });
      riskToggle.querySelector('input').addEventListener('change', function () {
        ESP.store.updateSettings({ showRiskPins: riskToggle.querySelector('input').checked });
        gridRoot.dataset.sig = '';
        sync();
      });

      // 使用新一轮：切换设备后强制重建
      function rebuild() { if (gridRoot) gridRoot.dataset.sig = ''; sync(); }

      rebuild();

      ctx.onBus('device:state', function (e) {
        var n = node();
        if (n && e.deviceId !== n.record.id) return;
        throttledSync();
      });
      ctx.onBus('active:changed', rebuild);
      ctx.onBus('devices:changed', rebuild);
      var throttledSync = U.throttle(sync, 250);
      ctx.timer(function () { throttledSync(); }, 2500);
    }
  };
})(window);
