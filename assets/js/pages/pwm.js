/* PWM 控制：每路独立开关 / 频率 / 占空比 / 分辨率 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  function pinStateOf(state, gpio) {
    if (!state || !state.pins) return null;
    if (Array.isArray(state.pins)) {
      for (var i = 0; i < state.pins.length; i++) if (state.pins[i].gpio === gpio) return state.pins[i];
      return null;
    }
    return state.pins[gpio] || state.pins[String(gpio)] || null;
  }

  /* ESP32-S3 LEDC 频率/分辨率关系参考（源自 Espressif 文档经验值）：
   * 分辨率越高，可用最高频率越低。此处仅用于前端提示，最终以 ledcChangeFrequency 是否成功为准。 */
  function maxFreqForBits(bits) {
    var approx = { 1: 40000000, 8: 20000000, 10: 5000000, 12: 1250000, 14: 312500 };
    return approx[bits] || 40000000;
  }

  ESP.pages.pwm = {
    title: 'PWM 控制',
    sub: '每个支持 PWM 的引脚独立设置频率、占空比与分辨率',
    render: function (root, ctx) {
      var grid = null;
      var head = null;
      var simBanner = null;

      function device() { return ESP.store.activeDevice(); }
      function node() { return ESP.devices.activeNode(); }

      function eligiblePins() {
        var d = device();
        var bid = (d && d.board) || ESP.store.settings().defaultBoard;
        var showRisk = ESP.store.settings().showRiskPins;
        return ESP.pins.buildTable(bid).filter(function (p) {
          if (p.level === 'unsafe') return false;
          if (p.level === 'warn' && !showRisk) return false;
          return p.caps.indexOf('pwm') >= 0;
        });
      }

      function apply(gpio, payload, label) {
        var d = device();
        if (!d) { ESP.ui.toast('请先选择设备', 'err'); return Promise.resolve(); }
        return ESP.devices.invoke(d.id, 'gpio.set_pwm', payload)
          .then(function () { ESP.ui.toast(label, 'ok', 1200); sync(); })
          .catch(function (e) { ESP.ui.toast('设置失败：' + e.message, 'err', 5200); sync(); });
      }

      function ensurePwmMode(gpio, next) {
        var ps = pinStateOf(node() && node().state, gpio);
        if (!ps || ps.mode === 'pwm') return next();
        ESP.devices.invoke(device().id, 'gpio.set_mode', { gpio: gpio, mode: 'pwm' })
          .then(function () { next(); sync(); })
          .catch(function (e) { ESP.ui.toast('无法切换到 PWM 模式：' + e.message, 'err'); });
      }

      function buildCard(pin, ref) {
        var card = U.el('div.pin-card');
        if (pin.level === 'warn') card.classList.add('risk');

        card.appendChild(U.el('div.pin-top', {}, [
          U.el('div', {}, [
            U.el('div.pin-num', { text: 'GPIO ' + pin.gpio }),
            U.el('div.pin-sub', { text: pin.level === 'warn' ? '风险引脚' : 'LED/PWM 可用' })
          ]),
          U.el('span.right.badge.ghost.ref-badge', { text: '未启用' })
        ]));

        // 分辨率
        var resSel = U.el('select', {}, [1, 8, 10, 12, 14].map(function (b) {
          return U.el('option', { value: b, text: b + ' bit（最大占空比 ' + (Math.pow(2, b) - 1) + '）' });
        }));
        card.appendChild(U.el('div', { style: { marginTop: '8px' } }, [
          U.el('div.small.muted', { text: '分辨率' }), resSel
        ]));

        // 频率
        var freq = U.el('input', { type: 'number', min: 10, max: 80000000, step: 10, value: 1000 });
        card.appendChild(U.el('div', { style: { marginTop: '8px' } }, [
          U.el('div.small.muted', { text: '频率 (Hz)' }), freq
        ]));

        // 占空比滑块 + 数值
        var range = U.el('input', { type: 'range', min: 0, max: 100, step: 0.1, value: 0 });
        var num = U.el('input.num', { type: 'number', min: 0, max: 100, step: 1, value: 0 });
        card.appendChild(U.el('div', { style: { marginTop: '8px' } }, [
          U.el('div.small.muted', { text: '占空比 (%)' }),
          U.el('div.row', {}, [range, num])
        ]));

        // 数值展示
        var big = U.el('div.pin-level.v0', { text: '0%' });
        card.appendChild(U.el('div.pin-body', {}, [
          big,
          U.el('div.meter', {}, [U.el('i', { style: { width: '0%' } })]),
          U.el('div.small.muted.ref-raw', { style: { marginTop: '6px' }, text: '原始占空比 0 / 1023' }),
          U.el('div.conflict.ref-warn.hide', { style: { marginTop: '6px' } })
        ]));

        // 按钮
        var enableBtn = U.el('button.btn.sm.primary', { text: '启用 PWM' });
        var offBtn = U.el('button.btn.sm', { text: '占空比归零' });
        var applyBtn = U.el('button.btn.sm', { text: '应用参数' });
        card.appendChild(U.el('div.pin-actions', {}, [enableBtn, applyBtn, offBtn]));

        ref.res = resSel; ref.freq = freq; ref.range = range; ref.num = num;
        ref.big = big; ref.raw = card.querySelector('.ref-raw');
        ref.warn = card.querySelector('.ref-warn'); ref.badge = card.querySelector('.ref-badge');
        ref.meter = card.querySelector('.meter > i');

        function current() {
          var bits = Number(resSel.value) || 10;
          return {
            bits: bits,
            freq: Math.max(10, Number(freq.value) || 1000),
            duty: U.clamp(Number(range.value) || 0, 0, 100)
          };
        }

        function send(extra, label) {
          var c = current();
          var payload = Object.assign({
            gpio: pin.gpio,
            frequency: c.freq,
            duty_percent: c.duty,
            resolution_bits: c.bits
          }, extra || {});
          ensurePwmMode(pin.gpio, function () { apply(pin.gpio, payload, label || ('GPIO' + pin.gpio + ' PWM ' + c.duty + '%')); });
        }

        enableBtn.onclick = function () { send({ enabled: true }, 'GPIO' + pin.gpio + ' PWM 已启用'); };
        applyBtn.onclick = function () { send({ enabled: true }, 'GPIO' + pin.gpio + ' 参数已下发'); };
        offBtn.onclick = function () { send({ duty_percent: 0, enabled: false }, 'GPIO' + pin.gpio + ' PWM 输出已停止'); };

        range.addEventListener('input', function () { num.value = Math.round(range.value * 10) / 10; updatePreview(); });
        num.addEventListener('change', function () {
          var v = U.clamp(Number(num.value) || 0, 0, 100);
          num.value = range.value = v;
          updatePreview();
        });
        resSel.addEventListener('change', updatePreview);
        freq.addEventListener('change', updatePreview);

        function updatePreview() {
          var c = current();
          big.className = 'pin-level ' + (c.duty > 0 ? 'v1' : 'v0');
          big.textContent = (Math.round(c.duty * 10) / 10) + '%';
          ref.meter.style.width = c.duty + '%';
          ref.raw.textContent = '原始占空比 ' + Math.round(c.duty / 100 * (Math.pow(2, c.bits) - 1)) + ' / ' + (Math.pow(2, c.bits) - 1);
          var mf = maxFreqForBits(c.bits);
          if (c.freq > mf) {
            ref.warn.textContent = '⚠ ' + c.bits + ' bit 分辨率下建议频率 ≤ ' + mf.toLocaleString() + ' Hz，超出后固件会自动选择相近值或直接失败。';
            ref.warn.classList.remove('hide');
          } else ref.warn.classList.add('hide');
        }
        ref.updatePreview = updatePreview;
        ref.current = current;
        updatePreview();
        return card;
      }

      var refs = Object.create(null);

      function sync() {
        if (!grid) return;
        U.clear(head);
        var d = device(), n = node();
        if (!d) {
          head.appendChild(U.el('div.empty', { text: '请先在右上角选择一台设备。' }));
          if (simBanner) simBanner.classList.add('hide');
          return;
        }
        var isSim = d.transport === 'sim';
        if (simBanner) {
          simBanner.classList.toggle('hide', !isSim);
        }
        head.appendChild(U.el('span.badge.' + (isSim ? 'purple' : (n && n.online ? 'green' : 'ghost')), {
          text: isSim ? '模拟设备 · 无真实 PWM 输出' : (n && n.online ? '在线 · ' + n.source : '离线')
        }));
        head.appendChild(U.el('span.small.muted', { text: ' ' + d.name + ' · ' + ((ESP.pins.boardById(d.board) || {}).name || '-') }));

        var pins = eligiblePins();
        var usedCount = 0;
        eligiblePins().forEach(function (p) {
          var ps = pinStateOf(n && n.state, p.gpio);
          if (ps && ps.mode === 'pwm') usedCount++;
        });
        head.appendChild(U.el('span.badge.' + (usedCount >= ESP.pins.CHIP.pwmChannels ? 'amber' : 'blue'), {
          text: 'PWM 通道占用 ' + usedCount + '/' + ESP.pins.CHIP.pwmChannels
        }));

        // 更新每个卡片
        pins.forEach(function (pin) {
          var ref = refs[pin.gpio];
          if (!ref) return;
          var ps = pinStateOf(n && n.state, pin.gpio);
          if (ps && ps.pwm) {
            if (document.activeElement !== ref.freq) ref.freq.value = ps.pwm.frequency || 1000;
            if (document.activeElement !== ref.res) ref.res.value = ps.pwm.resolution_bits || 10;
            if (document.activeElement !== ref.range && document.activeElement !== ref.num) {
              ref.range.value = ps.pwm.duty_percent || 0;
              ref.num.value = ps.pwm.duty_percent || 0;
            }
            ref.updatePreview();
            var on = ps.mode === 'pwm' && (ps.pwm.duty_percent || 0) > 0;
            ref.badge.className = 'right badge ref-badge ' + (on ? 'purple' : 'ghost');
            ref.badge.textContent = ps.mode === 'pwm' ? (on ? 'PWM 输出中' : 'PWM 待输出') : '未启用';
          } else if (ps && ps.mode !== 'pwm') {
            ref.badge.className = 'right badge ref-badge ghost';
            ref.badge.textContent = '当前为' + ({ output: '数字输出', input: '输入', input_pullup: '上拉输入', input_pulldown: '下拉输入', unset: '未配置' }[ps.mode] || ps.mode);
          }
        });
      }

      root.appendChild(U.el('div.card', {}, [
        simBanner = U.el('div.banner.sim.hide', { style: { marginBottom: '0' } }, [
          U.el('div', { html: '<b>模拟模式：</b>下面的数值不会作用于任何真实引脚。' })
        ]),
        U.el('div.card-head', {}, [
          U.el('h3', { text: 'PWM 输出' }),
          head = U.el('span.right.row.small', {}),
          U.el('div.row', { style: { width: '100%', marginTop: '6px' } }, [
            U.el('span.small.muted', { text: 'ESP32-S3 的 LEDC 共有 ' + ESP.pins.CHIP.pwmChannels + ' 个通道，同一个通道上频率共享；本项目使用 Arduino-ESP32 3.x 的 ledcAttach/ledcWrite 按引脚自动分配通道。' })
          ])
        ]),
        grid = U.el('div.grid.pin-grid')
      ]));

      // 构建卡片
      eligiblePins().forEach(function (pin) {
        var ref = {};
        refs[pin.gpio] = ref;
        grid.appendChild(buildCard(pin, ref));
      });

      sync();
      ctx.onBus('device:state', U.throttle(sync, 300));
      ctx.onBus('active:changed', function () { root.innerHTML = ''; ESP.app.renderPage(); });
      ctx.timer(U.throttle(sync, 1000), 1000);
    }
  };
})(window);
