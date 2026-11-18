/* 引脚电压检测：选择 ADC 引脚，读取 ESP32-S3 片内 ADC 电压 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  // ESP32-S3 ADC1 通道、空闲且安全的引脚（与固件 gpio.read_voltage 白名单一致）
  var ADC_PINS = [
    { gpio: 1, ch: 'ADC1_CH0' }, { gpio: 2, ch: 'ADC1_CH1' },
    { gpio: 7, ch: 'ADC1_CH6' }, { gpio: 8, ch: 'ADC1_CH7' },
    { gpio: 9, ch: 'ADC1_CH8' }, { gpio: 10, ch: 'ADC1_CH9' }
  ];

  ESP.pages.voltage = {
    title: '电压检测',
    sub: '读取 ESP32-S3 ADC 引脚电压（0–3.3V）',
    render: function (root, ctx) {
      var box = U.el('div');
      root.appendChild(box);

      function device() { return ESP.store.activeDevice(); }

      function draw() {
        U.clear(box);
        var d = device();
        if (!d) { box.appendChild(ESP.ui.noDevice('请先添加一台设备。', '去添加设备', function () { ESP.app.navigate('devices'); })); return; }
        if (d.transport === 'sim') {
          box.appendChild(U.el('div.banner.sim', {}, [U.el('div', { html: '<b>模拟设备：</b>ADC 电压检测需要真实硬件，模拟器不产生电压数据。' })]));
          return;
        }

        var sel = U.el('select', {}, ADC_PINS.map(function (p) {
          return U.el('option', { value: p.gpio, text: 'GPIO' + p.gpio + '（' + p.ch + '）' });
        }));
        var samples = U.el('input', { type: 'number', min: 1, max: 64, step: 1, value: 16 });
        var result = U.el('div');
        var reading = null;

        function renderResult() {
          U.clear(result);
          if (!reading) { result.appendChild(U.el('div.empty', { text: '选择引脚后点击「读取电压」。' })); return; }
          result.appendChild(U.el('div.grid.kpi-md', {}, [
            U.el('div.card.kpi.ok', {}, [
              U.el('div.label', { text: '电压' }),
              U.el('div.value', {}, U.el('span', { style: { fontSize: '26px' }, text: Number(reading.voltage).toFixed(3) + ' V' })),
              U.el('div.foot', { text: 'GPIO' + reading.gpio + ' · 满量程 3.3V' })
            ]),
            U.el('div.card.kpi', {}, [
              U.el('div.label', { text: 'ADC 原始值' }),
              U.el('div.value', {}, U.el('span', { style: { fontSize: '22px' }, text: String(reading.raw) })),
              U.el('div.foot', { text: '12 位 · 0–4095 · 采样 ' + reading.samples + ' 次' })
            ]),
            U.el('div.card.kpi', {}, [
              U.el('div.label', { text: '占满量程' }),
              U.el('div.value', {}, U.el('span', { style: { fontSize: '22px' }, text: (reading.raw / 4095 * 100).toFixed(1) + ' %' })),
              U.el('div.foot', { text: '仅供估算，非精密测量' })
            ])
          ]));
        }

        var readBtn = U.el('button.btn.primary', {
          text: '读取电压',
          onclick: function () {
            var gpio = Number(sel.value);
            var n = parseInt(samples.value, 10) || 16;
            readBtn.disabled = true;
            ESP.devices.invoke(d.id, 'gpio.read_voltage', { gpio: gpio, samples: n }).then(function (r) {
              reading = (r && r.result) || r;
              renderResult();
              ESP.ui.toast('GPIO' + gpio + ' = ' + Number(reading.voltage).toFixed(3) + ' V', 'ok');
            }).catch(function (e) {
              U.clear(result);
              result.appendChild(U.el('div.banner.err', {}, [U.el('div', { text: '读取失败：' + e.message })]));
            }).then(function () { readBtn.disabled = false; });
          }
        });

        box.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [U.el('h3', { text: 'ADC 引脚电压检测' }), U.el('span.hint', { text: '当前设备：' + d.name })]),
          U.el('div.banner.info', {}, [U.el('div', { html: 'ESP32-S3 片内 ADC（12 位，衰减 11dB，量程约 0–3.3V）。<b>仅支持 ADC1 引脚</b>，且需为数字高/模拟信号；固定占用引脚（I2C/按键/串口）不可测。输入电压<b>切勿超过 3.3V</b>，否则会损坏芯片。' })]),
          U.el('div.row', { style: { gap: '10px', marginTop: '12px' } }, [
            U.el('label', { text: '引脚：' }), sel,
            U.el('label', { text: '采样次数：' }), samples,
            readBtn
          ]),
          U.el('div', { style: { marginTop: '14px' } }, [result])
        ]));

        box.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [U.el('h3', { text: '可用 ADC1 引脚' })]),
          U.el('div.small.muted', { text: '以下引脚未占用且具备 ADC1 通道；GPIO8/9/10 若接了指南针/按键请避开实际接线。' }),
          U.el('div', { style: { marginTop: '8px' } }, ADC_PINS.map(function (p) {
            return U.el('span.badge.blue', { text: 'GPIO' + p.gpio + ' · ' + p.ch, style: { marginRight: '6px', display: 'inline-block', marginBottom: '6px' } });
          }))
        ]));

        renderResult();
      }

      draw();
      ctx.onBus('active:changed', draw);
      ctx.onBus('device:status', U.throttle(draw, 1500));
    }
  };
})(window);
