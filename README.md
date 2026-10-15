# Laya MCP Server & Policy Engine

This repository provides a complete, self-contained local AI system for evaluating policies, scoring data, and securing autonomous agent actions using the **Laya Decision Model** (ONNX).

It features a dual-layer architecture:
1. **Python Policy Engine (`laya_runtime`)**: An incredibly fast FastAPI backend that runs the 421M parameter Laya ONNX graph via `onnxruntime`.
2. **TypeScript MCP Server (`laya-mcp`)**: A Model Context Protocol server that intercepts agent actions (file ops, commands) for security checks, and exposes tree-sitter codebase analysis and active decision tools.

---

## ⚡ Quickstart (One-Command Setup)

To automatically provision the Python environment, download model weights (~1.7GB), compile the TypeScript MCP server, register your installed AI harnesses, and run verification:

```bash
git clone https://github.com/Hypokoto/laya-mcp.git
cd laya-mcp
./install.sh
```

---

## 🛠 Manual Installation & Model Download

### 1. Download Model Weights (~1.7GB)

The recommended, fastest method to download the complete model bundle is via the official **Hugging Face CLI** (`hf`):

```bash
# Recommended: Fast multi-threaded download via Hugging Face CLI
hf download receptron/laya-onnx --local-dir .
```
*(If targeting a separate directory, specify e.g. `--local-dir ~/dev/Models/laya-onnx`)*

#### Alternative: Download via `curl`
```bash
# Model graph and fp32 weights
curl -L -C - -o laya.onnx https://huggingface.co/receptron/laya-onnx/resolve/main/laya.onnx
curl -L -C - -o laya.onnx.data https://huggingface.co/receptron/laya-onnx/resolve/main/laya.onnx.data

# Tokenizer files
mkdir -p tokenizer
curl -L -C - -o tokenizer/tokenizer.json https://huggingface.co/receptron/laya-onnx/resolve/main/tokenizer/tokenizer.json
curl -L -C - -o tokenizer/tokenizer_config.json https://huggingface.co/receptron/laya-onnx/resolve/main/tokenizer/tokenizer_config.json
```

*Note: The model files are approximately 1.7GB and are ignored by Git.*

### 2. Environment Setup

```bash
# Provision Python runtime (FastAPI + ONNX Runtime)
uv sync
# Or with standard python venv:
# python3 -m venv .venv && source .venv/bin/activate && pip install fastapi uvicorn pydantic transformers onnxruntime numpy

# Build TypeScript MCP Server
cd laya-mcp
npm install
npm run build
cd ..
```

---

## 3. Usage (AI Harnesses)

The MCP Server is completely self-contained. You do not need to manually manage the Python backend—when an AI harness connects via stdio, `laya-mcp` automatically spins up the Python engine in the background.

### Auto-Configure AI Harnesses
```bash
cd laya-mcp
npm run setup
```
This automatically registers Laya in detected installations of:
- **Cursor IDE** (`~/.cursor/mcp.json`)
- **Claude Desktop** (`claude_desktop_config.json`)
- **Claude Code CLI** (`~/.claude/mcp.json`)
- **Windsurf** (`~/.codeium/windsurf/mcp_config.json`)
- **Cline / Roo Code** (`cline_mcp_settings.json`)
- **Continue.dev** (`~/.continue/config.json`)
- **Antigravity** (`.mcp.json`)

### Alternative: Local Network Access (SSE)

To expose the system to multiple AI harnesses on your local Wi-Fi without configuring complex commands:

```bash
./start_local.sh
```
Connect your harness to:
- **Transport:** SSE
- **URL:** `http://<your-machine-ip>:3000/sse`

### Alternative: Internet Access (Localtunnel)

```bash
./start_remote.sh
```

---

## 4. Hardcoded Harness Interceptor (PreToolUse Hook)

Want Laya to actively guard your AI agents *before* any command executes, without relying on the model remembering to call an MCP tool?

Laya includes a universal **PreToolUse decision hook** (`hooks/laya-pretool-hook.js`) compatible with Antigravity, Cursor, and Claude Code:

- **0ms Fast-Path:** Non-mutating tools (`view_file`, `grep`, `search_web`, `read_url_content`, etc.) pass through immediately with zero overhead.
- **Pre-Execution Guardrails:** Mutating commands (`run_command`, `Bash`, `write_to_file`, `replace_file_content`, `Edit`) are intercepted before execution and evaluated against the Laya ONNX decision model.
- **Hard Block Policy:** Destructive commands (e.g. `rm -rf /`, out-of-boundary file writes) exit with code `2`, relaying structured denial reasons directly to the agent while preventing command execution dead in its tracks.

### Install or Uninstall Hook
```bash
cd laya-mcp
npm run hook:install     # Registers hook in Antigravity and Cursor
npm run hook:uninstall   # Safely unregisters hook
npm run test:hook        # Runs automated hook test suite
```

---

## 5. Skills

This repository includes three pre-audited Markdown skills (`skills/`) that teach your AI how to use this MCP server:
- `skills/laya-decision-model`: How to formulate active decisions (`laya_decide`).
- `skills/laya-security-policy`: How to gracefully handle Laya `DENY` security blocks.
- `skills/laya-code-analysis`: How to use the `laya_analyze_code` tree-sitter tools.

To link them into your global agent skill directories:
```bash
ln -sfn $(pwd)/skills/laya-decision-model ~/.gemini/config/skills/laya-decision-model
ln -sfn $(pwd)/skills/laya-security-policy ~/.gemini/config/skills/laya-security-policy
ln -sfn $(pwd)/skills/laya-code-analysis ~/.gemini/config/skills/laya-code-analysis
```

---

## 6. Automated Verification

Run the full handshake, 10-question evaluation, and hook test suites:

```bash
cd laya-mcp
npm test
```
