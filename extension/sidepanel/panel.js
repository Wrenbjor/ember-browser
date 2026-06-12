// Side panel chat (Mode 2): talks to any OpenAI-compatible local LLM
// (Ollama, LM Studio, vLLM, llama.cpp server, ...) with tool calling so the
// model can read and drive the current page.

const DEFAULTS = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: '',
  toolsEnabled: true,
  visionEnabled: false,
};

let settings = { ...DEFAULTS };
let messages = []; // OpenAI-format conversation (system prompt injected at send time)
let pendingScreenshot = null;
let busy = false;

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send-btn');

// ---------------------------------------------------------------------------
// Tools exposed to the local LLM
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'read_page',
    description: 'Read the visible text content of the current page (title, URL, body text).',
    parameters: { type: 'object', properties: {} },
    command: 'read_page',
  },
  {
    name: 'page_snapshot',
    description:
      'Get a structured snapshot of the current page: headings plus all interactive elements with ref ids (e1, e2, ...) used by click/type tools.',
    parameters: { type: 'object', properties: {} },
    command: 'snapshot',
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the visible part of the current tab. Only useful if vision is enabled in settings.',
    parameters: { type: 'object', properties: {} },
    command: 'screenshot',
  },
  {
    name: 'click',
    description: 'Click an element by ref id (from page_snapshot) or by viewport x/y coordinates.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref id like "e12"' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
    },
    command: 'click',
  },
  {
    name: 'type_text',
    description: 'Type text into an input. Pass ref from page_snapshot, or omit to use the focused element. Set submit=true to press Enter after.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['text'],
    },
    command: 'type',
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a".',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    command: 'press_key',
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down (default: down, ~one screen).',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels' },
      },
    },
    command: 'scroll',
  },
  {
    name: 'navigate',
    description: 'Navigate the current tab to a URL.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    command: 'navigate',
  },
  {
    name: 'list_tabs',
    description: 'List open tabs in this window.',
    parameters: { type: 'object', properties: {} },
    command: 'tabs_list',
  },
  {
    name: 'select_tab',
    description: 'Switch to a tab by its index from list_tabs.',
    parameters: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] },
    command: 'tab_select',
  },
];

function toolDefs() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function browserCommand(name, args = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ __panelCommand: name, args }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from extension'));
      if (!res.ok) return reject(new Error(res.error));
      resolve(res.data);
    });
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdownLite(text) {
  // Minimal: code blocks, inline code, bold. Everything else stays plain text.
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => `<pre><code>${code}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return html;
}

function addBubble(role, text) {
  $('empty-state')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = renderMarkdownLite(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addToolLine(name, args) {
  $('empty-state')?.remove();
  const div = document.createElement('div');
  div.className = 'tool-line';
  const argStr = JSON.stringify(args || {});
  div.textContent = `⚙ ${name} ${argStr === '{}' ? '' : argStr.slice(0, 120)}`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setThinking(on) {
  document.querySelector('.thinking')?.remove();
  if (on) {
    const div = document.createElement('div');
    div.className = 'thinking';
    div.textContent = 'thinking';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

async function buildSystemPrompt() {
  let pageInfo = '';
  try {
    const { url, title } = await browserCommand('get_url');
    pageInfo = `\nThe user is currently on: "${title}" (${url})`;
  } catch {
    /* no active tab info available */
  }
  const toolNote = settings.toolsEnabled
    ? 'You have tools to read the page, take snapshots, click, type, scroll, and navigate. Use page_snapshot to find element refs before clicking or typing. Prefer acting over asking when the request is clear.'
    : 'Tool use is disabled; page text is included with the user message when available.';
  return (
    'You are Ember, a browser assistant running in a Chrome side panel with access to the user\'s current browser session. ' +
    'Be direct and concise. ' +
    toolNote +
    pageInfo
  );
}

async function callLLM(body) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const res = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM error ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('LLM returned no message');
  return msg;
}

async function runTool(toolCall) {
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    /* some models emit malformed JSON args; run with empty args */
  }
  const tool = TOOLS.find((t) => t.name === toolCall.function.name);
  if (!tool) return { text: `Unknown tool: ${toolCall.function.name}` };
  addToolLine(tool.name, args);
  try {
    const data = await browserCommand(tool.command, args);
    if (tool.name === 'screenshot') {
      if (!settings.visionEnabled) {
        return { text: 'Screenshot taken, but vision is disabled in settings — use read_page or page_snapshot instead.' };
      }
      return { text: 'Screenshot captured; it is attached as the next message.', imageDataUrl: data.dataUrl };
    }
    if (tool.name === 'read_page') return { text: `Title: ${data.title}\nURL: ${data.url}\n\n${data.text}` };
    if (tool.name === 'page_snapshot') return { text: data.snapshot };
    return { text: JSON.stringify(data) };
  } catch (e) {
    return { text: `Error: ${e.message}` };
  }
}

async function chatTurn() {
  const system = { role: 'system', content: await buildSystemPrompt() };
  for (let i = 0; i < 12; i++) {
    const body = { model: settings.model, messages: [system, ...messages] };
    if (settings.toolsEnabled) {
      body.tools = toolDefs();
      body.tool_choice = 'auto';
    }
    setThinking(true);
    let msg;
    try {
      msg = await callLLM(body);
    } finally {
      setThinking(false);
    }
    messages.push(msg);

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const result = await runTool(tc);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.text });
        if (result.imageDataUrl) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: '(screenshot of the current page)' },
              { type: 'image_url', image_url: { url: result.imageDataUrl } },
            ],
          });
        }
      }
      continue;
    }
    if (msg.content) addBubble('assistant', msg.content);
    return;
  }
  addBubble('error', 'Stopped after 12 tool iterations — the model may be stuck in a loop.');
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  if (!settings.model) {
    addBubble('error', 'No model configured. Open Settings (⚙) and set your endpoint and model.');
    return;
  }
  inputEl.value = '';
  busy = true;
  sendBtn.disabled = true;
  addBubble('user', text);

  if (pendingScreenshot && settings.visionEnabled) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: pendingScreenshot } },
      ],
    });
  } else if (!settings.toolsEnabled) {
    // Tools off: include the page text directly so the model still has context.
    let pageContext = '';
    try {
      const page = await browserCommand('read_page');
      pageContext = `\n\n[Current page: ${page.title} — ${page.url}]\n${page.text.slice(0, 20000)}`;
    } catch {
      /* restricted page or no tab */
    }
    messages.push({ role: 'user', content: text + pageContext });
  } else {
    messages.push({ role: 'user', content: text });
  }
  clearAttachment();

  try {
    await chatTurn();
  } catch (e) {
    addBubble('error', e.message);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ---------------------------------------------------------------------------
// Screenshot attachment
// ---------------------------------------------------------------------------

function clearAttachment() {
  pendingScreenshot = null;
  $('attach-indicator').classList.add('hidden');
}

$('attach-btn').addEventListener('click', async () => {
  try {
    const data = await browserCommand('screenshot');
    pendingScreenshot = data.dataUrl;
    $('attach-indicator').classList.remove('hidden');
    if (!settings.visionEnabled) {
      addBubble('error', 'Note: vision is disabled in settings — enable it for the model to see screenshots.');
    }
  } catch (e) {
    addBubble('error', `Screenshot failed: ${e.message}`);
  }
});
$('detach-btn').addEventListener('click', clearAttachment);

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

$('clear-btn').addEventListener('click', () => {
  messages = [];
  messagesEl.innerHTML = '';
  addBubble('assistant', 'New conversation started.');
});

$('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-settings-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function loadSettings() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  $('model-name').textContent = settings.model || 'no model set';
}

chrome.storage.onChanged.addListener(loadSettings);

async function refreshBridgeDot() {
  try {
    const { connected } = await browserCommand('bridge_status');
    $('bridge-dot').classList.toggle('on', connected);
    $('bridge-dot').title = connected ? 'MCP bridge: connected' : 'MCP bridge: not connected (start the mcp-server)';
  } catch {
    /* background not ready yet */
  }
}

loadSettings();
refreshBridgeDot();
setInterval(refreshBridgeDot, 5000);
