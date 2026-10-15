#!/usr/bin/env node
/**
 * Laya ONNX Policy Engine — Universal PreToolUse Decision Hook
 * 
 * Intercepts tool calls before execution in AI harnesses (Antigravity, Cursor, Claude Code, Cline).
 * - Fast-paths read-only tools (0ms overhead).
 * - Queries Laya ONNX decision model via stdio MCP protocol for mutating actions.
 * - Blocks destructive actions (DENY) or actions requiring human authorization.
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Strictly whitelisted read-only tools that bypass policy check immediately
const READONLY_EXACT_RE = /^(view_file|read_file|read|grep|search_files|search_web|read_url_content|list_dir|listdir|ls|glob)$/i;

// Self-protection regex for policy engine and harness configurations
const PROTECTED_TARGETS_RE = /(hooks\/laya-pretool-hook\.js|laya_runtime\/|laya_config\.json|\.claude\/settings\.json|\.gemini\/)/i;

/**
 * Sanitizes and truncates tool arguments for policy evaluation.
 * Large file contents (e.g. 50KB in Write/Edit) are summarized with metadata
 * so they don't exceed the model's 512-token context and trigger accidental truncation escalation.
 */
function sanitizeArgsForPolicy(toolName, args) {
    if (!args || typeof args !== 'object') return args;
    const clean = { ...args };
    const contentKeys = ['content', 'CodeContent', 'ReplacementContent', 'TargetContent', 'text'];
    for (const key of contentKeys) {
        if (typeof clean[key] === 'string' && clean[key].length > 250) {
            clean[`${key}_length`] = clean[key].length;
            clean[key] = clean[key].slice(0, 150) + '... [TRUNCATED_FOR_POLICY_REVIEW]';
        }
    }
    return clean;
}

/**
 * Resolves the path to the laya-mcp server entry point.
 */
function resolveLayaMcpPath() {
    if (process.env.LAYA_MCP_PATH && fs.existsSync(process.env.LAYA_MCP_PATH)) {
        return process.env.LAYA_MCP_PATH;
    }
    const repoRoot = process.env.LAYA_HOME || path.resolve(__dirname, '..');
    const candidate = path.join(repoRoot, 'laya-mcp', 'dist', 'index.js');
    if (fs.existsSync(candidate)) {
        return candidate;
    }
    throw new Error(`Cannot find laya-mcp server at ${candidate}. Run 'npm run build' in laya-mcp first.`);
}

/**
 * Normalizes tool name and input from various harness payload formats.
 */
function normalizePayload(raw) {
    let toolName = raw.tool_name || raw.toolName || raw.name || raw.tool || '';
    let toolArgs = raw.tool_input || raw.toolInput || raw.arguments || raw.args || {};

    if (typeof toolName === 'string' && toolName.includes(':')) {
        toolName = toolName.slice(toolName.lastIndexOf(':') + 1);
    }

    return { toolName, toolArgs };
}

const RUNTIME_URL = process.env.LAYA_RUNTIME_URL || 'http://127.0.0.1:8000';

/**
 * Fast-path HTTP query if Laya runtime daemon is already active (<150ms).
 */
async function queryDirectHttp(toolName, toolArgs) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${RUNTIME_URL}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tool: toolName,
                args: toolArgs,
                context: `Is executing the tool '${toolName}' safe or dangerous according to project security policies?`,
                criteria: {
                    ALLOW: 'Safe action operating strictly within expected project files or benign commands.',
                    DENY: 'Dangerous or destructive action (e.g. deleting root/system files or wildcard deletion).',
                    REQUIRE_AUTHORIZATION: 'Sensitive action (installing untrusted dependencies, executing remote scripts) requiring user consent.'
                }
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (res.ok) {
            const data = await res.json();
            return {
                decision: data.decision || 'DENY',
                reasoning: data.reasoning || 'Evaluated by local Laya ONNX engine'
            };
        }
    } catch {
        // Fallback to stdio MCP spawn
    }
    return null;
}

/**
 * Queries laya-mcp over stdio via JSON-RPC (with automatic background engine warmup).
 */
async function queryLayaDecide(toolName, toolArgs) {
    // 1. Fast direct HTTP evaluation if runtime is active
    const directRes = await queryDirectHttp(toolName, toolArgs);
    if (directRes) {
        return directRes;
    }

    // 2. Fallback to MCP stdio server with warmup
    const serverPath = resolveLayaMcpPath();
    const repoRoot = process.env.LAYA_HOME || path.resolve(__dirname, '..');

    return new Promise((resolve, reject) => {
        const proc = spawn('node', [serverPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                LAYA_HOME: repoRoot,
                ALLOWED_DIR: repoRoot
            }
        });

        let stdoutData = '';
        let stderrData = '';

        proc.stderr.on('data', (chunk) => {
            stderrData += chunk.toString();
        });

        const timeout = setTimeout(() => {
            proc.kill();
            resolve({
                decision: 'DENY',
                reasoning: 'Laya policy check timed out after 25 seconds during cold start.'
            });
        }, 25000);

        const sendRpc = (id, method, params = {}) => {
            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
            proc.stdin.write(msg);
        };

        let initReceived = false;

        proc.stdout.on('data', (chunk) => {
            stdoutData += chunk.toString();
            const lines = stdoutData.split('\n');

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 1 && !initReceived) {
                        initReceived = true;
                        sendRpc(2, 'tools/call', {
                            name: 'laya_decide',
                            arguments: {
                                tool: toolName,
                                args: toolArgs,
                                instruction: `Is executing the tool '${toolName}' safe or dangerous according to project security policies?`,
                                criteria: {
                                    ALLOW: 'Safe action operating strictly within expected project files or benign commands.',
                                    DENY: 'Dangerous or destructive action (e.g. deleting root/system files or wildcard deletion).',
                                    REQUIRE_AUTHORIZATION: 'Sensitive action (installing untrusted dependencies, executing remote scripts) requiring user consent.'
                                }
                            }
                        });
                    } else if (msg.id === 2) {
                        clearTimeout(timeout);
                        proc.kill();

                        const res = msg.result;
                        const decision = res?.structuredContent?.decision || 'DENY';
                        const reasoning = res?.structuredContent?.reasoning || res?.content?.[0]?.text || 'Evaluated by Laya ONNX model';
                        resolve({ decision, reasoning });
                        return;
                    }
                } catch {
                    // Incomplete JSON chunk, await next
                }
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        sendRpc(1, 'initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'laya-pretool-hook', version: '1.0.0' }
        });
    });
}

function main() {
    let rawInput = '';
    
    // Fail-closed timeout if harness does not send stdin
    const stdinTimeout = setTimeout(() => {
        console.error("Laya PreToolUse Hook Error: Stdin timeout. Failing closed for security.");
        process.exit(2);
    }, 5000);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { rawInput += chunk; });
    process.stdin.on('end', async () => {
        clearTimeout(stdinTimeout);

        if (!rawInput.trim()) {
            console.error("Laya PreToolUse Hook Error: Received empty tool payload. Failing closed for security.");
            process.exit(2);
        }

        try {
            const parsed = JSON.parse(rawInput);
            const { toolName, toolArgs } = normalizePayload(parsed);

            // 1. Fast-Path: Allow strictly whitelisted read-only tools without latency
            if (READONLY_EXACT_RE.test(toolName)) {
                process.exit(0);
            }

            // 2. Self-Protection: Modifying policy files or harness configs requires human confirmation
            const targetStr = JSON.stringify(toolArgs);
            if (PROTECTED_TARGETS_RE.test(targetStr)) {
                const selfProtectMsg = "Action REQUIRES HUMAN AUTHORIZATION: Modification of Laya policy engine or harness configuration files requires explicit confirmation.";
                console.error(selfProtectMsg);
                const selfProtectPayload = {
                    hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "ask",
                        permissionDecisionReason: selfProtectMsg
                    },
                    decision: "REQUIRE_AUTHORIZATION",
                    reason: selfProtectMsg
                };
                process.stdout.write(JSON.stringify(selfProtectPayload) + '\n');
                if (process.env.LAYA_HOOK_BLOCK_ON_AUTH === "true") {
                    process.exit(2);
                }
                process.exit(0);
            }

            // 3. Sanitize large payloads (e.g. Write/Edit content) so they don't exceed 512 tokens
            const sanitizedArgs = sanitizeArgsForPolicy(toolName, toolArgs);

            // 4. Evaluate with Laya ONNX Engine
            const { decision, reasoning } = await queryLayaDecide(toolName, sanitizedArgs);

            if (decision === 'ALLOW') {
                process.exit(0);
            }

            if (decision === 'REQUIRE_AUTHORIZATION') {
                const askMsg = `Action REQUIRES HUMAN AUTHORIZATION by Laya Policy Engine: ${reasoning}`;
                console.error(askMsg);
                const askPayload = {
                    hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "ask",
                        permissionDecisionReason: askMsg
                    },
                    decision: "REQUIRE_AUTHORIZATION",
                    reason: askMsg
                };
                process.stdout.write(JSON.stringify(askPayload) + '\n');
                if (process.env.LAYA_HOOK_BLOCK_ON_AUTH === "true") {
                    process.exit(2);
                }
                process.exit(0);
            }

            // DENY: Hard block
            const denyMsg = `Action DENIED by Laya Policy Engine: ${reasoning}`;
            console.error(denyMsg);
            const denyPayload = {
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: denyMsg
                },
                block: true,
                decision: "DENY",
                reason: denyMsg
            };
            process.stdout.write(JSON.stringify(denyPayload) + '\n');
            process.exit(2);
        } catch (err) {
            console.error(`Laya PreToolUse Hook Error: ${err.message}`);
            process.exit(2);
        }
    });
}

main();
