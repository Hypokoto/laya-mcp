---
name: laya-security-policy
description: Guidelines for handling security authorization and policy blocks from the Laya ONNX Engine during file and command operations.
author: Hypokoto
date: 2026-10-08
version: 1.0.0
triggers: Action blocked by policy, REQUIRE_AUTHORIZATION, Laya denied, permission denied by Laya
---

# Laya Security Policy Handling

## Purpose
Your file system and terminal operations are actively monitored and intercepted by the Laya ONNX Policy Engine. This skill teaches you how to gracefully handle blocks and authorization requests without hallucinating fixes or repeatedly failing.

## Understanding Laya Responses
When you execute a tool like `laya_run_command` or `laya_write_file`, you may receive one of the following intercepted errors instead of the expected output:

1. **`DENY` (Action Blocked)**
   - **Meaning:** Laya has determined your action is highly destructive or malicious (e.g., `rm -rf /`, deleting core files).
   - **Your Action:** Stop immediately. Do not attempt to bypass the block. Explain to the user why the action was blocked and propose a safer alternative.

2. **`REQUIRE_AUTHORIZATION` (Human Approval Needed)**
   - **Meaning:** Laya has determined the action is risky but potentially valid (e.g., installing new dependencies, running unfamiliar scripts).
   - **Your Action:** Stop and explicitly ask the user for permission to proceed. Do not assume the command succeeded. Only retry the command after the user has explicitly confirmed it is safe.

## Rules of Engagement
- **Never hallucinate success:** If a tool returns a Laya policy error, you must treat the operation as failed.
- **Be transparent:** Always tell the user that the Laya Policy Engine intervened.
- **Do not blindly retry:** Unless you have changed the arguments to be safer or obtained human approval, retrying the exact same blocked command will result in another block and waste compute.
