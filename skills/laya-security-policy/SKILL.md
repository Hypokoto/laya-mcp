---
name: laya-security-policy
description: Provides guidelines for handling security authorization and policy blocks from the Laya ONNX Engine during file and command operations.
author: Hypokoto
date: 2026-10-12
version: 1.0.0
triggers: Action blocked by policy, REQUIRE_AUTHORIZATION, Laya denied, permission denied by Laya, Action DENIED by Laya
---

# Laya Security Policy Handling

## Purpose

Guides the AI agent in safely and transparently responding when file system operations (`laya_write_file`) or shell commands (`laya_run_command`) are intercepted and blocked by the Laya ONNX Policy Engine.

## When to Use This Skill

Activate this skill when:
- An MCP tool execution returns `"Action DENIED by Laya policy engine"`
- An MCP tool execution returns `"Action REQUIRES HUMAN AUTHORIZATION"`
- Formulating alternative, non-destructive commands following a policy rejection
- Requesting explicit human consent for sensitive actions

## Core Capabilities

1. **Denial Recovery**: Formulates safe alternative approaches without repeating rejected commands.
2. **Authorization Escalation**: Prompts the user with exact command details when human authorization is required.
3. **Transparent Reporting**: Explains policy engine intervention clearly to the end user.

## Step-by-Step Instructions

1. **Detect Policy Intervention**:
   - Inspect tool result for `isError: true` containing `DENY` or `REQUIRE_AUTHORIZATION`.
2. **Handle `DENY` Verdicts**:
   - Do **NOT** retry the exact same command.
   - Do **NOT** attempt workarounds designed to bypass the security interceptor.
   - Inform the user immediately that the action was blocked due to safety policies.
   - Propose a safer, non-destructive alternative (e.g., target a temporary directory, run dry-run flags).
3. **Handle `REQUIRE_AUTHORIZATION` Verdicts**:
   - Pause execution immediately.
   - Present the exact command, target file path, and intent to the user.
   - Wait for explicit user confirmation before attempting execution again.
4. **Preserve Integrity**:
   - Never report false success if a command was blocked.

## Progressive Disclosure

- Detailed security criteria and interceptor mechanics: see [references/policy-rules.md](references/policy-rules.md)
- Real dialogue recovery examples: see [examples/handling-blocks.md](examples/handling-blocks.md)
