'use strict';

const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function getSocketPath() {
    if (process.env.LAYA_SOCKET_PATH) {
        return process.env.LAYA_SOCKET_PATH;
    }
    const stateDir = process.env.LAYA_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'laya');
    return path.join(stateDir, 'laya.sock');
}

function getHttpUrl() {
    return process.env.LAYA_RUNTIME_URL || 'http://127.0.0.1:8000';
}

function getAuthToken() {
    if (process.env.LAYA_AUTH_TOKEN) {
        return process.env.LAYA_AUTH_TOKEN.trim();
    }
    const stateDir = process.env.LAYA_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'laya');
    const tokenPath = path.join(stateDir, 'auth_token');
    try {
        if (fs.existsSync(tokenPath)) {
            return fs.readFileSync(tokenPath, 'utf8').trim();
        }
    } catch {
        // Ignored if unreadable
    }
    return null;
}

/**
 * Sends a decision request via Unix Domain Socket.
 */
function queryUnixSocket(requestObj, socketPath, timeoutMs = 800) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(socketPath)) {
            return reject(new Error(`Socket file does not exist: ${socketPath}`));
        }

        const payload = JSON.stringify(requestObj);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        };
        const token = getAuthToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        // Local IPC via Unix domain socket uses Node http wire format over socketPath
        // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
        const req = http.request(
            {
                socketPath,
                path: '/decide',
                method: 'POST',
                headers,
                timeout: timeoutMs,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        return reject(new Error(`Daemon UDS returned status ${res.statusCode}: ${data}`));
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        reject(new Error(`Invalid JSON from socket: ${e.message}`));
                    }
                });
            }
        );

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Socket request timed out'));
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Sends a decision request via local TCP HTTP endpoint.
 */
function queryTcpHttp(requestObj, urlStr, timeoutMs = 800) {
    return new Promise((resolve, reject) => {
        const u = new URL('/decide', urlStr);
        const payload = JSON.stringify(requestObj);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        };
        const token = getAuthToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        // Local IPC to loopback daemon on 127.0.0.1
        // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
        const req = http.request(
            {
                hostname: u.hostname,
                port: u.port || 8000,
                path: u.pathname,
                method: 'POST',
                headers,
                timeout: timeoutMs,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                        return reject(new Error(`Daemon HTTP returned status ${res.statusCode}: ${data}`));
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        reject(new Error(`Invalid JSON from HTTP: ${e.message}`));
                    }
                });
            }
        );

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('HTTP request timed out'));
        });

        req.write(payload);
        req.end();
    });
}

/**
 * Fallback: invokes the globally installed or configured `laya` CLI binary with `--stdin`.
 */
function queryCliFallback(requestObj) {
    const payload = JSON.stringify(requestObj);
    const bin = process.env.LAYA_BIN || 'laya';
    const result = spawnSync(bin, ['decide', '--stdin'], {
        input: payload,
        encoding: 'utf8',
        timeout: 15000,
        cwd: process.cwd(),
        env: { ...process.env },
    });

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`laya decide exited with code ${result.status}: ${result.stderr}`);
    }

    return JSON.parse(result.stdout);
}

/**
 * Normalizes tool requests into the Laya standard v1 decision schema
 * and queries the engine through the secure local channels:
 * 1. Unix Domain Socket (0600 owner-only IPC, authenticated, <0.5ms)
 * 2. Loopback TCP HTTP (token-authenticated daemon, ~1ms)
 * 3. CLI Subprocess Fallback (local process boundary, ~25ms)
 */
async function queryLayaPolicy(tool, operation, workspace, args, context = null) {
    const requestObj = {
        version: '1.0',
        tool: String(tool || ''),
        operation: String(operation || 'execute'),
        workspace: workspace ? String(workspace) : process.cwd(),
        arguments: args || {},
        context: context || null,
    };

    // 1. Try Unix Domain Socket (owner-only 0600 permissions, authenticated)
    const sockPath = getSocketPath();
    try {
        const res = await queryUnixSocket(requestObj, sockPath);
        if (res && res.decision) return res;
    } catch {}

    // 2. Try Loopback TCP HTTP (token-authenticated)
    const httpUrl = getHttpUrl();
    try {
        const res = await queryTcpHttp(requestObj, httpUrl);
        if (res && res.decision) return res;
    } catch {}

    // 3. Fallback to CLI subprocess
    return queryCliFallback(requestObj);
}

const crypto = require('crypto');

function canonicalizeJson(val) {
    if (val === null || typeof val !== 'object') {
        return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
        return '[' + val.map(canonicalizeJson).join(',') + ']';
    }
    const keys = Object.keys(val).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalizeJson(val[k])).join(',') + '}';
}

function computeActionDigest(tool, workspace, args) {
    const hash = crypto.createHash('sha256');
    hash.update(String(tool || '').trim().toLowerCase());
    hash.update(':');
    hash.update(String(workspace || '').trim());
    hash.update(':');
    hash.update(canonicalizeJson(args || {}));
    return hash.digest('hex');
}

const consumedReceipts = new Set();

/**
 * Validates that an action about to be executed strictly matches the approved digest.
 * Detects post-approval argument substitution, workspace alteration, and replay attacks.
 */
function verifyActionBinding(approvedDigest, tool, workspace, args, receiptNonce = null) {
    if (!approvedDigest) {
        throw new Error('Action binding verification failed: No approved digest provided.');
    }
    if (receiptNonce) {
        if (consumedReceipts.has(receiptNonce)) {
            throw new Error(`Security violation: Replay attack detected! Approval nonce '${receiptNonce}' has already been consumed.`);
        }
        consumedReceipts.add(receiptNonce);
    }
    const currentDigest = computeActionDigest(tool, workspace, args);
    if (currentDigest.toLowerCase() !== approvedDigest.toLowerCase()) {
        throw new Error(
            `Security violation: Action was modified after authorization was granted! Approved digest: ${approvedDigest}, Executed digest: ${currentDigest}`
        );
    }
    return true;
}

module.exports = {
    queryLayaPolicy,
    getSocketPath,
    getHttpUrl,
    getAuthToken,
    queryUnixSocket,
    queryTcpHttp,
    queryCliFallback,
    canonicalizeJson,
    computeActionDigest,
    verifyActionBinding,
    consumedReceipts,
};
