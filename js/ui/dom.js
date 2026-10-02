// Small DOM toolkit shared by every screen: element builder, toasts, modals, file helpers.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'title',
]);
const PROP_KEYS = new Set(['value', 'checked', 'selected', 'indeterminate', 'muted', 'volume']);

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

function classString(value) {
  if (Array.isArray(value)) return value.flat(Infinity).filter(Boolean).join(' ');
  return value == null || value === false ? '' : String(value);
}

/**
 * h('button', { class: 'btn primary', onClick: fn, disabled: true }, '시작')
 * props: class|className (string|array), style (object|string, '--vars' supported), dataset, on<Event>,
 * boolean attributes, value/checked/selected as properties (applied after children so <select> works), html, text.
 */
export function h(tag, props = {}, ...children) {
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  const deferred = [];
  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class' || key === 'className') {
        const cls = classString(value);
        if (cls) {
          if (isSvg) el.setAttribute('class', cls);
          else el.className = cls;
        }
      } else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else if (value && typeof value === 'object') {
          for (const [sk, sv] of Object.entries(value)) {
            if (sv == null || sv === false) continue;
            if (sk.startsWith('--') || sk.includes('-')) el.style.setProperty(sk, String(sv));
            else el.style[sk] = sv;
          }
        }
      } else if (key === 'dataset') {
        if (value && typeof value === 'object') {
          for (const [dk, dv] of Object.entries(value)) {
            if (dv != null) el.dataset[dk] = String(dv);
          }
        }
      } else if (key === 'html') {
        el.innerHTML = value == null ? '' : String(value);
      } else if (key === 'text') {
        el.textContent = value == null ? '' : String(value);
      } else if (/^on[A-Za-z]/.test(key) && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (PROP_KEYS.has(key)) {
        deferred.push([key, value]);
      } else if (value === true) {
        el.setAttribute(key === 'htmlFor' ? 'for' : key, '');
      } else if (value === false || value == null) {
        // omitted attribute
      } else {
        el.setAttribute(key === 'htmlFor' ? 'for' : key, String(value));
      }
    }
  } else if (props != null) {
    children.unshift(props);
  }
  appendChildren(el, children);
  for (const [key, value] of deferred) el[key] = value;
  if (tag === 'input' && el.type === 'range') syncRange(el);
  return el;
}

/** Updates the --val custom property used by base.css to paint the filled part of a range track. */
export function syncRange(input) {
  if (!input || input.type !== 'range') return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const val = Number(input.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--val', `${Math.max(0, Math.min(100, pct))}%`);
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'range') syncRange(t);
  }, true);
}

/** addEventListener that returns its own remover. */
export function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatNumber(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '0';
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureRoot(id) {
  let root = document.getElementById(id);
  if (!root) {
    root = document.createElement('div');
    root.id = id;
    document.body.append(root);
  }
  return root;
}

// ---------------------------------------------------------------- toast

const MAX_TOASTS = 4;

export function toast(message, opts = {}) {
  const o = typeof opts === 'string' ? { type: opts } : (opts || {});
  const type = ['info', 'success', 'error'].includes(o.type) ? o.type : 'info';
  const duration = Number.isFinite(o.duration) ? o.duration : (type === 'error' ? 4000 : 2500);
  const root = ensureRoot('toast-root');
  const el = h('div', {
    class: ['toast', type],
    role: type === 'error' ? 'alert' : 'status',
  }, h('span', { class: 'toast-text' }, String(message ?? '')));
  root.append(el);
  while (root.children.length > MAX_TOASTS) root.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  let removed = false;
  const close = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 260);
  };
  const timer = setTimeout(close, Math.max(800, duration));
  el.addEventListener('click', close);
  return { close, el };
}

// ---------------------------------------------------------------- modal

const modalStack = [];
let modalSeq = 0;

function onModalKey(e) {
  if (e.key !== 'Escape' || !modalStack.length) return;
  const top = modalStack[modalStack.length - 1];
  if (top.dismissible) {
    e.preventDefault();
    e.stopPropagation();
    top.close('dismiss');
  }
}

export function isModalOpen() {
  return modalStack.length > 0;
}

/** Closes the top-most dismissible modal. Returns true when a modal was open (the back action is consumed). */
export function closeTopModal() {
  if (!modalStack.length) return false;
  const top = modalStack[modalStack.length - 1];
  if (top.dismissible) top.close('back');
  return true;
}

export function modal({ title = '', content = null, actions = [], dismissible = true, onClose, className = '' } = {}) {
  const root = ensureRoot('modal-root');
  const prevFocus = document.activeElement;
  const titleId = `modal-title-${++modalSeq}`;
  let closed = false;
  let busy = false;

  const bodyContent = typeof content === 'string' || typeof content === 'number'
    ? h('p', { class: 'modal-text' }, String(content))
    : content;

  const closeBtn = dismissible
    ? h('button', { type: 'button', class: 'icon-btn modal-close', 'aria-label': '닫기', onClick: () => api.close('dismiss') }, '✕')
    : null;

  const buttons = (actions || []).map((a) => h('button', {
    type: 'button',
    class: ['btn', a.primary && 'primary', a.danger && 'danger', !a.primary && !a.danger && 'ghost'],
    onClick: async () => {
      if (busy || closed) return;
      busy = true;
      setDisabled(true);
      let keepOpen = false;
      try {
        const r = a.onClick ? await a.onClick(api) : undefined;
        keepOpen = r === false;
      } catch (err) {
        console.error(err);
        toast(err?.message || '오류가 발생했어요.', { type: 'error' });
        keepOpen = true;
      }
      busy = false;
      if (keepOpen) setDisabled(false);
      else api.close('action');
    },
  }, a.text ?? '확인'));

  const dialog = h('div', {
    class: ['modal', className],
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': title ? titleId : null,
    tabindex: '-1',
  },
  title || closeBtn ? h('div', { class: 'modal-head' }, h('h2', { id: titleId, class: 'modal-title' }, title), closeBtn) : null,
  h('div', { class: 'modal-body scroll' }, bodyContent),
  buttons.length ? h('div', { class: 'modal-actions' }, buttons) : null);

  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop && dismissible && !busy) api.close('dismiss');
  });

  function setDisabled(dis) {
    for (const b of buttons) b.disabled = dis;
  }

  const api = {
    el: dialog,
    dismissible,
    close(reason = 'close') {
      if (closed) return;
      closed = true;
      const i = modalStack.indexOf(api);
      if (i >= 0) modalStack.splice(i, 1);
      if (!modalStack.length) {
        document.removeEventListener('keydown', onModalKey, true);
        document.body.classList.remove('modal-open');
      }
      backdrop.classList.remove('show');
      backdrop.classList.add('hide');
      setTimeout(() => backdrop.remove(), 200);
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
      if (onClose) {
        try { onClose(reason); } catch (err) { console.error(err); }
      }
    },
  };

  if (!modalStack.length) {
    document.addEventListener('keydown', onModalKey, true);
    document.body.classList.add('modal-open');
  }
  modalStack.push(api);
  root.append(backdrop);
  requestAnimationFrame(() => {
    backdrop.classList.add('show');
    const focusTarget = dialog.querySelector('[autofocus]') || dialog.querySelector('.modal-actions .btn.primary') || dialog;
    try { focusTarget.focus({ preventScroll: true }); } catch { /* ignore */ }
  });
  return api;
}

export function confirmDialog({ title = '확인', message = '', okText = '확인', cancelText = '취소', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      content: message,
      actions: [
        { text: cancelText, onClick: () => { result = false; } },
        { text: okText, primary: !danger, danger, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---------------------------------------------------------------- files

export function downloadFile(filename, content, mime = 'application/json') {
  let blob;
  if (content instanceof Blob) blob = content;
  else {
    const textual = mime.startsWith('text/') || mime === 'application/json';
    blob = new Blob([content == null ? '' : String(content)], { type: textual ? `${mime};charset=utf-8` : mime });
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename || 'download', style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Opens the system file picker. Resolves the chosen File, or null when the picker reports a cancel. */
export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const input = h('input', {
      type: 'file',
      accept: accept || null,
      style: 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0',
      tabindex: '-1',
      'aria-hidden': 'true',
    });
    let done = false;
    const finish = (file) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(file || null);
    };
    input.addEventListener('change', () => finish(input.files && input.files[0]));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}
