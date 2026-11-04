/* 系统设置：轮询参数、板型、MQTT 云端配置、Cloudflare 预留、数据管理 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;
  ESP.pages = ESP.pages || {};

  function boolRow(label, desc, key, onChange) {
    var cb = U.el('input', { type: 'checkbox' });
    cb.checked = !!ESP.store.settings()[key];
    cb.addEventListener('change', function () {
      var patch = {}; patch[key] = cb.checked;
      ESP.store.updateSettings(patch);
      ESP.ui.toast('已保存', 'ok', 1200);
      if (onChange) onChange(cb.checked);
    });
    return U.el('div.stat-row', {}, [
      U.el('div', {}, [
        U.el('div', { text: label }),
        U.el('div.small.muted', { text: desc })
      ]),
      U.el('span.switch.sm', {}, [cb, U.el('span.track')])
    ]);
  }

  function numRow(label, desc, key, min, max, step, unit) {
    var input = U.el('input', { type: 'number', min: min, max: max, step: step || 1, value: ESP.store.settings()[key] });
    input.style.width = '120px';
    input.addEventListener('change', function () {
      var v = Number(input.value);
      if (!U.isInt(v, min, max)) { ESP.ui.toast('请输入 ' + min + '-' + max + ' 之间的整数', 'err'); input.value = ESP.store.settings()[key]; return; }
      var patch = {}; patch[key] = v;
      ESP.store.updateSettings(patch);
      ESP.ui.toast('已保存', 'ok', 1200);
    });
    return U.el('div.stat-row', {}, [
      U.el('div', {}, [U.el('div', { text: label }), U.el('div.small.muted', { text: desc })]),
      U.el('span.row', {}, [input, U.el('span.small.muted', { text: unit || '' })])
    ]);
  }

  ESP.pages.settings = {
    title: '系统设置',
    sub: '通信参数、云端凭证与数据管理',
    render: function (root, ctx) {
      var s = ESP.store.settings();

      /* ---------------------------- 通用 ---------------------------- */
      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [U.el('h3', { text: '通用设置' }), U.el('span.hint', { text: '保存后立即生效' })]),
        numRow('状态轮询间隔', 'WebSocket 不可用时的 HTTP 轮询周期', 'pollMs', 300, 10000, 100, 'ms'),
        numRow('离线判定超时', '超过该时间未收到设备消息即判定离线', 'offlineTimeoutMs', 2000, 60000, 500, 'ms'),
        numRow('HTTP 请求超时', '单次 REST 请求超时时间', 'httpTimeoutMs', 500, 15000, 100, 'ms'),
        boolRow('显示风险引脚', '开放启动绑带、UART0、PSRAM 等有风险的 GPIO', 'showRiskPins', function () { ESP.app.renderPage(); }),
        U.el('div.field', { style: { marginTop: '12px' } }, [
          U.el('label', { text: '默认开发板型号' }),
          (function () {
            var sel = U.el('select', {}, ESP.pins.BOARDS.map(function (b) {
              return U.el('option', { value: b.id, text: b.name, selected: b.id === s.defaultBoard });
            }));
            sel.addEventListener('change', function () {
              ESP.store.updateSettings({ defaultBoard: sel.value });
              ESP.ui.toast('默认板型已更新（已存在设备不受影响）', 'ok');
            });
            return sel;
          })()
        ])
      ]));

      /* ---------------------------- MQTT ---------------------------- */
      (function () {
        var m = ESP.store.settings().mqtt;
        var fields = [
          {
            key: 'enabled', label: '启用 MQTT 云端远程控制', type: 'checkbox', size: 'sm', value: m.enabled,
            desc: '未启用时，所有设备只能走局域网模式。'
          },
          {
            key: 'host', label: 'Broker 域名', value: m.host,
            placeholder: '例如 xxxxx.eu-central-1.emqxsl.com',
            desc: 'EMQX Cloud Serverless 控制台提供；浏览器直连需要支持 WebSocket。'
          },
          { key: 'port', label: 'WSS 端口', type: 'number', value: m.port, min: 1, max: 65535, desc: 'EMQX Serverless 默认 8084（WebSocket Secure）' },
          { key: 'path', label: 'WebSocket 路径', value: m.path, desc: 'EMQX 默认 /mqtt' },
          {
            key: 'secure', label: '使用 wss 加密', type: 'checkbox', size: 'sm', value: m.secure !== false,
            desc: '务必保持开启，否则用户名密码会明文传输。'
          },
          { key: 'username', label: 'MQTT 用户名', value: m.username, desc: '建议为每台设备单独创建账号，便于吊销。' },
          { key: 'password', label: 'MQTT 密码', type: 'password', value: m.password, desc: '仅保存在本机 localStorage，不会随代码发布。' },
          { key: 'clientPrefix', label: '网页客户端 ID 前缀', value: m.clientPrefix }
        ];
        var form = ESP.ui.buildForm(fields);
        var resultBox = U.el('div.banner.info.hide', {});

        root.appendChild(U.el('div.card', {}, [
          U.el('div.card-head', {}, [
            U.el('h3', { text: 'MQTT 云端（异地远程控制）' }),
            U.el('span.hint', { text: '客户端自研 MQTT over WebSocket，无需 npm / CDN' })
          ]),
          U.el('div.banner.warn', {}, [
            U.el('div', { html: '<b>安全提示：</b>网页直连 Broker 时，凭证保存在访问者本机浏览器里。要把控制权限开放给别人时使用前，请先在 Cloudflare Worker 里实现「短期凭证下发 + 用户鉴权」，避免长期密钥泄漏。' })
          ]),
          form,
          resultBox,
          U.el('div.row', { style: { marginTop: '10px' } }, [
            U.el('button.btn.primary.sm', {
              text: '保存并测试连接',
              onclick: function () { saveMqtt(form, fields, resultBox, true); }
            }),
            U.el('button.btn.sm', { text: '仅保存', onclick: function () { saveMqtt(form, fields, resultBox, false); } }),
            U.el('button.btn.sm.ghost', { text: '清空凭证', onclick: clearMqtt })
          ]),
          U.el('div.small.muted', { style: { marginTop: '10px' } }, [
            document.createTextNode('配置完成后，在「设备管理」里把设备的通信方式改为「MQTT 云端」，并填写与固件一致的 device_id。Topic 约定：devices/{id}/command、/response、/status、/heartbeat。')
          ])
        ]));
      })();

      /* ------------------------ Cloudflare 预留 ------------------------ */
      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [
          U.el('h3', { text: 'Cloudflare 后端（预留）' }),
          U.el('span.badge.amber', { text: '第六阶段 · 未启用' })
        ]),
        (function () {
          var c = ESP.store.settings().cloud;
          var api = U.el('input', { type: 'text', value: c.apiBase, placeholder: 'https://xxx.workers.dev' });
          var path = U.el('input', { type: 'text', value: c.tokenPath, placeholder: '/api/mqtt-credential' });
          return U.el('div', {}, [
            U.el('div.field', {}, [U.el('label', { text: 'Worker API 地址' }), api,
              U.el('div.desc', { text: 'Worker 负责校验用户身份后下发短期 MQTT 凭证，避免长期密钥出现在网页里。' })]),
            U.el('div.field', {}, [U.el('label', { text: '凭证接口路径' }), path]),
            U.el('div.row', {}, [
              U.el('button.btn.sm', {
                text: '保存', onclick: function () {
                  ESP.store.updateSettings({ cloud: { apiBase: api.value.trim(), tokenPath: path.value.trim(), enabled: !!api.value.trim() } });
                  ESP.ui.toast('已保存（功能将在 Cloudflare Worker 部署完成后生效）', 'warn');
                }
              })
            ]),
            U.el('div.banner.info', { style: { marginTop: '10px' } }, [
              U.el('div', { html: '部署步骤见 <code>docs/CLOUDFLARE.md</code>。Worker 代码模板位于 <code>deploy/cloudflare/worker.js</code>。' })
            ])
          ]);
        })()
      ]));

      /* --------------------------- Wi-Fi 下发 --------------------------- */
      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [U.el('h3', { text: 'Wi-Fi 配置（对当前设备下发）' }), U.el('span.hint', { text: '需要设备当前在线' })]),
        (function () {
          var d = ESP.store.activeDevice();
          var ssidIn = U.el('input', { type: 'text', placeholder: '要连接的 Wi-Fi 名称' });
          var passIn = U.el('input', { type: 'password', placeholder: 'Wi-Fi 密码' });
          var btn = U.el('button.btn.primary.sm', { text: '下发并保存' });
          btn.onclick = function () {
            if (!d) { ESP.ui.toast('请先选择设备', 'err'); return; }
            if (!ssidIn.value.trim()) { ESP.ui.toast('请填写 SSID', 'err'); return; }
            ESP.ui.confirm('写入 Wi-Fi', '设备将保存凭据并尝试连接。若新 Wi-Fi 不可用，设备会回落到热点模式。', '写入').then(function (ok) {
              if (!ok) return;
              ESP.devices.invoke(d.id, 'config.wifi', { ssid: ssidIn.value.trim(), password: passIn.value })
                .then(function () { ESP.ui.toast('已下发，等待设备重连…', 'ok', 4000); setTimeout(function () { ESP.devices.reload(d.id); }, 5000); })
                .catch(function (e) { ESP.ui.toast('写入失败：' + e.message, 'err'); });
            });
          };
          return U.el('div', {}, [
            U.el('div.field-row', {}, [
              U.el('div', {}, [U.el('label', { text: 'SSID' }), ssidIn]),
              U.el('div', {}, [U.el('label', { text: '密码' }), passIn])
            ]),
            U.el('div.row', { style: { marginTop: '10px' } }, [btn, U.el('span.small.muted', { text: '当前设备：' + (d ? d.name : '未选择') })])
          ]);
        })()
      ]));

      /* -------------------------- 自动化预留 -------------------------- */
      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [U.el('h3', { text: '自动化' }), U.el('span.badge.amber', { text: '架构预留 · 第十阶段' })]),
        U.el('div.small.muted', { html: '后续会在 <code>assets/js/automation/</code> 下新增规则引擎，数据结构预览：<code>{ id, enabled, trigger:{type:"time"|"gpio_edge"|"threshold"|"device_event"…}, conditions:[…], actions:[{op,args}…] }</code>。规则由本平台在本机定时执行，并按给强弱/automation 的顺序通过现有 invoke 通道下发，不改变现有通信协议。' }),
        U.el('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', marginTop: '10px' } }, [
          ['定时控制 GPIO', '按时间点/周期执行'],
          ['输入触发输出', 'GPIO 上升沿/下降沿'],
          ['GPIO 联动', '多引脚组合动作'],
          ['PWM 自动调节', '按曲线或时间'],
          ['条件触发任务', 'if/then 表达式'],
          ['温度传感器联动', '后续接入传感器'],
          ['多设备联动', '跨设备编排']
        ].map(function (t) {
          return U.el('div.pin-card', {}, [
            U.el('div.pin-num', { style: { fontSize: '13px' }, text: t[0] }),
            U.el('div.pin-sub', { text: t[1] }),
            U.el('span.badge.ghost', { style: { marginTop: '8px' }, text: '未实现' })
          ]);
        }))
      ]));

      /* -------------------------- 数据管理 -------------------------- */
      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [U.el('h3', { text: '数据管理' }), U.el('span.hint', { text: '全部数据保存在本机浏览器' })]),
        U.el('div.row', {}, [
          U.el('button.btn.sm', {
            text: '导出配置', onclick: function () {
              var blob = new Blob([ESP.store.exportAll()], { type: 'application/json' });
              var a = U.el('a', { href: URL.createObjectURL(blob), download: 'esp32s3-platform-config.json' });
              document.body.appendChild(a); a.click(); a.remove();
            }
          }),
          U.el('button.btn.sm', {
            text: '导入配置', onclick: function () {
              var inp = U.el('input', { type: 'file', accept: 'application/json' });
              inp.addEventListener('change', function () {
                var f = inp.files && inp.files[0];
                if (!f) return;
                var fr = new FileReader();
                fr.onload = function () {
                  try { ESP.store.importAll(String(fr.result)); ESP.ui.toast('导入成功', 'ok'); ESP.app.renderPage(); }
                  catch (e) { ESP.ui.toast('导入失败：' + e.message, 'err'); }
                };
                fr.readAsText(f);
              });
              inp.click();
            }
          }),
          U.el('button.btn.sm.danger', {
            text: '清空所有设备与日志', onclick: function () {
              ESP.ui.confirm('危险操作', '将删除本机保存的所有设备、设置与日志（不会影响固件）。', '确认清空').then(function (ok) {
                if (!ok) return;
                ESP.store.devices().slice().forEach(function (d) { ESP.devices.remove(d.id); });
                ESP.store.clearLogs();
                ESP.ui.toast('已清空', 'ok');
                ESP.app.renderPage();
              });
            }
          })
        ]),
        U.el('div.small.muted', { style: { marginTop: '10px' } }, [
          document.createTextNode('本地缓存键名：' + ESP.store.KEY + '。清除浏览器数据会一并删除设备清单。')
        ])
      ]));

      /* ------------------------------ 关于 ------------------------------ */
      root.appendChild(U.el('div.card', {}, [
        U.el('div.card-head', {}, [U.el('h3', { text: '关于' })]),
        ESP.ui.statRow('平台版本', '1.0.0-local'),
        ESP.ui.statRow('固件协议版本', 'v1（向下兼容 v0 旧固件）'),
        ESP.ui.statRow('前端依赖', '无（原生 HTML/CSS/JS）'),
        ESP.ui.statRow('运行位置', location.protocol === 'file:' ? '本地文件（建议使用本地静态服务器）' : location.origin),
        ESP.ui.statRow('已登记设备', ESP.store.devices().length + ' 台')
      ]));
    }
  };

  function saveMqtt(form, fields, resultBox, test) {
    var v = ESP.ui.collectForm(form, fields);
    if (v.enabled && !v.host.trim()) {
      resultBox.className = 'banner err';
      resultBox.textContent = '启用 MQTT 时必须填写 Broker 域名。';
      return;
    }
    ESP.store.updateSettings({
      mqtt: {
        enabled: !!v.enabled,
        host: v.host.trim(),
        port: Number(v.port) || 8084,
        path: v.path.trim() || '/mqtt',
        secure: v.secure !== false,
        username: v.username,
        password: v.password,
        clientPrefix: v.clientPrefix || 'esp32s3-web'
      }
    });
    ESP.ui.toast('MQTT 配置已保存', 'ok');
    if (!test) { resultBox.className = 'banner info'; resultBox.textContent = '配置已保存到本机。'; return; }
    if (!v.enabled) { resultBox.className = 'banner info'; resultBox.textContent = 'MQTT 未启用，未进行连接测试。'; return; }

    resultBox.className = 'banner info';
    resultBox.textContent = '正在尝试连接 ' + (v.secure !== false ? 'wss' : 'ws') + '://' + v.host + ':' + v.port + v.path + ' …';

    var cfg = ESP.store.settings().mqtt;
    var url = (cfg.secure ? 'wss' : 'ws') + '://' + cfg.host + ':' + cfg.port + cfg.path;
    var client = new ESP.MqttClient({
      url: url,
      clientId: (cfg.clientPrefix || 'esp32s3-web') + '-test-' + U.shortId(6),
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      keepalive: 30,
      onConnect: function () {
        resultBox.className = 'banner info';
        resultBox.textContent = 'Broker 连接成功，用户名/密码有效。请继续在「设备管理」中把设备切换到 MQTT 模式。';
        client.close();
      },
      onError: function (e) {
        resultBox.className = 'banner err';
        resultBox.textContent = '连接失败：' + e.message;
        client.close();
      },
      onClose: function () { }
    });
    client.connect();
    setTimeout(function () { try { client.close(); } catch (e) { } }, 12000);
  }

  function clearMqtt() {
    ESP.ui.confirm('清空 MQTT 凭证', '将删除本机保存的 Broker 地址与用户名密码。', '清空').then(function (ok) {
      if (!ok) return;
      ESP.store.updateSettings({
        mqtt: { enabled: false, host: '', port: 8084, path: '/mqtt', secure: true, username: '', password: '', clientPrefix: 'esp32s3-web', keepalive: 60 }
      });
      ESP.ui.toast('已清空', 'ok');
      ESP.app.renderPage();
    });
  }
})(window);
