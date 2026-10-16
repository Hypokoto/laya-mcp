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

/**
 * Sends a decision request via Unix Domain Socket.
 */
function queryUnixSocket(requestObj, socketPath, timeoutMs = 800) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(socketPath)) {
            return reject(new Error(`Socket file does not exist: ${socketPath}`));
        }

        const payload = JSON.stringify(requestObj);
        const req = http.request(
            {
                socketPath,
                path: '/decide',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
                timeout: timeoutMs,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
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
        const req = http.request(
            {
                hostname: u.hostname,
                port: u.port || 8000,
                path: u.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
                timeout: timeoutMs,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
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
 * Fallback: invokes the globally installed `laya` CLI binary with `--stdin`.
 */
function queryCliFallback(requestObj) {
    const payload = JSON.stringify(requestObj);
    const result = spawnSync('laya', ['decide', '--stdin'], {
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
 * 1. Unix Domain Socket (0600 owner-only IPC, <0.5ms)
 * 2. CLI Subprocess Fallback (local process boundary, ~25ms)
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

    // 1. Try Unix Domain Socket (owner-only 0600 permissions)
    const sockPath = getSocketPath();
    try {
        const res = await queryUnixSocket(requestObj, sockPath);
        if (res && res.decision) return res;
    } catch {}

    // 2. Fallback to authenticated CLI subprocess
    return queryCliFallback(requestObj);
}

module.exports = {
    queryLayaPolicy,
    getSocketPath,
    getHttpUrl,
};
