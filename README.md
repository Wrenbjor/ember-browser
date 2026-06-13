# Ember Browser Agent

A local browser agent in two parts:

- **`extension/`** — Chrome (Manifest V3) extension. Reads pages, clicks, types, scrolls, and screenshots — with a visible animated cursor so you can watch what the AI is doing. Includes a side-panel chat UI wired to your own local LLM.
- **`mcp-server/`** — Local MCP server (stdio) that bridges to the extension over a localhost WebSocket. Point any MCP client (Claude Code, Gemini CLI, …) at it and it drives your **real browser session** — your logins, your cookies, no Playwright, no separate profile.

## Two modes

| Mode | What | How |
|------|------|-----|
| **1 — MCP** | External AI (Claude, Gemini, …) controls your browser via `browser_*` tools | MCP client → `mcp-server` (stdio) → WebSocket → extension |
| **2 — Chat** | Side-panel assistant with direct access to the page you're on | Side panel → your local LLM (OpenAI-compatible API) with tool calling |

Both modes share the same browser command engine, so capabilities are identical.

## Setup

### 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Click the puzzle-piece icon and pin **Ember Browser Agent**

Clicking the extension icon opens the side panel.

### 2. Mode 2 — local LLM chat

1. Open the extension's **Settings** (⚙ in the side panel, or right-click icon → Options)
2. Pick a preset (Ollama / LM Studio / vLLM / llama.cpp) or enter any OpenAI-compatible base URL — a single model server **or** a router/proxy like LiteLLM that fronts several models
3. Click **Test connection** to verify and list available models (empty role slots are auto-filled by guessing from model ids)
4. Fill the model role slots and **Save**

**Model roles** (all share one base URL — ideal with a LiteLLM-style router):
- **Large model** — primary reasoning and tool calling (e.g. `nemotron-super-49b`).
- **Small model** — optional, faster model you can make primary for simple turns (e.g. `gpt-oss-20b`).
- **Vision model** — image-bearing requests route here **automatically** (e.g. `qwen3-vl-30b`). This keeps screenshots away from text-only models, which otherwise crash on image input. The side panel shows a `↗ model:` line whenever routing switches.
- **Primary text model** — choose whether Large or Small drives the chat.

Only one model is required; leave the others blank to run single-model.

Options:
- **Tool calling** — lets the model click/type/navigate. Needs a tool-capable model. If your model doesn't support tools, turn this off — page text is then included automatically with each message.
- **Vision** — enables screenshots; they're sent to the Vision model above. Needs a vision-capable model.

> Ollama note: run `OLLAMA_ORIGINS="*" ollama serve` if you get CORS/403 errors.

### 3. Mode 1 — MCP for external AIs

Start the bridge server (keep it running; it's also fine to let the MCP client launch it on demand):

```bash
cd mcp-server
npm install   # first time only
```

The extension auto-connects to the bridge within ~30 seconds (badge shows **MCP** when connected; the dot in the side panel header turns green).

**Claude Code:**

```bash
claude mcp add ember-browser -- node /home/wrenbjor/code/ember-browser/mcp-server/server.js
```

**Gemini CLI** (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "ember-browser": {
      "command": "node",
      "args": ["/home/wrenbjor/code/ember-browser/mcp-server/server.js"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`): same `command`/`args` shape.

Custom port: set `BROWSER_MCP_PORT=9000` on the server **and** change the port in extension Settings.

## MCP tools

`browser_screenshot` · `browser_snapshot` (interactive elements with ref ids) · `browser_read_page` · `browser_navigate` · `browser_go_back` / `browser_go_forward` / `browser_reload` · `browser_get_url` · `browser_click` (ref or x/y) · `browser_hover` · `browser_type` · `browser_press_key` · `browser_scroll` · `browser_tabs` / `browser_select_tab` / `browser_new_tab` / `browser_close_tab` · `browser_wait`

Typical agent flow: `browser_snapshot` → find a ref → `browser_click {ref: "e12"}` → `browser_snapshot` again.

## How it works

```
MCP client (Claude Code, Gemini…)        Local LLM (Ollama, LM Studio…)
        │ stdio (MCP)                            │ HTTP (OpenAI API)
        ▼                                        ▼
  mcp-server/server.js                   side panel chat UI
        │ ws://127.0.0.1:8765/extension          │ chrome.runtime messages
        └────────────► background.js ◄───────────┘
                            │ chrome.tabs / chrome.scripting
                            ▼
                       content.js  (snapshot, click, type, cursor overlay)
```

## Limitations (v1)

- Synthetic input events: clicks/keys are dispatched as DOM events, not OS-level trusted input. Works on the vast majority of sites; a few (and browser-native UI like `chrome://` pages, PDF viewer, Web Store) won't respond.
- One extension connection per bridge server; one MCP client at a time is the intended use.
- Chat responses are non-streaming in v1.
- Chrome/Chromium/Brave/Edge only (MV3). No Firefox port yet.

## Security notes

- The bridge binds to `127.0.0.1` only — nothing is exposed to your network.
- Anything connected via MCP can act **as you** in your logged-in browser. Only connect AI clients you trust, and watch the cursor.
