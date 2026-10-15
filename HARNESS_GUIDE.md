# Laya MCP — Universal AI Harness Integration Guide

Connect the **Laya MCP Server** (ONNX decision engine, active security policy, and code analysis) seamlessly to any AI harness.

---

## ⚡ Instant Setup (Recommended)

Run the automated setup wizard inside the `laya-mcp` directory:

```bash
cd laya-mcp
npm run setup
```
Or via npx:
```bash
npx /path/to/laya-onnx/laya-mcp setup
```

The setup wizard automatically detects your installed AI harnesses on Linux, macOS, and Windows and registers `laya-mcp` into their respective configuration files without overwriting existing servers.

---

## 🛠 Manual Configuration Guide

If you prefer manual configuration or are using a remote harness, use the snippets below.

### 1. Cursor IDE

Edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project root):

```json
{
  "mcpServers": {
    "laya-mcp": {
      "command": "node",
      "args": [
        "/home/hypokoto/dev/Models/laya-onnx/laya-mcp/dist/index.js"
      ],
      "env": {
        "LAYA_HOME": "/home/hypokoto/dev/Models/laya-onnx",
        "ALLOWED_DIR": "/home/hypokoto/dev/Models/laya-onnx"
      }
    }
  }
}
```

### 2. Claude Desktop

- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "laya-mcp": {
      "command": "node",
      "args": [
        "/home/hypokoto/dev/Models/laya-onnx/laya-mcp/dist/index.js"
      ],
      "env": {
        "LAYA_HOME": "/home/hypokoto/dev/Models/laya-onnx",
        "ALLOWED_DIR": "/home/hypokoto/dev/Models/laya-onnx"
      }
    }
  }
}
```

### 3. Claude Code CLI

Add via the CLI:
```bash
claude mcp add laya-mcp node /home/hypokoto/dev/Models/laya-onnx/laya-mcp/dist/index.js
```
Or manually edit `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "laya-mcp": {
      "command": "node",
      "args": [
        "/home/hypokoto/dev/Models/laya-onnx/laya-mcp/dist/index.js"
      ],
      "env": {
        "LAYA_HOME": "/home/hypokoto/dev/Models/laya-onnx",
        "ALLOWED_DIR": "/home/hypokoto/dev/Models/laya-onnx"
      }
    }
  }
}
```

### 4. Windsurf (Codeium)

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "laya-mcp": {
      "command": "node",
      "args": [
        "/home/hypokoto/dev/Models/laya-onnx/laya-mcp/dist/index.js"
      ],
      "env": {
        "LAYA_HOME": "/home/hypokoto/dev/Models/laya-onnx",
        "ALLOWED_DIR": "/home/hypokoto/dev/Models/laya-onnx"
      }
    }
  }
}
```

### 5. Cline / Roo Code (VS Code Extension)

Edit:
`~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "laya-mcp": {
      "command": "node",
      "args": [
        "/home/hypokoto/dev/Models/laya-onnx/laya-mcp/dist/index.js"
      ],
      "env": {
        "LAYA_HOME": "/home/hypokoto/dev/Models/laya-onnx",
        "ALLOWED_DIR": "/home/hypokoto/dev/Models/laya-onnx"
      }
    }
  }
}
```

### 6. Continue.dev

Edit `~/.continue/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "laya-mcp",
      "command": "node",
      "args": [
        "/home/hypokoto/dev/Models/laya-onnx/laya-mcp/dist/index.js"
      ],
      "env": {
        "LAYA_HOME": "/home/hypokoto/dev/Models/laya-onnx",
        "ALLOWED_DIR": "/home/hypokoto/dev/Models/laya-onnx"
      }
    }
  ]
}
```

---

## 🌐 Network Transport (HTTP / SSE)

For browser-based harnesses, web agents (e.g. LibreChat, LangChain, custom agents) or remote setups:

1. **Start the MCP Server on HTTP/SSE**:
   ```bash
   cd laya-mcp
   npm run start:http
   # Runs on http://0.0.0.0:3000
   ```

2. **Configure SSE Transport in your Harness**:
   - **Type**: `sse`
   - **URL**: `http://localhost:3000/sse`
   - **Health Check**: `http://localhost:3000/health`

---

## 🛡 Hardcoded Decision Interceptor (PreToolUse Hook)

For deep harness integration where you want to **hardcode** the Laya Decision Engine to intercept and govern every tool call *before* execution:

### Automated Hook Setup
```bash
cd laya-mcp
npm run hook:install
```

To remove the hook at any time:
```bash
cd laya-mcp
npm run hook:uninstall
```

### How It Works

1. **Deterministic Fast-Path (0ms):**
   Read-only tools (`view_file`, `read_file`, `grep`, `search_files`, `search_web`, `read_url_content`, `list_dir`) bypass evaluation immediately with 0ms latency.
2. **Mutating Action Interception:**
   Mutating actions (`run_command`, `Bash`, `write_to_file`, `replace_file_content`, `Edit`) trigger an instantaneous JSON-RPC query to `laya-mcp`'s `laya_decide` tool.
3. **Policy Enforcement:**
   - **`ALLOW`**: Hook exits with code `0`, allowing the harness to run the tool.
   - **`DENY`**: Hook exits with code `2` and writes the denial rationale to `stderr` and JSON output to `stdout`. The harness aborts execution and provides the reason directly to the model.
   - **`REQUIRE_AUTHORIZATION`**: Hook exits with code `2`, requesting human confirmation before dangerous operations proceed.

### Harness Configurations Updated

- **Antigravity IDE & CLI (`~/.gemini/antigravity-ide/settings.json`)**:
  ```json
  {
    "hooks": {
      "BeforeTool": [
        {
          "matcher": "Bash|Edit|Write|MultiEdit|run_command|write_to_file|replace_file_content",
          "hooks": [
            {
              "type": "command",
              "command": "node \"/path/to/laya-onnx/hooks/laya-pretool-hook.js\"",
              "timeout": 15
            }
          ]
        }
      ]
    }
  }
  ```

- **Cursor IDE (`~/.cursor/hooks.json`)**:
  ```json
  {
    "version": 1,
    "hooks": {
      "beforeToolUse": [
        {
          "command": "node \"/path/to/laya-onnx/hooks/laya-pretool-hook.js\""
        }
      ]
    }
  }
  ```
