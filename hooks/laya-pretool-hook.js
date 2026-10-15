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
const crypto = require('crypto');
const os = require('os');

const READONLY_EXACT_RE = /^(view_file|read_file|laya_read_file|read_files|laya_read_files|read|grep|search_files|search_web|read_url_content|list_dir|listdir|ls|glob)$/i;

// Self-protection regex for policy engine and harness configurations
const PROTECTED_TARGETS_RE = /(hooks\/laya-pretool-hook\.js|laya_runtime\/|laya_config\.json|laya_rules\.json|\.laya\/|\.claude\/settings\.json|\.gemini\/)/i;

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
 * Computes a deterministic SHA-256 action signature for session authorization caching.
 * Includes all arguments (e.g. file content, flags) so payload variations produce distinct signatures.
 */
function computeActionSignature(toolName, toolArgs) {
    const normTool = (toolName || '').toLowerCase().trim();
    const cmd = (toolArgs?.CommandLine || toolArgs?.command || toolArgs?.cmd || '').trim();
    const filePath = (toolArgs?.filepath || toolArgs?.path || toolArgs?.file_path || toolArgs?.TargetFile || '').trim();
    const argsStr = JSON.stringify(toolArgs || {});
    const sigPayload = `${normTool}::${cmd}::${filePath}::${argsStr}`;
    return crypto.createHash('sha256').update(sigPayload).digest('hex');
}

/**
 * Returns path to session authorization cache file in a private user-owned cache directory (mode 0o700).
 */
function getSessionCachePath(sessionId) {
    if (!sessionId) return null;
    const baseCacheDir = process.env.LAYA_CACHE_DIR || path.join(os.homedir(), '.cache', 'laya', 'sessions');
    try {
        fs.mkdirSync(baseCacheDir, { mode: 0o700, recursive: true });
    } catch {}
    const cleanId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(baseCacheDir, `session_${cleanId}.json`);
}

/**
 * Checks if an action signature was explicitly approved in this session.
 */
function isActionCachedApproved(sessionId, sig) {
    if (!sessionId || !sig) return false;
    try {
        const cacheFile = getSessionCachePath(sessionId);
        if (cacheFile && fs.existsSync(cacheFile)) {
            const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (Array.isArray(data.approved) && data.approved.includes(sig)) {
                return true;
            }
        }
    } catch {}
    return false;
}

/**
 * Records an action signature as pending human authorization during PreToolUse.
 */
function recordPendingAuthorization(sessionId, sig) {
    if (!sessionId || !sig) return;
    try {
        const cacheFile = getSessionCachePath(sessionId);
        if (!cacheFile) return;
        let data = { pending: [], approved: [] };
        if (fs.existsSync(cacheFile)) {
            try {
                data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
                if (!Array.isArray(data.pending)) data.pending = [];
                if (!Array.isArray(data.approved)) data.approved = [];
            } catch {}
        }
        if (!data.pending.includes(sig)) {
            data.pending.push(sig);
            fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), { mode: 0o600 });
        }
    } catch {}
}

/**
 * Confirms a pending authorization when PostToolUse verifies successful tool execution.
 */
function confirmPendingAuthorization(sessionId, sig) {
    if (!sessionId || !sig) return false;
    try {
        const cacheFile = getSessionCachePath(sessionId);
        if (!cacheFile || !fs.existsSync(cacheFile)) return false;
        let data = { pending: [], approved: [] };
        try {
            data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (!Array.isArray(data.pending)) data.pending = [];
            if (!Array.isArray(data.approved)) data.approved = [];
        } catch {
            return false;
        }

        // Only promote if it was genuinely pending authorization
        if (data.pending.includes(sig)) {
            data.pending = data.pending.filter((s) => s !== sig);
            if (!data.approved.includes(sig)) {
                data.approved.push(sig);
            }
            fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), { mode: 0o600 });
            return true;
        }
    } catch {}
    return false;
}

/**
 * Normalizes tool name, arguments, and session ID from various harness payload formats.
 */
function normalizePayload(raw) {
    let toolName = raw.tool_name || raw.toolName || raw.name || raw.tool || '';
    let toolArgs = raw.tool_input || raw.toolInput || raw.arguments || raw.args || {};
    let sessionId = raw.session_id || raw.sessionId || raw.conversation_id || raw.conversationId || process.env.LAYA_SESSION_ID || null;

    if (typeof toolName === 'string' && toolName.includes(':')) {
        toolName = toolName.slice(toolName.lastIndexOf(':') + 1);
    }

    return { toolName, toolArgs, sessionId };
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
                args: toolArgs
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
                                args: toolArgs
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
            const { toolName, toolArgs, sessionId } = normalizePayload(parsed);

            // 0. Confirmed Approval / PostToolUse Recording:
            // Promote a pending signature ONLY when the harness delivers a genuine post-tool event
            // AND provides a trustworthy signal of explicit human consent (not automated or default tool execution).
            const hookEvent = parsed.hook_event_name || parsed.hookEventName || parsed.event || '';
            const isPostTool = hookEvent === "PostToolUse" || hookEvent === "AfterTool" || hookEvent === "afterToolUse" || hookEvent === "post_tool";
            const hasExplicitHumanConsent = Boolean(
                parsed.user_approved === true ||
                parsed.human_approved === true ||
                parsed.is_human_confirmed === true ||
                parsed.permission_decision === "allow" ||
                process.env.LAYA_TRUST_HARNESS_APPROVAL === "true"
            );

            if (isPostTool) {
                const targetStr = JSON.stringify(toolArgs);
                if (hasExplicitHumanConsent && sessionId && !PROTECTED_TARGETS_RE.test(targetStr)) {
                    const actionSig = computeActionSignature(toolName, toolArgs);
                    const confirmed = confirmPendingAuthorization(sessionId, actionSig);
                    if (confirmed) {
                        console.error(`Laya Hook: Recorded approved action in session cache (${sessionId.slice(0, 8)}...): ${toolName}`);
                    }
                }
                process.exit(0);
            }

            // 1. Fast-Path: Allow strictly whitelisted read-only tools without latency
            if (READONLY_EXACT_RE.test(toolName)) {
                process.exit(0);
            }

            // 2. Session Approval Cache: Check if user already approved this exact action in this session
            const actionSig = computeActionSignature(toolName, toolArgs);
            if (isActionCachedApproved(sessionId, actionSig)) {
                console.error(`Laya PreToolUse Hook: Action pre-approved in session (${sessionId.slice(0, 8)}...): ${toolName}`);
                process.exit(0);
            }

            // 3. Self-Protection: Modifying policy files or harness configs requires human confirmation
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

            // 4. Sanitize large payloads (e.g. Write/Edit content) so they don't exceed 512 tokens
            const sanitizedArgs = sanitizeArgsForPolicy(toolName, toolArgs);

            // 5. Evaluate with Laya ONNX Engine
            const { decision, reasoning } = await queryLayaDecide(toolName, sanitizedArgs);

            if (decision === 'ALLOW') {
                process.exit(0);
            }

            if (decision === 'REQUIRE_AUTHORIZATION') {
                recordPendingAuthorization(sessionId, actionSig);
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
