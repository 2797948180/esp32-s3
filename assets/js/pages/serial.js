/* 串口工具：连接 ESP32-S3 的 USB 串口，读取日志/IP/MAC，下发 Wi-Fi 配网与设备指令 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  ESP.pages.serial = {
    title: '串口工具',
    sub: '通过 USB 读取设备信息并为设备配网',
    render: function (root, ctx) {
      var session = ESP.serialSession;
      var term = null;
      var autoScroll = true;
      var infoBox = null;

      function supported() { return ESP.serial.supported(); }

      /* ------------------------------ 终端渲染 ------------------------------ */
      function renderTerminal() {
        if (!term) return;
        U.clear(term);
        var lines = session.lines.slice(-600);
        lines.forEach(function (l) {
          term.appendChild(U.el('span.line-' + l.dir, {}, [document.createTextNode(
            (l.dir === 'rx' ? '' : l.dir === 'tx' ? '» ' : '· ') + l.text
          )]));
          term.appendChild(document.createTextNode('\n'));
        });
        if (autoScroll) term.scrollTop = term.scrollHeight;
      }

      function log(cls, text) { session.push(cls, text); renderTerminal(); }

      /* ------------------------------ 信息面板 ------------------------------ */
      function renderInfo() {
        if (!infoBox) return;
        U.clear(infoBox);
        var p = session.parsed;
        var rows = [
          ['IP 地址', p.ip || '未识别'],
          ['热点 IP', p.apIp || '未识别'],
          ['MAC 地址', p.mac || '未识别'],
          ['芯片型号', p.chip || '未识别'],
          ['固件版本', p.firmware || '未识别'],
          ['设备 ID', p.deviceId || '未识别'],
          ['Wi-Fi 名称', p.ssid || '未识别'],
          ['工作模式', p.mode || '未识别']
        ];
        rows.forEach(function (r) { infoBox.appendChild(ESP.ui.statRow(r[0], r[1])); });

        var ip = p.ip || p.apIp;
        if (ip) {
          infoBox.appendChild(U.el('div.row', { style: { marginTop: '11px' } }, [
            U.el('button.btn.primary.sm', {
              text: '探测 ' + ip + ' 并添加设备',
              onclick: function () { probeAndAdd(ip); }
            }),
            U.el('button.btn.sm', {
              text: '仅登记 IP',
              onclick: function () { addByIp(ip, false); }
            })
          ]));
        } else {
          infoBox.appendChild(U.el('div.small.muted', { style: { marginTop: '10px' } }, [
            document.createTextNode('尚未从日志中识别到 IP。可发送 AT+INFO 主动查询，或按键 RESET 让设备重新打印开机信息。')
          ]));
        }
      }

      function probeAndAdd(ip) {
        log('sys', '正在探测 http://' + ip + ' …');
        ESP.serial.probe(ip, 3000).then(function (info) {
          log('ok', '探测成功：' + JSON.stringify(info));
          addByIp(ip, true, info);
        }).catch(function (e) {
          log('err', '探测失败：' + e.message);
          ESP.ui.toast('HTTP 探测失败，可能本机与设备不在同一网段；仍可直接登记 IP。', 'warn', 5000);
          addByIp(ip, false);
        });
      }

      function addByIp(ip, verified, info) {
        var exist = ESP.store.devices().filter(function (d) { return d.host === ip; })[0];
        if (exist) { ESP.store.setActive(exist.id); ESP.ui.toast('该 IP 已在设备列表中', 'warn'); ESP.app.navigate('gpio'); return; }
        ESP.ui.form({
          title: '登记设备 ' + ip,
          fields: [
            { key: 'name', label: '设备名称', value: (info && info.name) || ('ESP32-S3 ' + ip) },
            {
              key: 'board', label: '开发板型号', type: 'select',
              value: ESP.store.settings().defaultBoard,
              options: ESP.pins.BOARDS.map(function (b) { return { value: b.id, label: b.name }; })
            }
          ]
        }).then(function (v) {
          if (!v) return;
          var d = ESP.store.addDevice({
            name: v.name, transport: 'lan', host: ip, port: 80, board: v.board,
            meta: {
              chip: session.parsed.chip || (info && info.chip) || '',
              mac: session.parsed.mac || (info && info.mac) || '',
              firmware: session.parsed.firmware || (info && info.firmware) || '',
              deviceId: session.parsed.deviceId || (info && info.device_id) || ''
            }
          });
          ESP.store.setActive(d.id);
          ESP.devices.start(d.id);
          ESP.ui.toast('已添加并连接 ' + ip, 'ok');
          ESP.app.navigate('gpio');
        });
      }

      /* ------------------------------ 指令发送 ------------------------------ */
      function send(text) {
        if (!session.isOpen()) { ESP.ui.toast('请先连接串口', 'err'); return; }
        session.send(text).then(function () { renderTerminal(); })
          .catch(function (e) { log('err', '发送失败：' + e.message); });
      }

      /* ------------------------------ 页面结构 ------------------------------ */
      if (!supported()) {
        root.appendChild(U.el('div.banner.err', {}, [
          U.el('div', { html: '<b>当前浏览器不支持 Web Serial API。</b>iOS Safari、Firefox 均不支持该 API；桌面版 Chrome / Edge / 安卓 Chrome 可用。' })
        ]));
        root.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [U.el('h3', { text: '没有串口权限时的替代方案（iPhone 适用）' })]),
          U.el('div.step', {}, [U.el('div.n', { text: '1' }), U.el('div.t', { html: '<b>设备热点配网</b>：固件在连不上 Wi-Fi 时会自动创建热点 <code>ESP32S3-XXXX</code>。iPhone 连上去后访问 <code>http://192.168.4.1</code>，即可直接使用本平台配置页面填 Wi-Fi 账号密码。' })]),
          U.el('div.step', {}, [U.el('div.n', { text: '2' }), U.el('div.t', { html: '<b>手动输入 IP</b>：在电脑的串口监视器里看到设备 IP（例如 192.168.1.50），然后在 iPhone 的「设备管理」里手动添加该地址。' })]),
          U.el('div.step', {}, [U.el('div.n', { text: '3' }), U.el('div.t', { html: '<b>mDNS 域名</b>：固件会广播 <code>esp32s3-xxxx.local</code>。同一局域网内多数设备可直接用该域名代替 IP（iPhone 一般支持，部分 Windows 需安装 Bonjour）。' })]),
          U.el('div.step', {}, [U.el('div.n', { text: '4' }), U.el('div.t', { html: '<b>扫码配网</b>：把 Wi-Fi 账号密码生成二维码后用 ESP32-S3 的摄像头/外部扫码模块扫描属于定制方案；通用做法是先用 Apple「快捷指令」或第三方 App 记录家庭 Wi-Fi，再由 USB 串口写入一次。' })]),
          U.el('div.banner.warn', { style: { marginTop: '10px' } }, [
            U.el('div', { html: '<b>提醒：</b>通过串口读到 IP 只解决了「知道设备在哪」，要实现真正的异地远程控制，仍需完成 MQTT 云端链路配置。' })
          ])
        ]));
        return;
      }

      var cmdInput = U.el('input', { type: 'text', placeholder: '输入 AT 指令后回车，例如 AT+INFO' });
      cmdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { send(cmdInput.value.trim()); cmdInput.value = ''; }
      });

      var connectBtn = U.el('button.btn.primary.sm', { text: '连接串口' });
      var disBtn = U.el('button.btn.sm', { text: '断开' });

      connectBtn.onclick = function () {
        connectBtn.disabled = true;
        session.connect().then(function () {
          ESP.ui.toast('串口已连接 @115200', 'ok');
          log('sys', '提示：若没有输出，请按一下开发板上的 RESET(EN) 按键。');
        }).catch(function (e) {
          ESP.ui.toast('连接失败：' + e.message, 'err');
          log('err', '连接失败：' + e.message);
        }).then(function () { connectBtn.disabled = false; });
      };
      disBtn.onclick = function () { session.disconnect().then(renderTerminal); };

      var quick = ['AT+HELP', 'AT+INFO', 'AT+STATUS', 'AT+SCAN', 'AT+REBOOT'];

      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [
          U.el('h3', { text: '串口连接' }),
          U.el('span.hint', { text: '波特率 115200 · 需要固件支持 AT 指令（本项目 v1 固件）' }),
          U.el('div.right.row', { style: { gap: '6px' } }, [connectBtn, disBtn])
        ]),
        U.el('div.row', { style: { gap: '6px' } }, quick.map(function (c) {
          return U.el('button.btn.sm', { text: c, onclick: function () { send(c); } });
        })),
        U.el('div.row', { style: { marginTop: '8px' } }, [cmdInput, U.el('button.btn.sm', { text: '发送', onclick: function () { send(cmdInput.value.trim()); cmdInput.value = ''; } })]),
        U.el('div.banner.info', { style: { marginTop: '10px' } }, [
          U.el('div', { html: '串口数据只在浏览器本地处理，不会上传到任何服务器。发送 <code>AT+WIFI=你的SSID,密码</code> 即可配网；密码会保存在设备 NVS 中。' })
        ])
      ]));

      root.appendChild(U.el('div.grid.two', {}, [
        U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '串口日志' }),
            U.el('div.right.row.small', { style: { gap: '8px' } }, [
              U.el('span.switch.sm', {}, [
                (function () { var c = U.el('input', { type: 'checkbox' }); c.checked = true; c.addEventListener('change', function () { autoScroll = c.checked; }); return c; })(),
                U.el('span.track')
              ]),
              U.el('span.muted', { text: '自动滚动' }),
              U.el('button.btn.sm.ghost', { text: '清空', onclick: function () { session.lines = []; renderTerminal(); } })
            ])
          ]),
          term = U.el('div.terminal')
        ]),
        U.el('div', {}, [
          U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: '自动识别的设备信息' })]),
            infoBox = U.el('div')
          ]),
          U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: 'Wi-Fi 配网' }), U.el('span.hint', { text: '写入后设备自动重启' })]),
            (function () {
              var ssid = U.el('input', { type: 'text', placeholder: 'Wi-Fi 名称 (SSID)' });
              var pass = U.el('input', { type: 'password', placeholder: 'Wi-Fi 密码' });
              var btn = U.el('button.btn.primary.sm.block', { text: '写入 Wi-Fi 并重启' });
              btn.onclick = function () {
                if (!ssid.value.trim()) { ESP.ui.toast('请填写 SSID', 'err'); return; }
                if (!session.isOpen()) { ESP.ui.toast('请先连接串口', 'err'); return; }
                send(ESP.serial.AT.wifiSet(ssid.value.trim(), pass.value));
                ESP.ui.toast('已下发，等待设备重启…', 'ok', 4000);
              };
              return U.el('div', {}, [
                U.el('div.field', {}, [U.el('label', { text: 'SSID' }), ssid]),
                U.el('div.field', {}, [U.el('label', { text: '密码' }), pass]),
                btn,
                U.el('div.row', { style: { marginTop: '8px' } }, [
                  U.el('button.btn.sm', { text: '扫描附近 Wi-Fi', onclick: function () { send(ESP.serial.AT.wifiScan); } }),
                  U.el('button.btn.sm.danger', { text: '清除已保存 Wi-Fi', onclick: function () { send(ESP.serial.AT.wifiClear); } })
                ])
              ]);
            })()
          ]),
          U.el('div.card', {}, [
            U.el('div.card-head', {}, [U.el('h3', { text: '重命名 / 指定板型' })]),
            (function () {
              var name = U.el('input', { type: 'text', placeholder: '设备名称' });
              var board = U.el('select', {}, ESP.pins.BOARDS.map(function (b) { return U.el('option', { value: b.id, text: b.name }); }));
              return U.el('div', {}, [
                U.el('div.field', {}, [U.el('label', { text: '名称' }), name]),
                U.el('div.field', {}, [U.el('label', { text: '板型' }), board]),
                U.el('div.row', {}, [
                  U.el('button.btn.sm', { text: '写入名称', onclick: function () { if (name.value.trim()) send(ESP.serial.AT.name(name.value.trim())); } }),
                  U.el('button.btn.sm', { text: '写入板型', onclick: function () { send(ESP.serial.AT.board(board.value)); } })
                ])
              ]);
            })()
          ])
        ])
      ]));

      renderTerminal();
      // 离开页面时保留串口会话，避免正在读日志时被断开；只解绑渲染回调
      ctx.cleanup(session.on(function () { renderTerminal(); renderInfo(); }));
      renderInfo();
    }
  };
})(window);
