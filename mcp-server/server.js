#!/usr/bin/env node
// MCP server (stdio) <-> Chrome extension (WebSocket) bridge.
//
// MCP clients (Claude Code, Gemini CLI, etc.) connect to this process over
// stdio. Tool calls are relayed to the Ember Browser Agent extension over a
// localhost WebSocket, executed in your real browser session, and the results
// flow back. No Playwright, no separate browser profile — your actual browser.
//
// Usage:  node server.js          (BROWSER_MCP_PORT env var overrides port 8765)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.BROWSER_MCP_PORT || 8765);
const COMMAND_TIMEOUT_MS = 45000;

const log = (...args) => console.error('[ember-browser-mcp]', ...args); // stderr only; stdout is the MCP transport

// ---------------------------------------------------------------------------
// WebSocket side: the extension connects here
// ---------------------------------------------------------------------------

let extensionSocket = null;
const pending = new Map(); // id -> { resolve, reject, timer }

const wss = new WebSocketServer({ port: PORT, path: '/extension' });

wss.on('listening', () => log(`WebSocket bridge listening on ws://127.0.0.1:${PORT}/extension`));

wss.on('connection', (ws) => {
  if (extensionSocket) {
    log('New extension connection; replacing the old one');
    try { extensionSocket.close(); } catch { /* already dead */ }
  }
  extensionSocket = ws;
  log('Extension connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || 'Browser command failed'));
  });

  ws.on('close', () => {
    if (extensionSocket === ws) extensionSocket = null;
    log('Extension disconnected');
  });
});

wss.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use. Is another ember-browser-mcp running? Set BROWSER_MCP_PORT to change.`);
    process.exit(1);
  }
  log('WebSocket server error:', e.message);
});

// Application-level pings keep the extension service worker alive (Chrome 116+).
setInterval(() => {
  if (extensionSocket?.readyState === 1) {
    extensionSocket.send(JSON.stringify({ type: 'ping' }));
  }
}, 20000).unref();

function callBrowser(name, args = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      return reject(
        new Error(
          'Browser extension is not connected. Make sure Chrome is running with the Ember Browser Agent extension loaded, and that its bridge port matches this server.'
        )
      );
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser command "${name}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extensionSocket.send(JSON.stringify({ type: 'command', id, name, args }));
  });
}

// ---------------------------------------------------------------------------
// MCP side
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'ember-browser', version: '0.1.0' });

const text = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

function tool(name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
}

tool(
  'browser_screenshot',
  'Take a screenshot of the visible part of the active browser tab. Returns an image.',
  { format: z.enum(['jpeg', 'png']).optional().describe('Image format, default jpeg') },
  async (args) => {
    const { dataUrl, url, title } = await callBrowser('screenshot', args);
    const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error('Unexpected screenshot format');
    return {
      content: [
        { type: 'text', text: `Screenshot of "${title}" (${url})` },
        { type: 'image', data: match[2], mimeType: match[1] },
      ],
    };
  }
);

tool(
  'browser_snapshot',
  'Get a structured text snapshot of the active page: title, URL, headings, and all interactive elements with ref ids (e1, e2, ...). Use these refs with browser_click / browser_type. Prefer this over screenshots for finding things to interact with.',
  {},
  async () => text((await callBrowser('snapshot')).snapshot)
);

tool(
  'browser_read_page',
  'Read the visible text content of the active page (title, URL, body text).',
  {},
  async () => {
    const { title, url, text: body } = await callBrowser('read_page');
    return text(`Title: ${title}\nURL: ${url}\n\n${body}`);
  }
);

tool(
  'browser_navigate',
  'Navigate the active tab to a URL and wait for it to load.',
  { url: z.string().describe('URL to open') },
  async (args) => text(await callBrowser('navigate', args))
);

tool('browser_go_back', 'Go back in the active tab history.', {}, async () => text(await callBrowser('go_back')));
tool('browser_go_forward', 'Go forward in the active tab history.', {}, async () => text(await callBrowser('go_forward')));
tool('browser_reload', 'Reload the active tab.', {}, async () => text(await callBrowser('reload')));
tool('browser_get_url', 'Get the URL and title of the active tab.', {}, async () => text(await callBrowser('get_url')));

tool(
  'browser_click',
  'Click an element. Pass a ref id from browser_snapshot (preferred), or viewport x/y coordinates. A visible cursor animates to the target in the browser.',
  {
    ref: z.string().optional().describe('Element ref id from browser_snapshot, e.g. "e12"'),
    x: z.number().optional().describe('Viewport x coordinate'),
    y: z.number().optional().describe('Viewport y coordinate'),
  },
  async (args) => text(await callBrowser('click', args))
);

tool(
  'browser_hover',
  'Hover over an element by ref id or x/y coordinates (triggers menus, tooltips).',
  {
    ref: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
  async (args) => text(await callBrowser('hover', args))
);

tool(
  'browser_type',
  'Type text into an input or textarea. Pass a ref from browser_snapshot, or omit ref to type into the focused element. Replaces existing content unless clear=false.',
  {
    text: z.string().describe('Text to type'),
    ref: z.string().optional().describe('Element ref id from browser_snapshot'),
    submit: z.boolean().optional().describe('Press Enter / submit the form after typing'),
    clear: z.boolean().optional().describe('Set false to append instead of replace'),
  },
  async (args) => text(await callBrowser('type', args))
);

tool(
  'browser_press_key',
  'Press a keyboard key in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a".',
  { key: z.string() },
  async (args) => text(await callBrowser('press_key', args))
);

tool(
  'browser_scroll',
  'Scroll the page. Default: down by ~one screen. Returns scroll position and page height.',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().optional().describe('Pixels to scroll'),
  },
  async (args) => text(await callBrowser('scroll', args))
);

tool('browser_tabs', 'List open tabs in the current browser window.', {}, async () => text(await callBrowser('tabs_list')));

tool(
  'browser_select_tab',
  'Switch to a tab by its index from browser_tabs.',
  { index: z.number() },
  async (args) => text(await callBrowser('tab_select', args))
);

tool(
  'browser_new_tab',
  'Open a new tab, optionally at a URL.',
  { url: z.string().optional() },
  async (args) => text(await callBrowser('tab_new', args))
);

tool('browser_close_tab', 'Close the active tab.', {}, async () => text(await callBrowser('tab_close')));

tool(
  'browser_wait',
  'Wait a number of seconds (max 30) for the page to settle.',
  { seconds: z.number().min(0).max(30) },
  async (args) => text(await callBrowser('wait', args))
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log('MCP server ready on stdio');
