# Technical Reference: Laya Interceptor & Policy Rules

## Interceptor Architecture

When an AI harness invokes a mutating tool (`laya_run_command` or `laya_write_file`):

```
AI Harness ──► laya-mcp (TypeScript)
                    │
                    ▼ (POST /decide)
               laya_runtime (Python FastAPI)
                    │
                    ▼ (ONNX Inference)
               Laya 421M Policy Model
                    │
                    ▼
           [ALLOW / DENY / REQUIRE_AUTHORIZATION]
```

## Verdict Semantics

- **ALLOW**: Tool execution proceeds immediately via local child process or filesystem.
- **DENY**: Execution is intercepted immediately and returns an MCP error. The local shell is never invoked.
- **REQUIRE_AUTHORIZATION**: Execution is paused, returning an instruction directing the agent to seek explicit user consent.

## Safety Principles

1. **Fail-Closed**: If the Python runtime is unreachable or crashes, the MCP server defaults to `DENY`.
2. **Directory Confinement**: All paths are strictly validated against `ALLOWED_DIR` (or current repository root). Attempts to traverse outside via `../` are blocked at the path resolver level before model evaluation.
