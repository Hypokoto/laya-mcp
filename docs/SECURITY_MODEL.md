# Laya Security Model & Operational Trust Boundaries

This document defines the security architecture, threat model, trust boundaries, and enforcement guarantees of the **Laya Policy Engine** for local AI coding tools and autonomous agents.

---

## 1. Executive Summary & Security Positioning

Laya is designed as an **advisory, pre-tool policy evaluation and enforcement gatekeeper** operating on the developer's local machine.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Developer / Host System                         │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │              Coding Agent / Harness Execution Loop             │   │
│   │  (Antigravity CLI / IDE, Claude Code CLI, Cursor IDE, etc.)    │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │ PreToolUse Hook                    │
│                                   ▼                                    │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                    Universal Host Adapters                     │   │
│   │  - Canonical Action Digest Computation (SHA-256)               │   │
│   │  - Domain Risk Mapping (Mutating Fail-Closed / Read Escalation)│   │
│   │  - Single-Use Nonce Tracking & Anti-Replay Defense             │   │
│   └──────────────┬───────────────────────────────┬─────────────────┘   │
│                  │ UDS (0600 + SO_PEERCRED)      │ TCP (Bearer Token)  │
│                  ▼                               ▼                     │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │               Native Laya Rust Policy Engine                   │   │
│   │  - Tier 0: Hard Deterministic Invariants & Self-Protection     │   │
│   │  - Tier 1: Deterministic Allow/Deny Regex Rules & Precedence   │   │
│   │  - Tier 2: Calibrated ModernBERT Neural Assessment             │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                  OS-Level Sandbox Boundary                     │   │
│   │  (Bubblewrap / Podman for Untrusted Repositories)              │   │
│   │  - Read-Only System Mounts (--ro-bind / /)                     │   │
│   │  - Shadowed Credentials (~/.ssh, ~/.aws, ~/.kube)              │   │
│   │  - Unshared User, PID, IPC, and Network Namespaces             │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **What Laya IS:** An intelligent pre-tool gatekeeper that inspects structured tool requests, calculates cryptographic action bindings, evaluates 6-level policy rules, and prevents AI harnesses from initiating unauthorized, malicious, or catastrophic actions.
>
> **What Laya IS NOT:** A kernel-level sandbox or hardware hypervisor. A pre-tool hook alone cannot constrain direct arbitrary shell execution, background forks, or malicious code embedded in build scripts (e.g. `build.rs`, `package.json` install hooks) once a command is launched. For untrusted repositories, Laya **mandates** operating in tandem with OS-level sandboxing (e.g. `scripts/laya-sandbox.sh`).

---

## 2. Four-Tier Host Enforcement Taxonomy

Not all AI harnesses provide identical hook capabilities. Laya explicitly classifies integrations into four verified tiers to ensure transparency:

| Tier | Host Tool | Verification Status | Enforcement Mechanism |
| :--- | :--- | :--- | :--- |
| **Tier 1: Live-Tested** | **Antigravity CLI / IDE** | **Verified Live** in active sessions | Pre-tool interceptor (`laya-pretool-hook.js`), blocking exit codes (0/2), stderr feedback, and direct process IPC. |
| **Tier 2: Protocol-Tested** | **Claude Code CLI** | **Verified via Mock Harness** (conforms to RFC spec) | `PreToolUse` hook contract emitting `{ "permissionDecision": "allow" \| "ask" \| "deny" }`. Deny exits with code 2 and structured message. |
| **Tier 2: Protocol-Tested** | **Cursor IDE** | **Verified via Conformance Suite** | `beforeToolUse` hook returning `{ "allow": boolean, "permission": "allow" \| "ask" \| "deny" }`. |
| **Tier 3: CLI Subprocess** | **Generic Shell / Scripts** | **Verified via Integration Suite** | `laya-run` binary wrapping arbitrary commands through local socket query with stdin evaluation fallback. |
| **Tier 4: Advisory-Only** | **MCP Tools (`laya-mcp`)** | **Advisory** | Exposes MCP tools (`laya_decide`, `laya_analyze_code`). Cannot enforce policy if the agent chooses not to invoke the tool. |

---

## 3. Cryptographic Action Authorization Lifecycle

A primary vulnerability in policy enforcement systems is **argument substitution** or **time-of-check to time-of-use (TOCTOU)** tampering: an agent requests approval for a benign command (e.g. `git status`), receives an approval token, and then uses that token to execute a malicious command (e.g. `rm -rf /`).

Laya solves this with **Deterministic Action Digests** and **Single-Use Authorization Nonces**:

### Canonical Action Digest
```
ActionDigest = SHA-256( normalize(tool) + ":" + canonicalize(workspace) + ":" + canonicalize(args_json) )
```

1. **Exact Canonicalization**:
   - JSON keys are sorted alphabetically.
   - Whitespace is stripped or standardized.
   - Arrays maintain exact element ordering.
   - Cross-language equivalence is guaranteed bit-for-bit between Rust (`crates/laya-core/src/types.rs`) and JavaScript (`adapters/common/laya_client.js`).
2. **Execution Binding Verification**:
   - When an action is evaluated as `REQUIRE_AUTHORIZATION`, Laya returns an `action_digest` and single-use `receipt_nonce`.
   - Immediately prior to execution, the host adapter invokes `verifyActionBinding(approvedDigest, tool, workspace, currentArgs, nonce)`.
   - If any argument, tool name, or workspace path is altered post-approval, or if a nonce is reused, execution is aborted immediately with a security exception.

---

## 4. Local IPC Hardening & Multi-Tenant Isolation

Laya operates as a background daemon (`laya serve`) communicating with host adapters via authenticated local channels:

### 1. Unix Domain Socket (UDS) — Primary Channel (`<0.5ms`)
- **Location**: `~/.local/state/laya/laya.sock`
- **Socket Permissions**: Bound atomically under umask `0177` (filesystem mode `0600`), restricted to the file owner.
- **Kernel Caller Verification (`SO_PEERCRED`)**: The listener explicitly queries `unix_stream.peer_cred()`. Connections originating from any user ID other than the daemon owner's UID are immediately dropped by the kernel interface before request parsing.

### 2. Loopback TCP HTTP — Secondary Channel (`~1ms`)
- **Endpoint**: `127.0.0.1:8000` (strictly bound to localhost, never `0.0.0.0`).
- **Cryptographic Session Token**: Daemon generates a 256-bit cryptographically random token saved to `~/.local/state/laya/auth_token` with file mode `0600` (directory mode `0700`).
- **Bearer Authentication**: All `/decide` requests strictly require `Authorization: Bearer <auth_token>`. Unauthenticated requests or invalid schemes are rejected with `HTTP 401 Unauthorized`.
- **CORS Protection**: Restricted strictly to localhost origins to prevent cross-origin browser exploitation.

### 3. CLI Subprocess Fallback (`~25ms`)
- If both socket and HTTP daemon are offline, adapters fall back to invoking `laya decide --stdin`, ensuring policy enforcement never silently fails open.

---

## 5. Domain Risk Mapping & Fail-Closed Semantics

When the neural assessment engine is offline or encountering an unrecoverable runtime exception:
- **High-Risk / Mutating Operations** (`run_command`, `Bash`, `write_to_file`, `replace_file_content`, `Edit`) **FAIL CLOSED** to `DENY`.
- **Read-Only / Low-Risk Operations** (`view_file`, `read_file`, `grep`, `search_files`) escalate to `REQUIRE_AUTHORIZATION`.
- Under no circumstances does a parsing or communication failure result in an automatic `ALLOW`.

---

## 6. OS-Level Sandboxing for Untrusted Repositories

Because developer workflows commonly execute build scripts (`build.rs`, `configure`, `npm install`), Laya includes an unprivileged, zero-root Linux sandboxing harness powered by **Bubblewrap** (`scripts/laya-sandbox.sh`):

```bash
# Run tests inside an unprivileged sandbox with dropped network:
./scripts/laya-sandbox.sh --offline -- cargo test

# Run untrusted package commands with sensitive credentials masked:
./scripts/laya-sandbox.sh -- npm install
```

### Sandbox Guarantees
- **Read-Only Host Root (`--ro-bind / /`)**: Host binaries, system configurations, and libraries cannot be modified or replaced.
- **Shadowed Credentials**: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.azure`, `~/.config/gcloud`, and `~/.docker` are masked by empty in-memory `tmpfs` mounts.
- **Kernel Namespace Isolation**: Unshares user, IPC, PID, network, UTS, and cgroup namespaces (`--die-with-parent`).
- **Isolated Workspace**: Only the designated project directory is mounted read-write.
