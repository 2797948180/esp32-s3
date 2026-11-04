/* 通用 UI 组件：Toast、模态框、确认框、表单、迷你折线图 */
(function (global) {
  'use strict';
  var ESP = global.ESP = global.ESP || {};
  var U = ESP.util;

  function toast(message, kind, ms) {
    var wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    var t = U.el('div.toast' + (kind ? '.' + kind : ''), { text: message });
    wrap.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }, ms || (kind === 'err' ? 4200 : 2600));
  }

  function closeModal() {
    var mask = document.getElementById('modalMask');
    if (!mask) return;
    mask.classList.remove('show');
    U.clear(document.getElementById('modalBox'));
  }

  /* opts: { title, body(Node|string), actions:[{label,kind,onClick(close)}], onOpen } */
  function modal(opts) {
    var mask = document.getElementById('modalMask');
    var box = document.getElementById('modalBox');
    if (!mask || !box) return function () { };
    U.clear(box);
    box.appendChild(U.el('header', {}, [
      U.el('h3', { text: opts.title || '' }),
      U.el('button.x-btn', { html: '&times;', onclick: closeModal, 'aria-label': '关闭' })
    ]));
    var body = U.el('div.body');
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) U.append(body, opts.body);
    box.appendChild(body);

    if (opts.actions && opts.actions.length) {
      var foot = U.el('div.foot');
      (opts.actions || []).forEach(function (a) {
        foot.appendChild(U.el('button.btn' + (a.kind ? '.' + a.kind : ''), {
          text: a.label,
          onclick: function () { if (a.onClick) a.onClick(closeModal); else closeModal(); }
        }));
      });
      box.appendChild(foot);
    }
    if (opts.width) box.style.width = 'min(' + opts.width + ', 100%)';
    else box.style.width = '';
    mask.classList.add('show');
    if (opts.onOpen) opts.onOpen(box, closeModal);
    return closeModal;
  }

  function confirmBox(title, message, okLabel) {
    return new Promise(function (resolve) {
      modal({
        title: title || '请确认',
        body: '<div style="font-size:13.5px;line-height:1.6">' + U.escapeHtml(message || '') + '</div>',
        actions: [
          { label: '取消', kind: 'ghost', onClick: function (c) { resolve(false); c(); } },
          { label: okLabel || '确定', kind: 'danger', onClick: function (c) { resolve(true); c(); } }
        ]
      });
    });
  }

  /* fields: [{key,label,type,value,desc,placeholder,options:[{value,label}],min,max,step,rows}] */
  function buildForm(fields) {
    var root = U.el('div');
    fields.forEach(function (f) {
      var row = U.el('div.field', {}, [U.el('label', { text: f.label })]);
      var input;
      if (f.type === 'select') {
        input = U.el('select', {}, (f.options || []).map(function (o) {
          return U.el('option', { value: o.value, text: o.label, selected: String(o.value) === String(f.value) });
        }));
      } else if (f.type === 'textarea') {
        input = U.el('textarea', { rows: f.rows || 5, placeholder: f.placeholder || '' });
        input.value = f.value || '';
      } else if (f.type === 'checkbox') {
        input = U.el('span.row', {}, [
          U.el('label.switch' + (f.size === 'sm' ? '.sm' : ''), {}, [
            (function () {
              var c = U.el('input', { type: 'checkbox' });
              c.checked = !!f.value;
              return c;
            })(),
            U.el('span.track')
          ]),
          U.el('span.small.muted', { text: f.desc || '' })
        ]);
      } else {
        input = U.el('input', { type: f.type || 'text', placeholder: f.placeholder || '' });
        if (f.min != null) input.setAttribute('min', f.min);
        if (f.max != null) input.setAttribute('max', f.max);
        if (f.step != null) input.setAttribute('step', f.step);
        input.value = f.value == null ? '' : f.value;
      }
      input.dataset.field = f.key;
      row.appendChild(input);
      if (f.desc && f.type !== 'checkbox') row.appendChild(U.el('div.desc', { text: f.desc }));
      root.appendChild(row);
    });
    return root;
  }

  function collectForm(root, fields) {
    var out = {};
    fields.forEach(function (f) {
      var node = root.querySelector('[data-field="' + f.key + '"]');
      if (!node) { out[f.key] = f.value; return; }
      if (f.type === 'checkbox') out[f.key] = node.checked;
      else out[f.key] = node.value;
    });
    return out;
  }

  /* opts: { title, fields:[], okLabel, width, validate(values)->错误消息|null } */
  function formBox(opts) {
    return new Promise(function (resolve) {
      var formRoot = buildForm(opts.fields);
      var errNode = U.el('div.banner.err.hide', {});
      formRoot.appendChild(errNode);
      modal({
        title: opts.title,
        width: opts.width || '520px',
        body: formRoot,
        actions: [
          { label: '取消', kind: 'ghost', onClick: function (c) { resolve(null); c(); } },
          {
            label: opts.okLabel || '保存', kind: 'primary', onClick: function (c) {
              var values = collectForm(formRoot, opts.fields);
              if (opts.validate) {
                var err = opts.validate(values);
                if (err) { errNode.textContent = err; errNode.classList.remove('hide'); return; }
              }
              resolve(values);
              c();
            }
          }
        ],
        onOpen: function (box) {
          var first = formRoot.querySelector('input,select,textarea');
          if (first) setTimeout(function () { first.focus(); }, 60);
        }
      });
      // 回车提交
      formRoot.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          var btn = document.querySelector('#modalBox .foot .btn.primary');
          if (btn) btn.click();
        }
      });
    });
  }

  /* 迷你折线图（纯 SVG，无依赖） */
  function sparkline(values, opts) {
    opts = opts || {};
    var w = opts.width || 300, h = opts.height || 46;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');
    var vals = (values || []).filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (vals.length < 2) {
      svg.appendChild(document.createTextNode(''));
      return svg;
    }
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 1e-9) { max = min + 1; }
    var pad = 2;
    var stepX = (w - pad * 2) / (vals.length - 1);
    var pts = vals.map(function (v, i) {
      var x = pad + i * stepX;
      var y = h - pad - ((v - min) / (max - min)) * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts.join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', opts.color || '#7aa5ff');
    poly.setAttribute('stroke-width', '1.6');
    poly.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(poly);

    var area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('points', pts[0].split(',')[0] + ',' + (h - pad) + ' ' + pts.join(' ') + ' ' + pts[pts.length - 1].split(',')[0] + ',' + (h - pad));
    area.setAttribute('fill', (opts.color || '#7aa5ff') + '22');
    svg.insertBefore(area, poly);
    return svg;
  }

  function statusDot(online, sim) {
    return U.el('i.dot' + (sim ? '.purple' : online ? '.on' : '.off'));
  }

  /* 页面通用：没有选中设备时的占位 */
  function noDevice(message, actionLabel, action) {
    return U.el('div.empty', {}, [
      U.el('div.big', { text: '尚未选择设备' }),
      U.el('div', { text: message || '请先在「设备管理」中添加一台 ESP32-S3。' }),
      action ? U.el('div', { style: { marginTop: '12px' } }, [U.el('button.btn.primary.sm', { text: actionLabel, onclick: action })]) : null
    ]);
  }

  function statRow(k, v) {
    return U.el('div.stat-row', {}, [
      U.el('span.k', { text: k }),
      U.el('span.v', { html: typeof v === 'string' ? U.escapeHtml(v) : (v == null ? '-' : String(v)) })
    ]);
  }

  ESP.ui = {
    toast: toast, modal: modal, confirm: confirmBox, form: formBox,
    buildForm: buildForm, collectForm: collectForm,
    sparkline: sparkline, statusDot: statusDot, noDevice: noDevice, statRow: statRow,
    closeModal: closeModal
  };
})(window);
