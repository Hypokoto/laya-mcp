# Laya MCP Server & Policy Engine

This repository provides a complete, self-contained local AI system for evaluating policies, scoring data, and securing autonomous agent actions using the **Laya Decision Model** (ONNX).

It features a dual-layer architecture:
1. **Python Policy Engine (`laya_runtime`)**: An incredibly fast FastAPI backend that runs the 400M parameter Laya ONNX graph via `onnxruntime`.
2. **TypeScript MCP Server (`laya-mcp`)**: A Model Context Protocol server that intercepts agent actions (file ops, commands) for security checks, and exposes tree-sitter codebase analysis and active decision tools.

## ⚡ Quickstart (One-Command Setup)

To automatically provision the Python environment, download model weights (~1.7GB), compile the TypeScript MCP server, register your installed AI harnesses, and run verification:

```bash
git clone https://github.com/Hypokoto/laya-mcp.git
cd laya-mcp
./install.sh
```

---

## 🛠 Manual Installation

If you prefer to perform the setup steps manually:

### 1. Download Model Weights
```bash
# Download the ONNX model files from HuggingFace (receptron/laya-onnx)
curl -L -C - -o laya.onnx https://huggingface.co/receptron/laya-onnx/resolve/main/laya.onnx
curl -L -C - -o laya.onnx.data https://huggingface.co/receptron/laya-onnx/resolve/main/laya.onnx.data

# Download tokenizer files
mkdir -p tokenizer
curl -L -C - -o tokenizer/tokenizer.json https://huggingface.co/receptron/laya-onnx/resolve/main/tokenizer/tokenizer.json
curl -L -C - -o tokenizer/tokenizer_config.json https://huggingface.co/receptron/laya-onnx/resolve/main/tokenizer/tokenizer_config.json
```
*Note: The model files are approximately 1.7GB and are ignored by Git.*

### 2. Environment Setup
```bash
# Provision Python runtime
uv sync   # or: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements

# Build TypeScript MCP Server
cd laya-mcp
npm install
npm run build
cd ..
```

## 3. Usage (AI Harnesses)

We've configured the MCP Server to be completely self-contained. You do not need to manually manage the Python backend.

Just point your AI harness (Cursor, Windsurf, Claude Desktop, etc.) to the `laya-mcp` folder using `npx`. When your AI harness connects, the MCP server will seamlessly boot the Python ONNX model in the background, wait for it to load, and bind `stdio`.

**In `claude_desktop_config.json` (or similar):**
```json
{
  "mcpServers": {
    "laya-policy-engine": {
      "command": "npx",
      "args": [
        "-y",
        "/absolute/path/to/laya-onnx/laya-mcp"
      ]
    }
  }
}
```

### Alternative: Local Network Access (SSE)

If you want to expose the system to multiple AI harnesses on your local Wi-Fi without configuring complex commands, you can boot the whole system in Server-Sent Events (SSE) mode:

```bash
./start_local.sh
```
Then configure your harness to connect to:
- **Transport:** SSE
- **URL:** `http://localhost:3000/sse`

### Alternative: Internet Access (Localtunnel)

If you need to access the Laya policy engine from outside your network (e.g. for external services hitting `POST /decide`):

```bash
./start_remote.sh
```

## 4. Skills

This repository includes several pre-built Markdown skills (`skills/`) that teach your AI how to use this MCP server.
- `laya-decision-model`: How to formulate active decisions (`laya_decide`).
- `laya-security-policy`: How to gracefully handle Laya `DENY` security blocks.
- `laya-code-analysis`: How to use the `laya_analyze_code` tree-sitter tools.
