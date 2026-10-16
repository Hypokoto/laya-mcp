# Laya ONNX & Policy Engine

This repository provides a complete, self-contained local AI system for evaluating policies, scoring data, and securing autonomous agent actions using the **Laya Decision Model** (ONNX).

It features a high-performance multi-tiered architecture:
1. **Native Rust Runtime & Daemon (`crates/`)**:
   - High-throughput native Rust engine powered by `ort` (ONNX Runtime C++ bindings).
   - Ultra-fast policy evaluation: **0.4ms** (Tier 1 rules: >2,300 ops/sec).
   - High-performance INT8 CPU inference: **~114ms** p50 latency on standard CPU cores.
   - Axum HTTP server on `:8000`: Drop-in replacement for legacy Python FastAPI with only **~774 MB RSS** memory footprint (saving >1.5 GB RAM on 8 GB systems).
   - Standalone CLI (`laya`) for inspecting models, executing decisions, benchmarking, and serving.
2. **TypeScript MCP Server (`laya-mcp`)**:
   - Model Context Protocol server exposing active decision making, security auditing, and tree-sitter AST queries.
   - Seamless dual-runtime client: connects to native Rust on `:8000` with zero-setup in-process WebAssembly fallback.
3. **Universal PreToolUse Decision Hook (`hooks/laya-pretool-hook.js`)**:
   - Hardcoded interceptor for AI harnesses (Antigravity, Cursor, Claude Code) with session authorization caching and destructive command isolation.

---

## ⚡ Native Rust Runtime (`laya`)

The native Rust engine is organized as a Cargo monorepo workspace under `crates/`:
- `crates/laya-core`: Decision data types, config, traits, and 3-tier policy engine.
- `crates/laya-preprocess`: HuggingFace tokenizer integration and exact sequence builder.
- `crates/laya-onnx`: ONNX Runtime session execution, tensor mapping, and calibration.
- `crates/laya-cli`: Standalone CLI executable.

### Build
```bash
cargo build --release
# Executable produced at ./target/release/laya
```

### CLI Commands
```bash
# 1. Inspect ONNX model graph structure, inputs, and outputs
./target/release/laya inspect

# 2. Run single decision query via CLI arguments
./target/release/laya decide --tool run_command --args '{"command": "git status"}'

# 3. Benchmark warm latency, throughput, and 100 adversarial stress cases
./target/release/laya bench --iterations 500
./target/release/laya bench --test-file laya_100_audit_report.json

# 4. Start high-speed native Axum HTTP daemon on :8000
./target/release/laya serve --port 8000
```

### Benchmark Highlights (INT8 CPU)
- **Model Load Time**: ~2.78 seconds (557 MB INT8 ONNX)
- **Tier 1 Declarative Fast-Path**: 0.428 ms avg latency (2,338 decisions/sec)
- **Tier 2 Neural ONNX Inference**: 114.18 ms p50 median latency on CPU
- **Memory Footprint**: ~774 MB RSS (vs ~2.2 GB in Python)

---

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

To expose the system with Bearer token authentication and DNS rebinding protection:

```bash
./start_local.sh
```
Connect your harness using:
- **Transport:** SSE
- **URL:** `http://127.0.0.1:3000/sse`
- **Header:** `Authorization: Bearer <LAYA_API_TOKEN>`

### Alternative: Rootless Sandboxed Execution (Podman / Docker)

To run the MCP server with dropped capabilities, no new privileges, and isolated workspace mounts:

```bash
./run_sandboxed.sh /path/to/your/workspace
```

---

## 4. Hardcoded Harness Interceptor (PreToolUse Hook)

Want Laya to actively guard your AI agents *before* any command executes, without relying on the model remembering to call an MCP tool?

Laya includes a universal **PreToolUse decision hook** (`hooks/laya-pretool-hook.js`) compatible with Antigravity, Cursor, and Claude Code:

- **0ms Fast-Path:** Non-mutating tools (`view_file`, `Read`, `read_file`, `Grep`, `Glob`, `LS`, `search_web`, `read_url_content`, etc.) pass through immediately with zero overhead.
- **Pre-Execution Guardrails:** Mutating commands (`run_command`, `Bash`, `write_to_file`, `replace_file_content`, `Edit`) are intercepted before execution and evaluated against the calibrated Laya ONNX decision model.
- **Interactive Escalation:** Actions requiring human confirmation return native `permissionDecision: "ask"` for Claude Code, prompting you interactively in the terminal rather than blocking indefinitely.
- **Hard Block Policy:** Destructive commands (e.g. `rm -rf /`, `rm -rf ./*`, `git push --force`) exit with code `2` or return `permissionDecision: "deny"`, halting execution dead in its tracks.
- **Emergency Escape Hatch:** If the local runtime is offline and you need to bypass interception immediately:
  ```bash
  cd laya-mcp && npm run hook:uninstall
  ```

### Install or Uninstall Hook
```bash
cd laya-mcp
npm run hook:install     # Registers hook in Claude Code, Cursor, and Antigravity
npm run hook:uninstall   # Safely unregisters hook (with .bak backups preserved)
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
