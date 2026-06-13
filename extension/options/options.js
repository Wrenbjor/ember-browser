const DEFAULTS = {
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: '',
  modelLarge: '',
  modelSmall: '',
  modelVision: '',
  primaryModel: 'large',
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
  // Migrate a pre-router single-model config into the large slot.
  $('modelLarge').value = s.modelLarge || s.model || '';
  $('modelSmall').value = s.modelSmall;
  $('modelVision').value = s.modelVision;
  $('primaryModel').value = s.primaryModel;
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
  const large = $('modelLarge').value.trim();
  await chrome.storage.sync.set({
    baseUrl: $('baseUrl').value.trim().replace(/\/$/, ''),
    apiKey: $('apiKey').value.trim(),
    model: large, // keep legacy field in sync for any old reader
    modelLarge: large,
    modelSmall: $('modelSmall').value.trim(),
    modelVision: $('modelVision').value.trim(),
    primaryModel: $('primaryModel').value,
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
    // Auto-fill empty role slots by guessing from model id keywords.
    const find = (re) => models.find((m) => re.test(m));
    if (!$('modelVision').value) {
      const v = find(/(vl|vision|llava|multimodal|-mm)/i);
      if (v) $('modelVision').value = v;
    }
    if (!$('modelLarge').value) {
      const big = find(/(70b|49b|65b|72b|large|nemotron|llama)/i) || models[0];
      if (big) $('modelLarge').value = big;
    }
    if (!$('modelSmall').value) {
      const small = find(/(mini|small|3b|7b|8b|20b|oss)/i);
      if (small) $('modelSmall').value = small;
    }
    setStatus(`Connected ✓ — ${models.length} model(s): ${models.join(', ').slice(0, 80)}. Role slots auto-filled where empty; adjust as needed, then Save.`, true);
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
