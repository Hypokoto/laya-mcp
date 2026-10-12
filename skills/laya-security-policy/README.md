# Laya Security Policy Skill

An essential safety skill that teaches AI agent harnesses how to gracefully navigate system security guardrails enforced by the Laya ONNX Policy Engine.

## Overview

Autonomous AI coding agents can inadvertently run destructive commands (such as recursive directory deletions, overwriting system configurations, or downloading untrusted binaries). To prevent system damage, the Laya MCP Server intercepts all sensitive tool invocations and queries a local ONNX policy model before executing them.

This skill equips the agent with behavioral guardrails: when an action is blocked or flagged for authorization, the agent learns to communicate transparently, avoid retry loops, and suggest safe alternatives.

## Policy Responses Handled

1. **`DENY`**: The action is classified as hazardous. The agent halts and suggests a non-destructive alternative.
2. **`REQUIRE_AUTHORIZATION`**: The action carries moderate risk. The agent asks the human operator for explicit permission.

## Installation

### Local Repository
Located at `skills/laya-security-policy/`.

### Global Installation
```bash
ln -sf $(pwd)/skills/laya-security-policy ~/.claude/skills/laya-security-policy
ln -sf $(pwd)/skills/laya-security-policy ~/.gemini/config/skills/laya-security-policy
```
