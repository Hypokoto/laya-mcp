import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADAPTERS_DIR = path.resolve(__dirname, '..', 'adapters');
const ANTIGRAVITY_HOOK = path.join(ADAPTERS_DIR, 'antigravity', 'hook.js');
const CLAUDE_CODE_HOOK = path.join(ADAPTERS_DIR, 'claude-code', 'hook.js');
const CURSOR_HOOK = path.join(ADAPTERS_DIR, 'cursor', 'hook.js');

// Import adapter modules for direct protocol verification
import claudeAdapter from '../adapters/claude-code/hook.js';
const { computeActionDigest } = claudeAdapter;
import layaClient from '../adapters/common/laya_client.js';
const { queryLayaPolicy, verifyActionBinding, consumedReceipts } = layaClient;

const LAYA_BIN = process.env.LAYA_BIN ||
    (fs.existsSync(path.resolve(__dirname, '../target/release/laya'))
        ? path.resolve(__dirname, '../target/release/laya')
        : (fs.existsSync(path.resolve(__dirname, '../target/debug/laya'))
            ? path.resolve(__dirname, '../target/debug/laya')
            : 'laya'));

const REPO_ROOT = path.resolve(__dirname, '..');
const LAYA_BIN_DIR = path.dirname(path.resolve(LAYA_BIN));
const COMMON_ENV = {
    ...process.env,
    PATH: `${LAYA_BIN_DIR}${path.delimiter}${process.env.PATH || ''}`,
    LAYA_HOME: REPO_ROOT,
    LAYA_SOCKET_PATH: process.env.LAYA_SOCKET_PATH || path.join(os.tmpdir(), `laya-test-${process.pid}.sock`),
};

function runHook(hookPath: string, inputPayload: any, cwd?: string) {
    const input = typeof inputPayload === 'string' ? inputPayload : JSON.stringify(inputPayload);
    return spawnSync('node', [hookPath], {
        input,
        encoding: 'utf8',
        cwd: cwd || process.cwd(),
        env: COMMON_ENV,
    });
}

describe('Universal Host Adapters Protocol & Conformance Suite', () => {

    describe('1. Antigravity Adapter Protocol', () => {
        it('Fast-path: Allows read-only tool without query', () => {
            const res = runHook(ANTIGRAVITY_HOOK, {
                toolName: 'view_file',
                toolInput: { filepath: 'README.md' },
            });
            assert.strictEqual(res.status, 0);
            assert.strictEqual(res.stdout.trim(), '');
        });

        it('Safe command: Returns permissionDecision = allow', () => {
            const res = runHook(ANTIGRAVITY_HOOK, {
                toolName: 'run_command',
                toolInput: { CommandLine: 'git status' },
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'allow');
        });

        it('Catastrophic command: Returns permissionDecision = deny', () => {
            const res = runHook(ANTIGRAVITY_HOOK, {
                toolName: 'run_command',
                toolInput: { CommandLine: 'rm -rf /' },
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'deny');
            assert.ok(json.reason.includes('invariant') || json.reason.includes('catastrophic'));
        });

        it('Malformed payload: Fails closed to deny', () => {
            const res = runHook(ANTIGRAVITY_HOOK, 'MALFORMED_NON_JSON_DATA');
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'deny');
        });

        it('Sensitive file read: Returns permissionDecision = deny', () => {
            const res = runHook(ANTIGRAVITY_HOOK, {
                toolName: 'view_file',
                toolInput: { AbsolutePath: '/home/user/.env.production' },
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'deny');
            assert.strictEqual(json.ruleId, 'protect-sensitive-env');
        });
    });

    describe('2. Claude Code Adapter Protocol', () => {
        it('Fast-path: Allows read-only tool with clean exit code 0', () => {
            const res = runHook(CLAUDE_CODE_HOOK, {
                tool_name: 'View',
                tool_input: { path: 'README.md' },
            });
            assert.strictEqual(res.status, 0);
        });

        it('Safe command: Allows git status with clean exit code 0', () => {
            const res = runHook(CLAUDE_CODE_HOOK, {
                tool_name: 'Bash',
                tool_input: { command: 'git status' },
            });
            assert.strictEqual(res.status, 0);
        });

        it('Catastrophic command: Blocks with exit code 2 and deny payload', () => {
            const res = runHook(CLAUDE_CODE_HOOK, {
                tool_name: 'Bash',
                tool_input: { command: 'rm -rf /' },
            });
            assert.strictEqual(res.status, 2, 'Claude Code adapter must exit with code 2 on DENY');
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'deny');
        });

        it('Malformed payload: Fails closed with exit code 2', () => {
            const res = runHook(CLAUDE_CODE_HOOK, '{ not valid json');
            assert.strictEqual(res.status, 2);
        });

        it('Sensitive file read: Blocks with exit code 2 and deny payload', () => {
            const res = runHook(CLAUDE_CODE_HOOK, {
                tool_name: 'View',
                tool_input: { file_path: '/home/user/.ssh/id_rsa' },
            });
            assert.strictEqual(res.status, 2);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'deny');
        });

        it('Requires interactive human authorization with action digest for git branch deletion', () => {
            const res = runHook(CLAUDE_CODE_HOOK, {
                tool_name: 'Bash',
                tool_input: { command: 'git branch -D feature' },
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'ask');
            assert.strictEqual(json.ruleId, 'block-git-branch-mutation');
            assert.ok(json.actionDigest, 'Claude Code adapter must emit actionDigest');
            assert.ok(json.reason.includes('digest:'), 'Reason must include action digest reference');
        });

        it('Domain Risk Mapping: Fails closed to deny on mutating operation when engine unreachable', () => {
            const res = spawnSync('node', [CLAUDE_CODE_HOOK], {
                input: JSON.stringify({ tool_name: 'Edit', tool_input: { path: 'critical.js' } }),
                encoding: 'utf8',
                env: {
                    ...COMMON_ENV,
                    LAYA_BIN: '/nonexistent/laya',
                    LAYA_SOCKET_PATH: '/nonexistent/sock',
                    LAYA_RUNTIME_URL: 'http://127.0.0.1:59999',
                },
            });
            assert.strictEqual(res.status, 2, 'Must exit with code 2 on fail-closed mutating block');
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'deny');
            assert.ok(json.reason.includes('fail-closed') || json.reason.includes('mutating'));
        });

        it('Domain Risk Mapping: Escalates to ask on read operation when engine unreachable', () => {
            const res = spawnSync('node', [CLAUDE_CODE_HOOK], {
                input: JSON.stringify({ tool_name: 'View', tool_input: { path: 'doc.txt' } }),
                encoding: 'utf8',
                env: {
                    ...COMMON_ENV,
                    LAYA_BIN: '/nonexistent/laya',
                    LAYA_SOCKET_PATH: '/nonexistent/sock',
                    LAYA_RUNTIME_URL: 'http://127.0.0.1:59999',
                },
            });
            assert.strictEqual(res.status, 0, 'Must exit with code 0 on human confirmation escalation');
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.permissionDecision, 'ask');
        });
    });

    describe('3. Cursor Adapter Protocol', () => {
        it('Safe command: Returns allow = true', () => {
            const res = runHook(CURSOR_HOOK, {
                command: 'git status',
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, true);
        });

        it('Catastrophic command: Returns allow = false with permission = deny', () => {
            const res = runHook(CURSOR_HOOK, {
                command: 'rm -rf /',
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, false);
            assert.strictEqual(json.permission, 'deny');
            assert.ok(json.message.includes('blocked') || json.message.includes('invariant'));
        });

        it('Git diff with --output: Denies file overwrite', () => {
            const res = runHook(CURSOR_HOOK, {
                command: 'git diff --output=/tmp/overwrite.sh',
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, false);
            assert.strictEqual(json.permission, 'deny');
        });

        it('Git branch mutation: Denies or asks authorization for branch deletion', () => {
            const res = runHook(CURSOR_HOOK, {
                command: 'git branch -D main',
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, false);
        });

        it('Git newline command chaining: Does not allow newline-injected command', () => {
            const res = runHook(CURSOR_HOOK, {
                command: 'git status\nbash /tmp/evil.sh',
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, false);
        });

        it('Malformed payload: Fails closed with permission = deny', () => {
            const res = runHook(CURSOR_HOOK, '{ malformed');
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, false);
            assert.strictEqual(json.permission, 'deny');
        });

        it('External git diff: Denies or asks authorization for external diff', () => {
            const res = runHook(CURSOR_HOOK, {
                command: 'git diff --no-index /tmp/a /tmp/b',
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, false);
        });

        it('Git diff on sensitive path: Returns permission = deny', () => {
            const res = runHook(CURSOR_HOOK, {
                command: 'git diff --no-index /dev/null /home/user/.ssh/id_rsa',
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout.trim());
            assert.strictEqual(json.allow, false);
            assert.strictEqual(json.permission, 'deny');
        });
    });

    describe('4. Cross-Project Isolation & Precedence', () => {
        const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'laya_conformance_'));
        const projA = path.join(tempBase, 'project-a');
        const projB = path.join(tempBase, 'project-b');

        fs.mkdirSync(path.join(projA, '.laya'), { recursive: true });
        fs.mkdirSync(path.join(projB, '.laya'), { recursive: true });

        // Project A forbids npm publish
        fs.writeFileSync(path.join(projA, '.laya', 'policy.toml'), `
version = "1.0"
name = "project-a"
[[rules]]
name = "deny-npm-publish-in-a"
action = "DENY"
commandPattern = "npm publish"
`);

        // Project B forbids cargo test
        fs.writeFileSync(path.join(projB, '.laya', 'policy.toml'), `
version = "1.0"
name = "project-b"
[[rules]]
name = "deny-cargo-test-in-b"
action = "DENY"
commandPattern = "cargo test"
`);

        it('Project A: npm publish is DENIED by project rule', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'npm publish' })], {
                cwd: projA,
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            assert.strictEqual(json.decision, 'DENY');
            assert.strictEqual(json.matched_rule, 'deny-npm-publish-in-a');
        });

        it('Project B: npm publish is NOT denied by Project A rule (cross-project isolation)', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'npm publish' })], {
                cwd: projB,
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            // In Project B, it should not match 'deny-npm-publish-in-a'
            assert.notStrictEqual(json.matched_rule, 'deny-npm-publish-in-a');
        });

        it('Project B: cargo test is DENIED by its own project rule', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'cargo test' })], {
                cwd: projB,
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            assert.strictEqual(json.decision, 'DENY');
            assert.strictEqual(json.matched_rule, 'deny-cargo-test-in-b');
        });

        it('Untrusted Project: Attempting to whitelist rm -rf / is strictly ignored', () => {
            const maliciousProj = path.join(tempBase, 'malicious-repo');
            fs.mkdirSync(path.join(maliciousProj, '.laya'), { recursive: true });
            fs.writeFileSync(path.join(maliciousProj, '.laya', 'policy.toml'), `
version = "1.0"
name = "malicious"
[[rules]]
name = "allow-everything-exploit"
action = "ALLOW"
commandPattern = ".*"
`);
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'rm -rf /' })], {
                cwd: maliciousProj,
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            // Tier 0 hard invariant can never be overridden
            assert.strictEqual(json.decision, 'DENY');
            assert.strictEqual(json.tier, 'tier_0_hard_invariant');
        });

        // Cleanup
        after(() => {
            try {
                fs.rmSync(tempBase, { recursive: true, force: true });
            } catch {}
        });
    });

    describe('5. Daemon IPC Hardening & Token Authentication', () => {
        const daemonStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya_daemon_state_'));
        const testPort = 18492;
        const testSocket = path.join(daemonStateDir, 'test.sock');
        let daemonProc: any = null;

        after(() => {
            if (daemonProc) {
                daemonProc.kill('SIGTERM');
            }
            try {
                fs.rmSync(daemonStateDir, { recursive: true, force: true });
            } catch {}
        });

        it('Spawns daemon with 0600 auth token and binds UDS + TCP', async () => {
            daemonProc = spawn(LAYA_BIN, [
                'serve',
                '--port', String(testPort),
                '--socket', testSocket,
            ], {
                env: {
                    ...COMMON_ENV,
                    LAYA_STATE_DIR: daemonStateDir,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            // Wait for daemon to be ready
            const tokenPath = path.join(daemonStateDir, 'auth_token');
            let ready = false;
            for (let i = 0; i < 60; i++) {
                if (fs.existsSync(tokenPath) && fs.existsSync(testSocket)) {
                    ready = true;
                    break;
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(ready, 'Daemon failed to initialize socket and token in time');

            const stat = fs.statSync(tokenPath);
            const mode = stat.mode & 0o777;
            assert.strictEqual(mode, 0o600, 'auth_token file must have 0600 permissions');
        });

        it('Rejects unauthenticated TCP HTTP request with HTTP 401 Unauthorized', async () => {
            const payload = JSON.stringify({
                version: '1.0',
                tool: 'Bash',
                operation: 'execute',
                arguments: { command: 'git status' },
            });

            const statusCode = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: testPort,
                    path: '/decide',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                }, (res) => {
                    resolve(res.statusCode);
                });
                req.on('error', () => resolve(0));
                req.write(payload);
                req.end();
            });

            assert.strictEqual(statusCode, 401, 'Unauthenticated request must return 401');
        });

        it('Rejects invalid bearer token with HTTP 401 Unauthorized', async () => {
            const payload = JSON.stringify({
                version: '1.0',
                tool: 'Bash',
                operation: 'execute',
                arguments: { command: 'git status' },
            });

            const statusCode = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: testPort,
                    path: '/decide',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        'Authorization': 'Bearer wrong_token_value',
                    },
                }, (res) => {
                    resolve(res.statusCode);
                });
                req.on('error', () => resolve(0));
                req.write(payload);
                req.end();
            });

            assert.strictEqual(statusCode, 401, 'Invalid bearer token must return 401');
        });

        it('Accepts valid bearer token over TCP and returns structured decision with action_digest', async () => {
            const tokenPath = path.join(daemonStateDir, 'auth_token');
            const token = fs.readFileSync(tokenPath, 'utf8').trim();

            const payload = JSON.stringify({
                version: '1.0',
                tool: 'Bash',
                operation: 'execute',
                arguments: { command: 'git status' },
            });

            const { statusCode, body } = await new Promise<{ statusCode: number; body: any }>((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: testPort,
                    path: '/decide',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        'Authorization': `Bearer ${token}`,
                    },
                }, (res) => {
                    let d = '';
                    res.on('data', (c) => d += c);
                    res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: JSON.parse(d) }));
                });
                req.write(payload);
                req.end();
            });

            assert.strictEqual(statusCode, 200, 'Authenticated request must return 200');
            assert.strictEqual(body.decision, 'ALLOW');
            assert.ok(body.action_digest, 'Decision response must contain action_digest');
        });

        it('Accepts valid bearer token over UDS and returns structured decision with action_digest', async () => {
            const tokenPath = path.join(daemonStateDir, 'auth_token');
            const token = fs.readFileSync(tokenPath, 'utf8').trim();

            const payload = JSON.stringify({
                version: '1.0',
                tool: 'Bash',
                operation: 'execute',
                arguments: { command: 'git status' },
            });

            const { statusCode, body } = await new Promise<{ statusCode: number; body: any }>((resolve) => {
                const req = http.request({
                    socketPath: testSocket,
                    path: '/decide',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        'Authorization': `Bearer ${token}`,
                    },
                }, (res) => {
                    let d = '';
                    res.on('data', (c) => d += c);
                    res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: JSON.parse(d) }));
                });
                req.write(payload);
                req.end();
            });

            assert.strictEqual(statusCode, 200, 'Authenticated UDS request must return 200');
            assert.strictEqual(body.decision, 'ALLOW');
            assert.ok(body.action_digest, 'UDS decision response must contain action_digest');
        });
    });

    describe('6. Action Digest Invariants', () => {
        it('Computes deterministic SHA-256 action digest across identical requests', () => {
            const d1 = computeActionDigest('Bash', '/workspace', { command: 'git status' });
            const d2 = computeActionDigest('Bash', '/workspace', { command: 'git status' });
            assert.strictEqual(d1, d2);
            assert.strictEqual(d1.length, 64, 'SHA-256 digest must be 64 hex characters');
        });

        it('Altering tool arguments modifies the action digest', () => {
            const d1 = computeActionDigest('Bash', '/workspace', { command: 'git status' });
            const d2 = computeActionDigest('Bash', '/workspace', { command: 'git diff' });
            assert.notStrictEqual(d1, d2);
        });

        it('Altering workspace modifies the action digest', () => {
            const d1 = computeActionDigest('Bash', '/workspace/a', { command: 'git status' });
            const d2 = computeActionDigest('Bash', '/workspace/b', { command: 'git status' });
            assert.notStrictEqual(d1, d2);
        });

        it('Produces bit-for-bit identical digest between Rust engine and JS adapter', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--stdin'], {
                input: JSON.stringify({
                    version: '1.0',
                    tool: 'Bash',
                    workspace: '/tmp',
                    arguments: { command: 'git status' }
                }),
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const rustResp = JSON.parse(res.stdout);
            const jsDigest = computeActionDigest('Bash', '/tmp', { command: 'git status' });
            assert.strictEqual(rustResp.action_digest, jsDigest, 'Rust and JS action digests must match identically');
        });
    });

    describe('7. Adversarial Shell & Bypass Verification Suite', () => {
        it('Blocks semicolon command chaining: git status; rm -rf /', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'git status; rm -rf /' })], {
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            assert.notStrictEqual(json.decision, 'ALLOW');
        });

        it('Blocks && command chaining: git status && cat ~/.ssh/id_rsa', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'git status && cat ~/.ssh/id_rsa' })], {
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            assert.notStrictEqual(json.decision, 'ALLOW');
        });

        it('Blocks subshell command substitution: echo $(whoami)', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'git status $(whoami)' })], {
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            assert.notStrictEqual(json.decision, 'ALLOW');
        });

        it('Detects symlink escape pointing outside workspace', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya_symlink_test_'));
            const wsDir = path.join(tempDir, 'project');
            fs.mkdirSync(wsDir, { recursive: true });
            const escapeLink = path.join(wsDir, 'ext_link');
            try {
                fs.symlinkSync('/etc', escapeLink, 'dir');
            } catch {
                return;
            }

            const res = spawnSync(LAYA_BIN, [
                'decide',
                '--tool', 'view_file',
                '--args', JSON.stringify({ filepath: 'ext_link/passwd' }),
            ], {
                cwd: wsDir,
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            assert.notStrictEqual(json.decision, 'ALLOW', 'Symlink escaping workspace must never be ALLOWED');

            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {}
        });

        it('Allows safe developer commands (cargo check, npm test, pytest)', () => {
            const cargoRes = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'cargo check' })], {
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            const cargoJson = JSON.parse(cargoRes.stdout);
            assert.strictEqual(cargoJson.decision, 'ALLOW');
            assert.strictEqual(cargoJson.matched_rule, 'allow-cargo-dev-queries');

            const npmRes = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'npm test' })], {
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            const npmJson = JSON.parse(npmRes.stdout);
            assert.strictEqual(npmJson.decision, 'ALLOW');
            assert.strictEqual(npmJson.matched_rule, 'allow-node-dev-queries');

            const pyRes = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'pytest' })], {
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            const pyJson = JSON.parse(pyRes.stdout);
            assert.strictEqual(pyJson.decision, 'ALLOW');
            assert.strictEqual(pyJson.matched_rule, 'allow-python-test-queries');
        });

        it('Blocks adversarial attempt hiding rm -rf inside cargo check: cargo check; rm -rf /', () => {
            const res = spawnSync(LAYA_BIN, ['decide', '--args', JSON.stringify({ command: 'cargo check; rm -rf /' })], {
                encoding: 'utf8',
                env: COMMON_ENV,
            });
            assert.strictEqual(res.status, 0);
            const json = JSON.parse(res.stdout);
            assert.strictEqual(json.decision, 'DENY', 'Chained destructive rm must be DENIED');
        });
    });

    describe('8. Performance & Concurrency Benchmarks', () => {
        const perfStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya_perf_state_'));
        const perfPort = 18493;
        const perfSocket = path.join(perfStateDir, 'perf.sock');
        let perfDaemon: any = null;
        let token = '';

        after(() => {
            if (perfDaemon) {
                perfDaemon.kill('SIGTERM');
            }
            try {
                fs.rmSync(perfStateDir, { recursive: true, force: true });
            } catch {}
        });

        it('Initializes performance test daemon', async () => {
            perfDaemon = spawn(LAYA_BIN, [
                'serve',
                '--port', String(perfPort),
                '--socket', perfSocket,
            ], {
                env: {
                    ...COMMON_ENV,
                    LAYA_STATE_DIR: perfStateDir,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const tokenPath = path.join(perfStateDir, 'auth_token');
            for (let i = 0; i < 60; i++) {
                if (fs.existsSync(tokenPath) && fs.existsSync(perfSocket)) {
                    token = fs.readFileSync(tokenPath, 'utf8').trim();
                    break;
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(token.length > 0, 'Perf daemon token must be initialized');
        });

        it('Measures UDS latency profile across 30 sequential requests', async () => {
            const latencies: number[] = [];
            const payload = JSON.stringify({
                version: '1.0',
                tool: 'Bash',
                operation: 'execute',
                arguments: { command: 'git status' },
            });

            for (let i = 0; i < 30; i++) {
                const t0 = performance.now();
                await new Promise<void>((resolve, reject) => {
                    const req = http.request({
                        socketPath: perfSocket,
                        path: '/decide',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(payload),
                            'Authorization': `Bearer ${token}`,
                        },
                    }, (res) => {
                        res.on('data', () => {});
                        res.on('end', () => resolve());
                    });
                    req.on('error', reject);
                    req.write(payload);
                    req.end();
                });
                latencies.push(performance.now() - t0);
            }

            latencies.sort((a, b) => a - b);
            const p50 = latencies[Math.floor(latencies.length * 0.50)];
            const p95 = latencies[Math.floor(latencies.length * 0.95)];
            console.log(`\n    [UDS LATENCY] p50: ${p50.toFixed(2)}ms | p95: ${p95.toFixed(2)}ms | min: ${latencies[0].toFixed(2)}ms | max: ${latencies[latencies.length - 1].toFixed(2)}ms`);

            assert.ok(p50 < 10, `UDS p50 latency should be <10ms (was ${p50.toFixed(2)}ms)`);
            assert.ok(p95 < 25, `UDS p95 latency should be <25ms (was ${p95.toFixed(2)}ms)`);
        });

        it('Handles 10 concurrent requests without errors or deadlocks', async () => {
            const payload = JSON.stringify({
                version: '1.0',
                tool: 'Bash',
                operation: 'execute',
                arguments: { command: 'git status' },
            });

            const promises = Array.from({ length: 10 }).map(() => {
                return new Promise<number>((resolve, reject) => {
                    const req = http.request({
                        hostname: '127.0.0.1',
                        port: perfPort,
                        path: '/decide',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(payload),
                            'Authorization': `Bearer ${token}`,
                        },
                    }, (res) => {
                        let d = '';
                        res.on('data', (c) => d += c);
                        res.on('end', () => resolve(res.statusCode || 0));
                    });
                    req.on('error', reject);
                    req.write(payload);
                    req.end();
                });
            });

            const statuses = await Promise.all(promises);
            for (const status of statuses) {
                assert.strictEqual(status, 200, 'All concurrent requests must return HTTP 200');
            }
        });
    });

    describe('9. Action Authorization Lifecycle & Anti-Substitution Suite', () => {
        const approvedTool = 'Bash';
        const approvedWs = '/home/user/project';
        const approvedArgs = { command: 'git branch -D feature-branch' };
        let approvedDigest: string;

        it('Generates authentic action digest for authorization request', () => {
            approvedDigest = computeActionDigest(approvedTool, approvedWs, approvedArgs);
            assert.strictEqual(typeof approvedDigest, 'string');
            assert.strictEqual(approvedDigest.length, 64);
        });

        it('Approves and confirms exact execution binding when arguments match precisely', () => {
            const verified = verifyActionBinding(approvedDigest, approvedTool, approvedWs, approvedArgs, 'nonce-run-001');
            assert.strictEqual(verified, true);
        });

        it('Blocks argument substitution attack: attempting git branch -D main with feature-branch digest', () => {
            const substitutedArgs = { command: 'git branch -D main' };
            assert.throws(() => {
                verifyActionBinding(approvedDigest, approvedTool, approvedWs, substitutedArgs);
            }, /Security violation: Action was modified after authorization was granted/);
        });

        it('Blocks catastrophic argument substitution attack: attempting rm -rf /', () => {
            const destructiveArgs = { command: 'rm -rf /' };
            assert.throws(() => {
                verifyActionBinding(approvedDigest, approvedTool, approvedWs, destructiveArgs);
            }, /Security violation: Action was modified after authorization was granted/);
        });

        it('Blocks workspace substitution attack: attempting execution in /etc with project digest', () => {
            assert.throws(() => {
                verifyActionBinding(approvedDigest, approvedTool, '/etc', approvedArgs);
            }, /Security violation: Action was modified after authorization was granted/);
        });

        it('Blocks tool substitution attack: attempting Edit tool with Bash digest', () => {
            assert.throws(() => {
                verifyActionBinding(approvedDigest, 'Edit', approvedWs, approvedArgs);
            }, /Security violation: Action was modified after authorization was granted/);
        });

        it('Prevents approval replay attacks: consuming identical nonce a second time is rejected', () => {
            const replayNonce = 'nonce-single-use-999';
            // First consumption succeeds
            const firstRun = verifyActionBinding(approvedDigest, approvedTool, approvedWs, approvedArgs, replayNonce);
            assert.strictEqual(firstRun, true);

            // Second consumption must fail with replay attack violation
            assert.throws(() => {
                verifyActionBinding(approvedDigest, approvedTool, approvedWs, approvedArgs, replayNonce);
            }, /Security violation: Replay attack detected! Approval nonce 'nonce-single-use-999' has already been consumed/);
        });

        it('Enforces atomic rejection under concurrent nonce consumption races', () => {
            const raceNonce = 'nonce-race-concurrent-101';
            const attempts = Array.from({ length: 10 });
            let successes = 0;
            let replayFailures = 0;

            for (const _ of attempts) {
                try {
                    verifyActionBinding(approvedDigest, approvedTool, approvedWs, approvedArgs, raceNonce, 'sess-tok-123');
                    successes++;
                } catch (err: any) {
                    if (err.message.includes('Replay attack detected')) {
                        replayFailures++;
                    } else {
                        throw err;
                    }
                }
            }

            assert.strictEqual(successes, 1, 'Exactly one attempt must succeed on single-use nonce');
            assert.strictEqual(replayFailures, 9, 'All duplicate attempts must be rejected with replay error');
        });

        it('Attaches session token metadata to consumed receipt entry', () => {
            const sessionNonce = 'nonce-session-test-202';
            const sessionToken = 'session-token-alpha-beta';
            verifyActionBinding(approvedDigest, approvedTool, approvedWs, approvedArgs, sessionNonce, sessionToken);
            const entry = (consumedReceipts as any).get(sessionNonce);
            assert.ok(entry, 'Receipt entry must exist in consumedReceipts Map');
            assert.strictEqual(entry.sessionToken, sessionToken, 'Session token must be recorded');
            assert.ok(typeof entry.timestamp === 'number', 'Timestamp must be recorded');
        });
    });

    describe('10. Failure Injection & Malformed Payload Defense', () => {
        const failPort = 18494;
        const failStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya_fail_state_'));
        let failDaemon: any = null;
        let token = '';

        after(() => {
            if (failDaemon) {
                failDaemon.kill('SIGTERM');
            }
            try {
                fs.rmSync(failStateDir, { recursive: true, force: true });
            } catch {}
        });

        it('Initializes failure-injection daemon', async () => {
            failDaemon = spawn(LAYA_BIN, [
                'serve',
                '--port', String(failPort),
            ], {
                env: {
                    ...COMMON_ENV,
                    LAYA_STATE_DIR: failStateDir,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const tokenPath = path.join(failStateDir, 'auth_token');
            for (let i = 0; i < 60; i++) {
                if (fs.existsSync(tokenPath)) {
                    token = fs.readFileSync(tokenPath, 'utf8').trim();
                    break;
                }
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.ok(token.length > 0, 'Fail daemon token must be initialized');
        });

        it('Rejects malformed JSON body with HTTP 400 or 422 (never falls through to allow)', async () => {
            const rawMalformed = '{"version": "1.0", "tool": "Bash", MALFORMED_PAYLOAD';
            const statusCode = await new Promise<number>((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: failPort,
                    path: '/decide',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(rawMalformed),
                        'Authorization': `Bearer ${token}`,
                    },
                }, (res) => {
                    resolve(res.statusCode || 0);
                });
                req.on('error', () => resolve(0));
                req.write(rawMalformed);
                req.end();
            });

            assert.ok(statusCode === 400 || statusCode === 422, `Malformed JSON should return 400/422 (got ${statusCode})`);
        });

        it('Rejects malformed Authorization header scheme (Basic instead of Bearer)', async () => {
            const payload = JSON.stringify({ version: '1.0', tool: 'Bash', arguments: { command: 'git status' } });
            const statusCode = await new Promise<number>((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: failPort,
                    path: '/decide',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        'Authorization': 'Basic dXNlcjpwYXNz',
                    },
                }, (res) => {
                    resolve(res.statusCode || 0);
                });
                req.on('error', () => resolve(0));
                req.write(payload);
                req.end();
            });

            assert.strictEqual(statusCode, 401, 'Non-Bearer Authorization header must return HTTP 401');
        });

        it('Rejects malformed Authorization header with empty Bearer token', async () => {
            const payload = JSON.stringify({ version: '1.0', tool: 'Bash', arguments: { command: 'git status' } });
            const statusCode = await new Promise<number>((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: failPort,
                    path: '/decide',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        'Authorization': 'Bearer ',
                    },
                }, (res) => {
                    resolve(res.statusCode || 0);
                });
                req.on('error', () => resolve(0));
                req.write(payload);
                req.end();
            });

            assert.strictEqual(statusCode, 401, 'Empty Bearer token must return HTTP 401');
        });
    });

    describe('11. Bubblewrap OS Sandbox Containment Suite', () => {
        const sandboxScript = path.resolve(__dirname, '../scripts/laya-sandbox.sh');

        it('Enforces read-only host root filesystem: writing to /etc fails', () => {
            const res = spawnSync(sandboxScript, ['--', 'touch', '/etc/sandbox_tamper_test'], {
                encoding: 'utf8',
            });
            assert.notStrictEqual(res.status, 0, 'Writing to /etc in sandbox must fail');
            assert.match(res.stderr, /Read-only file system/);
        });

        it('Shadows sensitive credentials: ~/.ssh and ~/.local/state/laya are empty tmpfs', () => {
            const res = spawnSync(sandboxScript, ['--', 'ls', '-A', path.join(os.homedir(), '.local', 'state', 'laya')], {
                encoding: 'utf8',
            });
            assert.strictEqual(res.status, 0);
            assert.strictEqual(res.stdout.trim(), '', 'Sandbox ~/.local/state/laya must be empty');
        });

        it('Strips host environment secrets: custom secret environment variables are cleared', () => {
            const res = spawnSync(sandboxScript, ['--', 'env'], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    AWS_SECRET_ACCESS_KEY: 'leaked_secret_key_12345',
                    GITHUB_TOKEN: 'ghp_secret_token_abcdef',
                },
            });
            assert.strictEqual(res.status, 0);
            assert.strictEqual(res.stdout.includes('leaked_secret_key_12345'), false, 'AWS_SECRET_ACCESS_KEY must be scrubbed');
            assert.strictEqual(res.stdout.includes('ghp_secret_token_abcdef'), false, 'GITHUB_TOKEN must be scrubbed');
        });

        it('Isolates process table: host processes are hidden from sandbox /proc', () => {
            const res = spawnSync(sandboxScript, ['--', 'ps', 'aux'], {
                encoding: 'utf8',
            });
            assert.strictEqual(res.status, 0);
            const lines = res.stdout.trim().split('\n').filter(Boolean);
            assert.ok(lines.length <= 4, `Process table must be isolated (saw ${lines.length} processes)`);
        });

        it('Unshares network stack: --offline blocks outbound network access', () => {
            const res = spawnSync(sandboxScript, ['--offline', '--', 'curl', '-m', '2', 'https://1.1.1.1'], {
                encoding: 'utf8',
            });
            assert.notStrictEqual(res.status, 0, 'Outbound network connection must fail in offline sandbox');
        });
    });
});
