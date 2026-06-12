// Content script: runs in every page. Builds element snapshots, performs
// clicks/typing/scrolling, and draws a visible "agent cursor" so you can see
// what the AI is doing.

(() => {
  if (window.__emberAgentLoaded) return;
  window.__emberAgentLoaded = true;

  let refMap = new Map(); // ref id -> element, rebuilt on every snapshot
  let refCounter = 0;

  // -------------------------------------------------------------------------
  // Visible agent cursor
  // -------------------------------------------------------------------------

  let cursorEl = null;
  let cursorHideTimer = null;

  function getCursor() {
    if (cursorEl && document.documentElement.contains(cursorEl)) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.setAttribute('data-ember-cursor', '');
    Object.assign(cursorEl.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '22px',
      height: '22px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transition: 'left 0.35s cubic-bezier(.3,.7,.4,1), top 0.35s cubic-bezier(.3,.7,.4,1)',
      opacity: '0',
    });
    cursorEl.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24">' +
      '<path d="M4 2 L20 12 L12.5 13.5 L9 21 Z" fill="#e8743b" stroke="#fff" stroke-width="1.5"/></svg>';
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }

  function moveCursorTo(x, y) {
    return new Promise((resolve) => {
      const c = getCursor();
      clearTimeout(cursorHideTimer);
      c.style.opacity = '1';
      // Force a layout so the transition applies from the current position.
      void c.offsetWidth;
      c.style.left = `${x - 2}px`;
      c.style.top = `${y - 2}px`;
      setTimeout(resolve, 380);
    });
  }

  function pulseCursor() {
    const c = getCursor();
    c.style.transform = 'scale(0.7)';
    setTimeout(() => {
      c.style.transform = 'scale(1)';
    }, 120);
    cursorHideTimer = setTimeout(() => {
      c.style.opacity = '0';
    }, 4000);
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="combobox"]',
    '[role="switch"]',
    '[role="option"]',
    '[contenteditable="true"]',
    '[onclick]',
  ].join(', ');

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }

  function textLabel(el) {
    const label =
      el.getAttribute('aria-label') ||
      (el.labels && el.labels[0]?.innerText) ||
      el.placeholder ||
      el.alt ||
      el.title ||
      (el.innerText || '').trim() ||
      el.value ||
      el.name ||
      '';
    return String(label).replace(/\s+/g, ' ').trim().slice(0, 90);
  }

  function describe(el, ref) {
    const tag = el.tagName.toLowerCase();
    const parts = [`[${ref}] <${tag}${el.type ? ` type=${el.type}` : ''}>`];
    const label = textLabel(el);
    if (label) parts.push(`"${label}"`);
    if (tag === 'a' && el.getAttribute('href')) {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) parts.push(`→ ${href.slice(0, 120)}`);
    }
    if ((tag === 'input' || tag === 'textarea') && el.value) parts.push(`value="${String(el.value).slice(0, 60)}"`);
    if (el.checked) parts.push('(checked)');
    if (el.disabled) parts.push('(disabled)');
    if (tag === 'select') {
      const opts = Array.from(el.options || []).slice(0, 12).map((o) => o.text.trim().slice(0, 30));
      parts.push(`options=[${opts.join(' | ')}]`);
    }
    return parts.join(' ');
  }

  function buildSnapshot() {
    refMap = new Map();
    refCounter = 0;
    const lines = [`Page: ${document.title}`, `URL: ${location.href}`, ''];

    const headings = document.querySelectorAll('h1, h2, h3');
    if (headings.length) {
      lines.push('Headings:');
      let count = 0;
      for (const h of headings) {
        if (!isVisible(h)) continue;
        const text = h.innerText.replace(/\s+/g, ' ').trim().slice(0, 100);
        if (text) lines.push(`  ${'#'.repeat(Number(h.tagName[1]))} ${text}`);
        if (++count >= 30) break;
      }
      lines.push('');
    }

    lines.push('Interactive elements (use ref ids to click/type):');
    const seen = new Set();
    let truncated = false;
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (seen.has(el) || !isVisible(el)) continue;
      seen.add(el);
      if (refCounter >= 400) {
        truncated = true;
        break;
      }
      const ref = `e${++refCounter}`;
      refMap.set(ref, el);
      lines.push(describe(el, ref));
    }
    if (truncated) lines.push('... (truncated at 400 elements)');
    return lines.join('\n');
  }

  function getRefElement(ref) {
    const el = refMap.get(ref);
    if (!el || !el.isConnected) {
      throw new Error(`Ref "${ref}" not found or stale — take a new snapshot first`);
    }
    return el;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function mouseEventInit(x, y, extra = {}) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      ...extra,
    };
  }

  async function clickAt(x, y, { button = 0 } = {}) {
    await moveCursorTo(x, y);
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error(`Nothing at coordinates (${x}, ${y})`);
    pulseCursor();
    const init = mouseEventInit(x, y, { button });
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    if (target.focus) target.focus();
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));
    return { clicked: textLabel(target) || target.tagName.toLowerCase(), x, y };
  }

  async function clickRef(ref) {
    const el = getRefElement(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 100));
    const rect = el.getBoundingClientRect();
    return clickAt(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
  }

  async function hoverTarget(args) {
    let x, y, el;
    if (args.ref) {
      el = getRefElement(args.ref);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 100));
      const rect = el.getBoundingClientRect();
      x = Math.round(rect.left + rect.width / 2);
      y = Math.round(rect.top + rect.height / 2);
    } else {
      x = args.x;
      y = args.y;
      el = document.elementFromPoint(x, y);
    }
    await moveCursorTo(x, y);
    if (el) {
      const init = mouseEventInit(x, y);
      el.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseover', init));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
      el.dispatchEvent(new MouseEvent('mousemove', init));
    }
    return { hovered: el ? textLabel(el) || el.tagName.toLowerCase() : null };
  }

  // Set value the "React-safe" way: through the native setter, then fire input.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function typeText(args) {
    let el = args.ref ? getRefElement(args.ref) : document.activeElement;
    if (!el || el === document.body) throw new Error('No target — pass a ref or click a field first');
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      setNativeValue(el, args.clear === false ? el.value + args.text : args.text);
    } else if (el.isContentEditable) {
      el.textContent = args.clear === false ? el.textContent + args.text : args.text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: args.text, inputType: 'insertText' }));
    } else {
      throw new Error(`Element <${el.tagName.toLowerCase()}> is not editable`);
    }
    if (args.submit) {
      dispatchKey(el, 'Enter');
      const form = el.form || el.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        try { form.requestSubmit(); } catch { /* form may have been handled by JS already */ }
      }
    }
    return { typed: args.text, into: textLabel(el) || el.tagName.toLowerCase() };
  }

  const KEY_CODES = {
    Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
  };

  function dispatchKey(el, key, modifiers = {}) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key,
      code: KEY_CODES[key] || (key.length === 1 ? `Key${key.toUpperCase()}` : key),
      ctrlKey: !!modifiers.ctrl,
      altKey: !!modifiers.alt,
      shiftKey: !!modifiers.shift,
      metaKey: !!modifiers.meta,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key.length === 1) el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function pressKey(args) {
    // Accepts "Enter", "Escape", "Control+a", "Shift+Tab", etc.
    const parts = String(args.key).split('+');
    const key = parts.pop();
    const modifiers = {
      ctrl: parts.some((p) => /^(ctrl|control)$/i.test(p)),
      alt: parts.some((p) => /^alt$/i.test(p)),
      shift: parts.some((p) => /^shift$/i.test(p)),
      meta: parts.some((p) => /^(meta|cmd|command)$/i.test(p)),
    };
    const el = document.activeElement || document.body;
    dispatchKey(el, key, modifiers);
    return { pressed: args.key };
  }

  function scrollPage(args) {
    const amount = args.amount ?? Math.round(window.innerHeight * 0.8);
    let target = window;
    if (args.ref) target = getRefElement(args.ref);
    const dx = args.direction === 'left' ? -amount : args.direction === 'right' ? amount : 0;
    const dy = args.direction === 'up' ? -amount : args.direction === 'down' || !args.direction ? amount : 0;
    if (target === window) window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    else target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return {
      scrolled: args.direction || 'down',
      scrollY: Math.round(window.scrollY),
      pageHeight: Math.round(document.documentElement.scrollHeight),
      viewportHeight: window.innerHeight,
    };
  }

  function readPage() {
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 60000);
    return { title: document.title, url: location.href, text };
  }

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__agent !== true) return;
    (async () => {
      switch (msg.name) {
        case 'snapshot':
          return { snapshot: buildSnapshot() };
        case 'read_page':
          return readPage();
        case 'click':
          if (msg.args.ref) return clickRef(msg.args.ref);
          if (msg.args.x != null && msg.args.y != null) return clickAt(msg.args.x, msg.args.y, msg.args);
          throw new Error('click requires a ref or x/y coordinates');
        case 'hover':
          return hoverTarget(msg.args);
        case 'type':
          return typeText(msg.args);
        case 'press_key':
          return pressKey(msg.args);
        case 'scroll':
          return scrollPage(msg.args);
        case 'ping':
          return { pong: true };
        default:
          throw new Error(`Unknown page command: ${msg.name}`);
      }
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  });
})();
