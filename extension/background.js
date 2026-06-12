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

async function sendToContent(tabId, name, args) {
  const message = { __agent: true, name, args };
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script not present (page loaded before install, etc.) — inject and retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    res = await chrome.tabs.sendMessage(tabId, message);
  }
  if (!res) throw new Error('No response from page');
  if (!res.ok) throw new Error(res.error || 'Page action failed');
  return res.data;
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

async function handleCommand(name, args) {
  switch (name) {
    case 'screenshot': {
      const tab = await getActiveTab();
      const format = args.format === 'png' ? 'png' : 'jpeg';
      const opts = format === 'png' ? { format } : { format, quality: args.quality ?? 80 };
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
      return { dataUrl, url: tab.url, title: tab.title };
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

    // Everything else runs inside the page via the content script.
    case 'snapshot':
    case 'read_page':
    case 'click':
    case 'hover':
    case 'type':
    case 'press_key':
    case 'scroll': {
      const tab = await getActiveTab();
      assertScriptable(tab);
      return await sendToContent(tab.id, name, args);
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
