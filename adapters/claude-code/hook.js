#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { queryLayaPolicy } = require('../common/laya_client');

const READONLY_TOOLS = /^(View|Read|Grep|Glob|LS|view_file|read_file|search_files)$/i;

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

function emit(decision, reason, extra = {}) {
    const output = {
        permissionDecision: decision,
        reason: reason,
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: reason,
        },
    };
    if (extra.ruleId) {
        output.ruleId = extra.ruleId;
        output.hookSpecificOutput.ruleId = extra.ruleId;
    }
    if (extra.actionDigest) {
        output.actionDigest = extra.actionDigest;
        output.hookSpecificOutput.actionDigest = extra.actionDigest;
    }
    console.log(JSON.stringify(output));
}

async function main() {
    let rawInput = '';
    try {
        rawInput = fs.readFileSync(0, 'utf8');
    } catch (err) {
        process.stderr.write(`Laya Claude-Code Adapter: Failed to read stdin: ${err.message}\n`);
        process.exit(2);
    }

    if (!rawInput.trim()) {
        process.stderr.write('Laya Claude-Code Adapter: Empty input payload\n');
        process.exit(2);
    }

    let payload = {};
    try {
        payload = JSON.parse(rawInput);
    } catch {
        // Fail closed on malformed JSON
        process.stderr.write('Laya Claude-Code Adapter: Malformed input payload\n');
        process.exit(2);
    }

    const toolName = payload.tool_name || payload.toolName || payload.tool || '';
    const toolArgs = payload.tool_input || payload.toolInput || payload.args || {};
    const workspace = payload.cwd || process.cwd();

    // Determine operation category
    let operation = 'execute';
    const lower = toolName.toLowerCase();
    if (lower.includes('write') || lower.includes('edit') || lower.includes('patch')) {
        operation = 'write';
    } else if (lower.includes('delete') || lower.includes('remove')) {
        operation = 'delete';
    } else if (READONLY_TOOLS.test(toolName) || lower.includes('read') || lower.includes('view') || lower.includes('grep') || lower.includes('glob') || lower.includes('list')) {
        operation = 'read';
    }

    try {
        const decision = await queryLayaPolicy(toolName, operation, workspace, toolArgs);

        const isDeny = decision.decision === 'DENY' || decision.enforcement_action === 'block';
        const isAuthRequired = decision.decision === 'REQUIRE_AUTHORIZATION' || decision.approval_required === true || decision.enforcement_action === 'prompt_user';

        if (isDeny) {
            const ruleMsg = decision.matched_rule ? `[${decision.matched_rule}] ` : '';
            const reason = decision.reasoning || `${ruleMsg}Blocked by Laya security policy`;
            process.stderr.write(`[LAYA DENIED] ${ruleMsg}${reason}\n`);
            emit('deny', reason, {
                ruleId: decision.matched_rule,
                actionDigest: decision.action_digest,
            });
            process.exit(2);
        } else if (isAuthRequired) {
            const shortDigest = decision.action_digest ? decision.action_digest.slice(0, 8) : 'none';
            const ruleId = decision.matched_rule || 'REQUIRE_AUTHORIZATION';
            const reason = `[Laya Auth Required | rule: ${ruleId} | digest: ${shortDigest}] ${decision.reasoning || 'Action requires interactive human approval'}`;
            emit('ask', reason, {
                ruleId: decision.matched_rule,
                actionDigest: decision.action_digest,
            });
            process.exit(0);
        } else {
            // Clean allow
            process.exit(0);
        }
    } catch (err) {
        // Domain Risk Mapping when Laya policy engine is unreachable:
        // Mutating / shell operations fail closed to DENY (exit code 2)
        // Read / contained operations escalate to human confirmation ASK (exit code 0)
        const isMutating = operation === 'write' || operation === 'delete' || operation === 'execute';
        if (isMutating) {
            process.stderr.write(`[LAYA FAIL-CLOSED] Policy engine unreachable for mutating operation '${operation}': ${err.message}\n`);
            emit('deny', `Laya Policy Engine unreachable for mutating operation '${operation}': ${err.message}. Blocked by fail-closed domain policy.`);
            process.exit(2);
        } else {
            emit('ask', `Laya Policy Engine unreachable for read operation '${operation}': ${err.message}. Escalating to human confirmation.`);
            process.exit(0);
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = { main, computeActionDigest };

