/* 设备管理：登记、编辑、删除、多设备连接、局域网发现 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  var TRANSPORT_LABEL = { lan: '局域网', mqtt: 'MQTT 云端', sim: '模拟（非真实硬件）' };

  /* ---------------- 添加 / 编辑设备对话框（供其它页面复用） ---------------- */
  function deviceDialog(existing) {
    return ESP.ui.form({
      title: existing ? '编辑设备' : '添加设备',
      width: '560px',
      fields: [
        {
          key: 'transport', label: '通信方式', type: 'select',
          value: (existing && existing.transport) || 'lan',
          options: [
            { value: 'lan', label: '局域网直连（HTTP + WebSocket）' },
            { value: 'mqtt', label: 'MQTT 云端（异地远程，需先配置 Broker）' },
            { value: 'sim', label: '模拟设备（无真实硬件，仅演示界面）' }
          ],
          desc: '局域网模式：浏览器直接访问 ESP32-S3 的 IP，无需服务器。'
        },
        { key: 'name', label: '设备名称', value: (existing && existing.name) || '', placeholder: '例如 车间控制盒 01' },
        {
          key: 'host', label: 'IP 地址 / 主机名', value: (existing && existing.host) || '',
          placeholder: '例如 192.168.1.50 或 esp32s3-xxxx.local',
          desc: '热点模式通常为 192.168.4.1；串口工具可自动读出。'
        },
        { key: 'port', label: '端口', type: 'number', value: (existing && existing.port) || 80, desc: '固件 HTTP 默认 80' },
        {
          key: 'remoteId', label: 'MQTT device_id（仅云端模式需要）',
          value: (existing && existing.remoteId) || (existing && existing.meta && existing.meta.deviceId) || '',
          placeholder: '例如 esp32s3-a1b2c3',
          desc: '必须与固件中的 device_id 一致，否则云端指令无法送达。'
        },
        {
          key: 'board', label: '开发板型号', type: 'select', value: (existing && existing.board) || ESP.store.settings().defaultBoard,
          options: ESP.pins.BOARDS.map(function (b) { return { value: b.id, label: b.name }; }),
          desc: '决定开放哪些 GPIO。选错可能控制到 Flash/PSRAM 引脚，请务必核对。'
        },
        {
          key: 'secure', label: '使用 HTTPS', type: 'checkbox', size: 'sm', value: !!(existing && existing.secure),
          desc: '固件默认提供 HTTP；除非你自行启用了 TLS，否则不要勾选。'
        }
      ],
      validate: function (v) {
        if (!v.transport) return '请选择通信方式';
        if (v.transport === 'sim') { if (!v.name.trim()) return '请填写设备名称'; return null; }
        if (v.transport === 'mqtt' && !v.remoteId.trim()) return 'MQTT 模式必须填写 device_id';
        if (v.transport === 'lan') {
          if (!v.host.trim()) return '请填写 IP 地址或主机名';
          if (!U.isInt(v.port, 1, 65535)) return '端口必须是 1-65535 的整数';
        }
        return null;
      }
    }).then(function (v) {
      if (!v) return null;
      v.port = Number(v.port) || 80;
      if (existing) {
        var before = U.deepClone(existing);
        ESP.store.updateDevice(existing.id, v);
        ESP.devices.reload(existing.id);
        ESP.ui.toast('已更新「' + v.name + '」', 'ok');
        return ESP.store.deviceById(existing.id);
      }
      var d = ESP.store.addDevice(v);
      ESP.store.setActive(d.id);
      ESP.devices.get(d.id);
      ESP.devices.start(d.id);
      ESP.ui.toast('已添加「' + d.name + '」，正在连接…', 'ok');
      return d;
    });
  }
  ESP.addDeviceDialog = deviceDialog;

  /* --------------------------- 局域网扫描发现 --------------------------- */
  function scanSubnet(prefix, opts) {
    opts = opts || {};
    var concurrency = opts.concurrency || 16;
    var timeout = opts.timeout || 1200;
    var found = [];
    var stopFlag = false;
    var done = 0, total = 254;
    var queue = [];
    for (var i = 1; i <= 254; i++) queue.push(i);

    function tryOne(index) {
      if (stopFlag) return Promise.resolve();
      var ip = prefix + index;
      return ESP.serial.probe(ip, timeout).then(function (info) {
        found.push({ ip: ip, info: info });
        if (opts.onFound) opts.onFound(ip, info, found);
      }).catch(function () { }).then(function () {
        done++;
        if (opts.onProgress) opts.onProgress(done, total, found.length);
      });
    }

    var workers = [];
    for (var w = 0; w < concurrency; w++) {
      workers.push((function worker() {
        return new Promise(function (resolve) {
          function next() {
            if (stopFlag || !queue.length) return resolve();
            var idx = queue.shift();
            tryOne(idx).then(next, next);
          }
          next();
        });
      })());
    }

    return {
      promise: Promise.all(workers).then(function () { return found; }),
      stop: function () { stopFlag = true; queue.length = 0; }
    };
  }
  ESP.scanSubnet = scanSubnet;

  /* -------------------------------- 页面 -------------------------------- */
  ESP.pages.devices = {
    title: '设备管理',
    sub: '添加、重命名、删除设备，并管理多设备连接',
    render: function (root, ctx) {
      var listRoot = U.el('div');

      function draw() {
        U.clear(listRoot);
        var devices = ESP.store.devices();

        // 工具条
        listRoot.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: '已登记设备' }),
            U.el('span.hint', { text: devices.length ? '共 ' + devices.length + ' 台，在线 ' + ESP.devices.onlineCount() + ' 台' : '尚未添加设备' }),
            U.el('div.right.row', { style: { gap: '8px' } }, [
              U.el('button.btn.primary.sm', { text: '+ 添加设备', onclick: function () { deviceDialog().then(function () { draw(); }); } }),
              U.el('button.btn.sm', { text: '局域网扫描', onclick: openScan }),
              U.el('button.btn.sm', { text: '添加模拟设备', onclick: addSim })
            ])
          ]),
          buildTable(devices)
        ]));

        listRoot.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [U.el('h3', { text: '连接方式说明' })]),
          U.el('div.step', {}, [U.el('div.n', { text: '1' }), U.el('div.t', { html: '<b>局域网直连</b>：浏览器直接连 ESP32-S3 的 IP，完全不需要服务器、不需要互联网。' })]),
          U.el('div.step', {}, [U.el('div.n', { text: '2' }), U.el('div.t', { html: '<b>MQTT 云端</b>：设备主动连接 EMQX Serverless（免费额度），网页通过 WSS 下发指令，可异地远程控制。需先在「系统设置」填写 Broker。' })]),
          U.el('div.step', {}, [U.el('div.n', { text: '3' }), U.el('div.t', { html: '<b>模拟设备</b>：本地伪造数据，<b>不能</b>操作任何真实硬件，仅用于演示。' })]),
          U.el('div.banner.warn', { style: { marginTop: '10px' } }, [
            U.el('div', { html: '<b>安全性：</b>串口读取 IP 只是配置手段。真正的远程控制必须依赖 MQTT 云端链路，并且 Broker 需要启用用户名/密码认证与 TLS。' })
          ])
        ]));
      }

      function addSim() {
        var d = ESP.store.addDevice({ name: '模拟设备（非真实硬件）', transport: 'sim', host: 'simulator', notes: '本地模拟' });
        ESP.store.setActive(d.id); ESP.devices.start(d.id);
        ESP.ui.toast('已添加模拟设备（不会控制真实硬件）', 'warn');
        draw();
      }

      function buildTable(devices) {
        if (!devices.length) {
          return U.el('div.empty', {}, [
            U.el('div.big', { text: '还没有设备' }),
            U.el('div', { text: '点击「添加设备」，或者使用「局域网扫描」自动发现。' })
          ]);
        }
        var wrap = U.el('div.tbl-wrap');
        var table = U.el('table.tbl');
        table.appendChild(U.el('thead', {}, U.el('tr', {}, [
          U.el('th', { text: '状态' }), U.el('th', { text: '名称' }), U.el('th', { text: '方式' }),
          U.el('th', { text: '地址 / ID' }), U.el('th', { text: '开发板' }), U.el('th', { text: '固件' }),
          U.el('th', { text: '最后通信' }), U.el('th', { text: '操作' })
        ])));
        var tbody = U.el('tbody');
        devices.forEach(function (d) {
          var n = ESP.devices.get(d.id);
          var isSim = d.transport === 'sim';
          var st = n && n.state && n.state.device;
          var isActive = ESP.store.activeDeviceId === d.id;
          tbody.appendChild(U.el('tr', {}, [
            U.el('td', {}, [
              U.el('i.dot' + (isSim ? '.purple' : (n && n.online ? '.on' : '.off'))),
              U.el('span.small.muted', { text: ' ' + (isSim ? '模拟' : (n && n.online ? '在线' : '离线')) })
            ]),
            U.el('td', {}, [
              U.el('div', { text: d.name + (isActive ? ' ·当前' : '') }),
              isActive ? U.el('span.badge.blue', { text: '当前设备' }) : null
            ]),
            U.el('td', {}, U.el('span.badge.' + (isSim ? 'purple' : 'blue'), { text: TRANSPORT_LABEL[d.transport] || d.transport })),
            U.el('td.mono', { text: d.transport === 'mqtt' ? (d.remoteId || '-') : (d.host + ':' + (d.port || 80)) }),
            U.el('td.small', { text: (ESP.pins.boardById(d.board) || {}).name || d.board }),
            U.el('td.mono.small', { text: (st && st.firmware) || d.meta.firmware || '-' }),
            U.el('td.small', { text: n && n.lastSeen ? U.ago(n.lastSeen) : '从未' }),
            U.el('td', {}, U.el('div.row', { style: { gap: '5px' } }, [
              U.el('button.btn.sm', { text: '切换为当前', onclick: function () { ESP.store.setActive(d.id); draw(); } }),
              U.el('button.btn.sm', { text: '重连', onclick: function () { ESP.devices.reload(d.id); ESP.ui.toast('正在重连 ' + d.name); setTimeout(draw, 400); } }),
              U.el('button.btn.sm', { text: '重命名', onclick: function () { rename(d); } }),
              U.el('button.btn.sm', { text: '编辑', onclick: function () { deviceDialog(d).then(draw); } }),
              U.el('button.btn.sm.danger', { text: '删除', onclick: function () { remove(d); } })
            ]))
          ]));
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
      }

      function rename(d) {
        ESP.ui.form({
          title: '重命名设备',
          fields: [{ key: 'name', label: '设备名称', value: d.name }],
          validate: function (v) { return v.name.trim() ? null : '名称不能为空'; }
        }).then(function (v) {
          if (!v) return;
          ESP.store.updateDevice(d.id, { name: v.name.trim() });
          ESP.bus.emit('log', { level: 'info', action: 'device.rename', message: '重命名设备为 ' + v.name.trim(), deviceId: d.id, deviceName: v.name.trim() });
          draw();
        });
      }

      function remove(d) {
        ESP.ui.confirm('删除设备', '确定要删除「' + d.name + '」吗？此操作只影响本机配置，不会改动固件内容。').then(function (ok) {
          if (!ok) return;
          ESP.devices.remove(d.id);
          ESP.ui.toast('已删除 ' + d.name, 'ok');
          draw();
        });
      }

      /* ------------------------------ 扫描弹窗 ------------------------------ */
      function openScan() {
        var logBox = U.el('div');
        var progress = U.el('div.small.muted', { text: '准备中…' });
        var results = U.el('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } });
        var handle = null;

        var fields = [
          { key: 'prefix', label: '网段前缀', value: '192.168.1.', desc: '形如 192.168.1.（最后一段留空）' },
          { key: 'timeout', label: '每台超时(ms)', type: 'number', value: 1200, min: 300, max: 5000, step: 100 },
          { key: 'concurrency', label: '并发数', type: 'number', value: 16, min: 4, max: 64 }
        ];
        var form = ESP.ui.buildForm(fields);

        var body = U.el('div', {}, [
          U.el('div.banner.info', {}, [
            U.el('div', { html: '扫描会向网段内 254 个地址依次请求 <code>/api/v1/info</code>。设备必须已升级到本项目 v1 固件（支持 CORS）。耗时约 15-30 秒。' })
          ]),
          form,
          U.el('div.row', {}, [
            U.el('button.btn.primary.sm', { text: '开始扫描', onclick: start }),
            U.el('button.btn.sm', { text: '停止', onclick: function (c) { if (handle) handle.stop(); progress.textContent = '已停止'; } })
          ]),
          progress,
          results
        ]);

        ESP.ui.modal({ title: '局域网设备扫描', width: '560px', body: body });

        function start() {
          var v = ESP.ui.collectForm(form, fields);
          if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.$/.test(v.prefix)) { ESP.ui.toast('网段前缀格式不正确', 'err'); return; }
          U.clear(results);
          handle = scanSubnet(v.prefix, {
            concurrency: U.clamp(Number(v.concurrency) || 16, 4, 64),
            timeout: U.clamp(Number(v.timeout) || 1200, 300, 5000),
            onProgress: function (done, total, n) { progress.textContent = '已探测 ' + done + '/' + total + '，发现 ' + n + ' 台'; },
            onFound: function (ip, info, found) {
              results.appendChild(U.el('div.log-item.lv-ok', {}, [
                U.el('span.ts.mono', { text: ip }),
                U.el('span.who', { text: (info && info.name) || (info && info.device_id) || 'unknown' }),
                U.el('span.msg', { text: ((info && info.chip) || '') + ' ' + ((info && info.firmware) || '') + ' ' + ((info && info.mac) || '') })
              ]));
              var already = ESP.store.devices().some(function (d) { return d.host === ip; });
              results.lastChild.appendChild(U.el('button.btn.sm.right', {
                text: already ? '已登记' : '添加此设备',
                disabled: already,
                onclick: function () {
                  var d = ESP.store.addDevice({
                    name: (info && info.name) || ('ESP32-S3 ' + ip),
                    transport: 'lan', host: ip, port: 80,
                    board: ESP.store.settings().defaultBoard,
                    meta: { chip: info.chip, mac: info.mac, firmware: info.firmware, deviceId: info.device_id }
                  });
                  ESP.store.setActive(d.id); ESP.devices.start(d.id);
                  ESP.ui.toast('已添加 ' + ip, 'ok');
                  ESP.ui.closeModal();
                  draw();
                }
              }));
            }
          });
          handle.promise.then(function (found) {
            progress.textContent = '扫描完成，共发现 ' + found.length + ' 台设备';
            if (!found.length) results.appendChild(U.el('div.empty', { text: '未发现设备。请确认：①设备已通电并连入同一网段；②固件已升级到 v1；③浏览器未被安全策略拦截跨域请求。' }));
          });
        }
      }

      root.appendChild(listRoot);
      draw();
      ctx.onBus('devices:changed', draw);
      ctx.onBus('device:status', draw);
      ctx.timer(U.throttle(draw, 2000), 2000);
    }
  };
})(window);
