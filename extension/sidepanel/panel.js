// Side panel chat (Mode 2): talks to any OpenAI-compatible local LLM
// (Ollama, LM Studio, vLLM, llama.cpp server, ...) with tool calling so the
// model can read and drive the current page.

const DEFAULTS = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: '',
  toolsEnabled: true,
  visionEnabled: false,
  maxToolSteps: 30,
  contextTokens: 32768,
};

let settings = { ...DEFAULTS };
let messages = []; // OpenAI-format conversation (system prompt injected at send time)
let transcript = []; // what's rendered on screen: {kind, text}
let pendingScreenshot = null;
let busy = false;

// Chat survives panel/extension reloads for the life of the browser session.
function saveChat() {
  chrome.storage.session.set({ chat: { messages, transcript } }).catch(() => {});
}

async function restoreChat() {
  try {
    const { chat } = await chrome.storage.session.get('chat');
    if (!chat?.transcript?.length) return;
    messages = chat.messages || [];
    transcript = chat.transcript;
    document.getElementById('empty-state')?.remove();
    for (const item of transcript) {
      if (item.kind === 'toolline') renderToolLine(item.text);
      else renderBubble(item.kind, item.text);
    }
  } catch {
    /* storage unavailable — start fresh */
  }
}

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

function renderBubble(role, text) {
  $('empty-state')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = renderMarkdownLite(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addBubble(role, text) {
  transcript.push({ kind: role, text });
  saveChat();
  return renderBubble(role, text);
}

function renderToolLine(text) {
  $('empty-state')?.remove();
  const div = document.createElement('div');
  div.className = 'tool-line';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addToolLine(name, args) {
  const argStr = JSON.stringify(args || {});
  const line = `⚙ ${name} ${argStr === '{}' ? '' : argStr.slice(0, 120)}`;
  transcript.push({ kind: 'toolline', text: line });
  saveChat();
  renderToolLine(line);
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
    ? 'You have tools to read the page, take snapshots, click, type, scroll, and navigate. Use page_snapshot to find element refs before clicking or typing. ALWAYS click form controls (radio buttons, checkboxes, dropdowns, links, buttons) by ref from page_snapshot — never by x/y coordinates; refs cannot miss, coordinates can. Use x/y only for elements that genuinely do not appear in the snapshot. After clicking or submitting, take a fresh page_snapshot — old refs go stale. Prefer acting over asking when the request is clear. Be economical: never repeat a tool call with the same arguments, prefer page_snapshot over screenshot, and once you have what you need, stop calling tools and answer the user.'
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

const MAX_TOOL_RESULT_CHARS = 30000;

// ---------------------------------------------------------------------------
// Sliding-window context management
// ---------------------------------------------------------------------------
// Long automations would otherwise fill the model's context window. Before
// every request we build a pruned view: old tool results get truncated, stale
// screenshots dropped, and if still over budget, the oldest step-groups are
// evicted — always keeping the first user message (the task itself).
// `messages` keeps full history; pruning is per-request only.

const msgSize = (m) =>
  (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length) + 40;

// Group an assistant tool_calls message with its tool replies (and any
// injected screenshot message) so eviction never orphans half a pair.
function groupMessages(msgs) {
  const groups = [];
  let i = 0;
  while (i < msgs.length) {
    if (msgs[i].role === 'assistant' && msgs[i].tool_calls?.length) {
      const g = [msgs[i++]];
      while (i < msgs.length && msgs[i].role === 'tool') g.push(msgs[i++]);
      while (i < msgs.length && msgs[i].role === 'user' && Array.isArray(msgs[i].content)) g.push(msgs[i++]);
      groups.push(g);
    } else {
      groups.push([msgs[i++]]);
    }
  }
  return groups;
}

function pruneForContext(msgs, maxChars) {
  const gsize = (g) => g.reduce((s, m) => s + msgSize(m), 0);
  let groups = groupMessages(msgs);
  let total = groups.reduce((s, g) => s + gsize(g), 0);
  if (total <= maxChars) return msgs;

  // Pass 1: shrink bulky tool results and drop screenshots outside the last 3 groups.
  for (let i = 0; i < groups.length - 3 && total > maxChars; i++) {
    groups[i] = groups[i].map((m) => {
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 600) {
        total -= m.content.length - 620;
        return { ...m, content: m.content.slice(0, 600) + '\n…[older tool result trimmed]' };
      }
      if (m.role === 'user' && Array.isArray(m.content)) {
        total -= msgSize(m) - 80;
        return { role: 'user', content: '(an older screenshot was removed to save context)' };
      }
      return m;
    });
  }
  if (total <= maxChars) return groups.flat();

  // Pass 2: evict oldest groups, keeping the first user message (the task).
  const firstUserIdx = groups.findIndex((g) => g[0].role === 'user');
  const head = firstUserIdx >= 0 ? groups[firstUserIdx] : [];
  let budget = maxChars - gsize(head) - 120;
  const tail = [];
  let keptFrom = groups.length;
  for (let i = groups.length - 1; i > firstUserIdx; i--) {
    const s = gsize(groups[i]);
    if (budget - s < 0 && tail.length) break;
    budget -= s;
    tail.unshift(...groups[i]);
    keptFrom = i;
  }
  const droppedGroups = keptFrom - firstUserIdx - 1;
  const notice =
    droppedGroups > 0
      ? [{ role: 'user', content: `(context note: ${droppedGroups} earlier steps were removed from view to fit the context window — the original task above still applies, continue from the latest state)` }]
      : [];
  return [...head, ...notice, ...tail];
}

function contextBudgetChars() {
  return (Number(settings.contextTokens) || 32768) * 3;
}

// Reasoning models (Qwen3, DeepSeek-R1, ...) return their chain of thought in
// reasoning_content / reasoning, or inline <think> tags — sometimes with an
// empty final answer. Separate the two so we never show a blank turn, and
// never resend bulky thinking text back to the model.
function extractContent(msg) {
  let content = typeof msg.content === 'string' ? msg.content : '';
  let reasoning = msg.reasoning_content || msg.reasoning || '';
  if (content.includes('<think>')) {
    const inline = content.match(/<think>([\s\S]*?)(<\/think>|$)/);
    if (inline) reasoning = reasoning || inline[1].trim();
    content = content.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  }
  return { content: content.trim(), reasoning: String(reasoning).trim() };
}

// Repeating these with identical args is normal (scrolling through a long
// page, pressing ArrowDown) — exempt from loop cutoff.
const LOOP_EXEMPT_TOOLS = new Set(['scroll', 'press_key']);

async function chatTurn() {
  const system = { role: 'system', content: await buildSystemPrompt() };
  const callCounts = new Map(); // "tool:args" -> times called this turn
  const maxSteps = Number(settings.maxToolSteps) || 30;

  for (let i = 0; i < maxSteps; i++) {
    const body = { model: settings.model, messages: [system, ...pruneForContext(messages, contextBudgetChars())] };
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
    const { content, reasoning } = extractContent(msg);
    // Store only the clean answer: strict servers reject null content, and
    // resending <think> blocks burns context for nothing.
    messages.push({ ...msg, content, reasoning_content: undefined, reasoning: undefined });

    if (msg.tool_calls?.length) {
      // Show interim commentary the model produced alongside its tool calls.
      if (content) addBubble('assistant', content);

      let looping = false;
      for (const tc of msg.tool_calls) {
        const sig = `${tc.function.name}:${tc.function.arguments || ''}`;
        const count = LOOP_EXEMPT_TOOLS.has(tc.function.name) ? 0 : (callCounts.get(sig) || 0) + 1;
        callCounts.set(sig, count);
        if (count > 2) {
          // Same tool, same args, third time: cut it off.
          looping = true;
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content:
              'You already called this tool with these exact arguments — the result is above. Stop calling tools and answer the user now with what you have.',
          });
          continue;
        }
        const result = await runTool(tc);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result.text.slice(0, MAX_TOOL_RESULT_CHARS) });
        if (result.imageDataUrl) {
          // Only the newest screenshot stays in history — older ones are
          // huge and describe stale page states.
          for (let j = 0; j < messages.length; j++) {
            if (messages[j].role === 'user' && Array.isArray(messages[j].content)) {
              messages[j] = { role: 'user', content: '(an older screenshot was removed to save context)' };
            }
          }
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: '(screenshot of the current page)' },
              { type: 'image_url', image_url: { url: result.imageDataUrl } },
            ],
          });
        }
      }
      if (looping) return finishWithoutTools(system);
      continue;
    }
    if (content) {
      addBubble('assistant', content);
    } else if (reasoning) {
      // The model thought but never answered (usually a context-length or
      // max-tokens limit on the server). Show the tail of its reasoning so
      // the turn isn't lost.
      addBubble('assistant', `*(the model ran out of room mid-thought — its last reasoning below)*\n\n${reasoning.slice(-1200)}`);
      addBubble('error', 'Tip: this usually means the server\'s context window or max output tokens is too small. For Ollama, set OLLAMA_CONTEXT_LENGTH=32768 (or set num_ctx on the model). For LM Studio, raise the context length when loading the model.');
    } else {
      addBubble('error', 'The model returned an empty response. Check the server logs — this is usually a context-length limit or a template issue with tool calling.');
    }
    return;
  }
  // Iteration cap reached: force a final text answer instead of erroring.
  return finishWithoutTools(system);
}

// One last request with tools stripped, so the model must respond in text.
async function finishWithoutTools(system) {
  messages.push({
    role: 'user',
    content: '(system: tool budget exhausted — summarize what you found and what, if anything, is still unknown)',
  });
  setThinking(true);
  let msg;
  try {
    msg = await callLLM({ model: settings.model, messages: [system, ...pruneForContext(messages, contextBudgetChars())] });
  } finally {
    setThinking(false);
  }
  const { content, reasoning } = extractContent(msg);
  messages.push({ ...msg, content, reasoning_content: undefined, reasoning: undefined });
  addBubble('assistant', content || (reasoning ? `*(reasoning only)*\n\n${reasoning.slice(-1200)}` : '(no response)'));
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
    saveChat();
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
  transcript = [];
  chrome.storage.session.remove('chat').catch(() => {});
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
restoreChat();
refreshBridgeDot();
setInterval(refreshBridgeDot, 5000);
