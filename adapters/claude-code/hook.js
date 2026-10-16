#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { queryLayaPolicy } = require('../common/laya_client');

const READONLY_TOOLS = /^(View|Read|Grep|Glob|LS|view_file|read_file|search_files)$/i;

function emit(decision, reason) {
    console.log(JSON.stringify({
        permissionDecision: decision,
        reason: reason,
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: reason,
        },
    }));
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

        switch (decision.enforcement_action) {
            case 'execute':
                // Clean allow
                process.exit(0);
                break;
            case 'prompt_user':
                emit('ask', decision.reasoning || 'Laya policy requires interactive human approval');
                process.exit(0);
                break;
            case 'block':
            default:
                process.stderr.write(`[LAYA DENIED] ${decision.reasoning || 'Blocked by Laya security policy'}\n`);
                emit('deny', decision.reasoning || 'Blocked by Laya security policy');
                process.exit(2);
                break;
        }
    } catch (err) {
        // Fail closed for non-readonly operations
        emit('ask', `Laya Policy Engine unreachable: ${err.message}. Asking user for confirmation.`);
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
