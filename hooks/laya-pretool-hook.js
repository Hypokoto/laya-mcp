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

// Mutating tools that require policy authorization
const MUTATING_TOOL_RE = /^(run_command|Bash|terminal|write_to_file|replace_file_content|Write|Edit|MultiEdit|create_file|delete_file)/i;

// Read-only tools that bypass policy check immediately
const READONLY_TOOL_RE = /^(view_file|read_file|Read|grep|search_files|search_web|read_url_content|list_dir|glob)/i;

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

/**
 * Queries laya-mcp over stdio via JSON-RPC.
 */
async function queryLayaDecide(toolName, toolArgs) {
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
                reasoning: 'Laya policy check timed out after 10 seconds.'
            });
        }, 10000);

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
    
    const stdinTimeout = setTimeout(() => {
        process.exit(0);
    }, 3000);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { rawInput += chunk; });
    process.stdin.on('end', async () => {
        clearTimeout(stdinTimeout);

        if (!rawInput.trim()) {
            process.exit(0);
        }

        try {
            const parsed = JSON.parse(rawInput);
            const { toolName, toolArgs } = normalizePayload(parsed);

            // 1. Fast-Path: Allow read-only tools without latency
            if (READONLY_TOOL_RE.test(toolName)) {
                process.exit(0);
            }

            // 2. Fast-Path: If not a mutating tool, allow
            if (!MUTATING_TOOL_RE.test(toolName)) {
                process.exit(0);
            }

            // 3. Mutating tool: Evaluate with Laya ONNX Engine
            const { decision, reasoning } = await queryLayaDecide(toolName, toolArgs);

            if (decision === 'ALLOW') {
                process.exit(0);
            }

            const blockMessage = decision === 'DENY'
                ? `Action DENIED by Laya Policy Engine: ${reasoning}`
                : `Action REQUIRES HUMAN AUTHORIZATION by Laya Policy Engine: ${reasoning}\nPlease ask the user for explicit confirmation before proceeding.`;

            console.error(blockMessage);

            const blockPayload = {
                block: true,
                decision,
                reason: blockMessage
            };

            process.stdout.write(JSON.stringify(blockPayload) + '\n');
            process.exit(2);
        } catch (err) {
            console.error(`Laya PreToolUse Hook Error: ${err.message}`);
            process.exit(2);
        }
    });
}

main();
