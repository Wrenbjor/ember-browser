// Background service worker.
// 1. Maintains a WebSocket connection to the local MCP bridge server (Mode 1).
// 2. Routes commands (from the bridge OR the side panel) to the browser / content script.

const DEFAULTS = { mcpPort: 8765 };
const RESTRICTED_URL = /^(chrome|chrome-extension|edge|brave|about|devtools|view-source):/;

let ws = null;
let wsConnected = false;

// ---------------------------------------------------------------------------
// WebSocket bridge to the local MCP server
// ---------------------------------------------------------------------------

async function connectBridge() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { mcpPort } = await chrome.storage.sync.get(DEFAULTS);
  try {
    ws = new WebSocket(`ws://127.0.0.1:${mcpPort}/extension`);
  } catch (e) {
    ws = null;
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    setBadge(true);
  };

  ws.onclose = () => {
    wsConnected = false;
    ws = null;
    setBadge(false);
    setTimeout(connectBridge, 3000);
  };

  ws.onerror = () => {
    /* onclose fires next; reconnect handled there */
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      ws?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (msg.type !== 'command') return;
    let reply;
    try {
      const data = await handleCommand(msg.name, msg.args || {});
      reply = { type: 'result', id: msg.id, ok: true, data };
    } catch (e) {
      reply = { type: 'result', id: msg.id, ok: false, error: String(e?.message || e) };
    }
    try {
      ws?.send(JSON.stringify(reply));
    } catch {
      /* socket died mid-command */
    }
  };
}

function setBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? 'MCP' : '' });
  if (connected) chrome.action.setBadgeBackgroundColor({ color: '#e8743b' });
}

// Alarms revive the service worker if Chrome puts it to sleep.
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-keepalive') connectBridge();
});
chrome.runtime.onStartup.addListener(connectBridge);
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  connectBridge();
});
connectBridge();

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function getActiveTab() {
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true });
  if (!tab) throw new Error('No active tab found');
  return tab;
}

function assertScriptable(tab) {
  if (!tab.url || RESTRICTED_URL.test(tab.url)) {
    throw new Error(`Cannot operate on restricted page: ${tab.url || '(unknown)'}. Navigate to a normal web page first.`);
  }
}

async function sendToContent(tabId, name, args, frameId = 0) {
  const message = { __agent: true, name, args };
  const options = { frameId };
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    // Content script not present (page loaded before install, etc.) — inject and retry.
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content.js'] });
    res = await chrome.tabs.sendMessage(tabId, message, options);
  }
  if (!res) throw new Error('No response from page');
  if (!res.ok) throw new Error(res.error || 'Page action failed');
  return res.data;
}

// Survey sites and many web apps render the real content inside cross-origin
// iframes — enumerate every frame we can reach so snapshots and actions see
// inside them. Refs from non-top frames are prefixed (f123_e4) and routed back
// to their frame automatically.
const MAX_FRAMES = 12;

async function listFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => location.href,
    });
    const frames = results
      .filter((r) => r.frameId != null)
      .map((r) => ({ frameId: r.frameId, url: r.result }));
    frames.sort((a, b) => a.frameId - b.frameId); // top frame (0) first
    return frames.length ? frames : [{ frameId: 0, url: null }];
  } catch {
    return [{ frameId: 0, url: null }];
  }
}

function frameIdForRef(ref) {
  const m = /^f(\d+)_/.exec(ref || '');
  return m ? Number(m[1]) : 0;
}

function waitForLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') done();
    }
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function normalizeScreenshot(dataUrl, viewport, format) {
  if (!viewport?.width) return dataUrl;
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = bitmap.width / viewport.width;
  if (Math.abs(scale - 1) <= 0.02) return dataUrl;
  const canvas = new OffscreenCanvas(viewport.width, viewport.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, viewport.width, viewport.height);
  const out = await canvas.convertToBlob(
    format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.8 }
  );
  const bytes = new Uint8Array(await out.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${out.type};base64,${btoa(binary)}`;
}

async function handleCommand(name, args) {
  switch (name) {
    case 'screenshot': {
      const tab = await getActiveTab();
      const format = args.format === 'png' ? 'png' : 'jpeg';
      const opts = format === 'png' ? { format } : { format, quality: args.quality ?? 80 };
      let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
      // captureVisibleTab returns physical pixels; clicks use CSS pixels.
      // Downscale so image coordinates map 1:1 to click x/y (handles display
      // scaling and page zoom).
      let viewport = null;
      try {
        viewport = await sendToContent(tab.id, 'viewport', {});
        dataUrl = await normalizeScreenshot(dataUrl, viewport, format);
      } catch {
        /* restricted page — return the raw capture */
      }
      return { dataUrl, url: tab.url, title: tab.title, width: viewport?.width, height: viewport?.height };
    }

    case 'navigate': {
      if (!args.url) throw new Error('url is required');
      const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`;
      const tab = await getActiveTab();
      await chrome.tabs.update(tab.id, { url });
      await waitForLoad(tab.id);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title };
    }

    case 'go_back': {
      const tab = await getActiveTab();
      await chrome.tabs.goBack(tab.id);
      await waitForLoad(tab.id, 10000);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title };
    }

    case 'go_forward': {
      const tab = await getActiveTab();
      await chrome.tabs.goForward(tab.id);
      await waitForLoad(tab.id, 10000);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title };
    }

    case 'reload': {
      const tab = await getActiveTab();
      await chrome.tabs.reload(tab.id);
      await waitForLoad(tab.id);
      return { url: tab.url };
    }

    case 'get_url': {
      const tab = await getActiveTab();
      return { url: tab.url, title: tab.title };
    }

    case 'tabs_list': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return {
        tabs: tabs.map((t, i) => ({
          index: i,
          id: t.id,
          active: t.active,
          title: t.title,
          url: t.url,
        })),
      };
    }

    case 'tab_select': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const tab = args.id != null ? tabs.find((t) => t.id === args.id) : tabs[args.index];
      if (!tab) throw new Error('Tab not found');
      await chrome.tabs.update(tab.id, { active: true });
      return { url: tab.url, title: tab.title };
    }

    case 'tab_new': {
      const tab = await chrome.tabs.create({ url: args.url || 'about:blank' });
      if (args.url) await waitForLoad(tab.id);
      const updated = await chrome.tabs.get(tab.id);
      return { url: updated.url, title: updated.title };
    }

    case 'tab_close': {
      const tab = await getActiveTab();
      await chrome.tabs.remove(tab.id);
      return { closed: true };
    }

    case 'wait': {
      const seconds = Math.min(args.seconds ?? 1, 30);
      await sleep(seconds * 1000);
      return { waited: seconds };
    }

    case 'snapshot': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      const frames = await listFrames(tab.id);
      const parts = [];
      let total = 0;
      for (const f of frames.slice(0, MAX_FRAMES)) {
        const prefix = f.frameId === 0 ? '' : `f${f.frameId}_`;
        try {
          const { snapshot, count } = await sendToContent(tab.id, 'snapshot', { refPrefix: prefix }, f.frameId);
          if (f.frameId === 0) {
            parts.unshift(snapshot);
            total += count;
          } else if (count > 0) {
            parts.push(`--- iframe (${f.url || 'embedded frame'}) — refs prefixed "${prefix}", use them exactly like top-frame refs ---\n${snapshot}`);
            total += count;
          }
        } catch {
          /* frame not reachable (sandboxed, navigating, etc.) */
        }
      }
      if (total === 0) {
        parts.push('No interactive elements found in any frame. The content may still be loading — try browser_wait then snapshot again.');
      }
      return { snapshot: parts.join('\n\n'), count: total };
    }

    case 'read_page': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      const frames = await listFrames(tab.id);
      let main = null;
      const extras = [];
      for (const f of frames.slice(0, MAX_FRAMES)) {
        try {
          const data = await sendToContent(tab.id, 'read_page', {}, f.frameId);
          if (f.frameId === 0) main = data;
          else if (data.text && data.text.trim().length > 40) {
            extras.push(`--- iframe content (${data.url}) ---\n${data.text}`);
          }
        } catch {
          /* frame not reachable */
        }
      }
      if (!main) main = { title: tab.title, url: tab.url, text: '' };
      if (extras.length) main.text = `${main.text}\n\n${extras.join('\n\n')}`.slice(0, 60000);
      return main;
    }

    // Page actions: refs carry their frame (f123_e4); everything else hits the top frame.
    case 'click':
    case 'hover':
    case 'type':
    case 'press_key':
    case 'scroll': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      return await sendToContent(tab.id, name, args, frameIdForRef(args?.ref));
    }

    case 'bridge_status':
      return { connected: wsConnected };

    default:
      throw new Error(`Unknown command: ${name}`);
  }
}

// Side panel (Mode 2) uses the same command set via runtime messaging.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__panelCommand) return;
  handleCommand(msg.__panelCommand, msg.args || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
