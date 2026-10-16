import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
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
});
