const DEFAULTS = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: '',
  toolsEnabled: true,
  visionEnabled: false,
  maxToolSteps: 0,
  flushOnNavigate: true,
  contextTokens: 32768,
  mcpPort: 8765,
};

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('baseUrl').value = s.baseUrl;
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('toolsEnabled').checked = s.toolsEnabled;
  $('visionEnabled').checked = s.visionEnabled;
  $('maxToolSteps').value = s.maxToolSteps;
  $('flushOnNavigate').checked = s.flushOnNavigate;
  $('contextTokens').value = s.contextTokens;
  $('mcpPort').value = s.mcpPort;
}

function setStatus(text, ok) {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    baseUrl: $('baseUrl').value.trim().replace(/\/$/, ''),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    toolsEnabled: $('toolsEnabled').checked,
    visionEnabled: $('visionEnabled').checked,
    maxToolSteps: Math.max(0, Number($('maxToolSteps').value) || 0),
    flushOnNavigate: $('flushOnNavigate').checked,
    contextTokens: Math.max(2048, Number($('contextTokens').value) || 32768),
    mcpPort: Number($('mcpPort').value) || 8765,
  });
  setStatus('Saved ✓', true);
  setTimeout(() => setStatus('', true), 2000);
});

$('test').addEventListener('click', async () => {
  const baseUrl = $('baseUrl').value.trim().replace(/\/$/, '');
  const apiKey = $('apiKey').value.trim();
  setStatus('Testing…', true);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.data || []).map((m) => m.id);
    const list = $('model-list');
    list.innerHTML = '';
    for (const id of models) {
      const opt = document.createElement('option');
      opt.value = id;
      list.appendChild(opt);
    }
    setStatus(`Connected ✓ — ${models.length} model(s) found${models.length ? ' (see model dropdown)' : ''}`, true);
  } catch (e) {
    setStatus(`Failed: ${e.message}. Is the server running and reachable?`, false);
  }
});

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('baseUrl').value = btn.dataset.url;
  });
});

load();
