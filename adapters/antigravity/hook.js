#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { queryLayaPolicy } = require('../common/laya_client');

const READONLY_TOOLS = /^(view_file|read_file|laya_read_file|read_files|laya_read_files|read|grep|search_files|list_dir|listdir|ls|glob)$/i;

async function main() {
    let rawInput = '';
    try {
        rawInput = fs.readFileSync(0, 'utf8');
    } catch (err) {
        console.log(JSON.stringify({
            permissionDecision: 'deny',
            reason: `Failed to read hook input from stdin: ${err.message}`,
        }));
        process.exit(0);
    }

    if (!rawInput.trim()) {
        console.log(JSON.stringify({
            permissionDecision: 'deny',
            reason: 'Empty hook payload received from stdin',
        }));
        process.exit(0);
    }

    let payload = {};
    try {
        payload = JSON.parse(rawInput);
    } catch {
        // Untrusted / malformed JSON fails closed
        console.log(JSON.stringify({
            permissionDecision: 'deny',
            reason: 'Malformed JSON payload received by Antigravity Laya adapter',
        }));
        process.exit(0);
    }

    const toolName = payload.toolName || payload.tool || payload.name || '';
    const toolArgs = payload.toolInput || payload.toolArgs || payload.arguments || payload.args || {};
    const workspace = payload.cwd || payload.workspaceRoot || payload.workspace_root || process.cwd();

    // Determine operation category
    let operation = 'execute';
    const lower = toolName.toLowerCase();
    if (lower.includes('write') || lower.includes('edit') || lower.includes('replace') || lower.includes('append')) {
        operation = 'write';
    } else if (lower.includes('delete') || lower.includes('remove')) {
        operation = 'delete';
    } else if (READONLY_TOOLS.test(toolName) || lower.includes('read') || lower.includes('view') || lower.includes('grep') || lower.includes('glob') || lower.includes('list')) {
        operation = 'read';
    } else if (lower.includes('search_web') || lower.includes('read_url_content') || lower.includes('fetch') || lower.includes('http')) {
        operation = 'network';
    }

    try {
        const decision = await queryLayaPolicy(toolName, operation, workspace, toolArgs);

        switch (decision.enforcement_action) {
            case 'execute':
                // Allowed: if read operation, exit 0 silently; otherwise emit allow
                if (operation === 'read') {
                    process.exit(0);
                }
                console.log(JSON.stringify({ permissionDecision: 'allow' }));
                process.exit(0);
                break;
            case 'prompt_user':
                console.log(JSON.stringify({
                    permissionDecision: 'ask',
                    reason: decision.reasoning || 'Laya policy requires interactive human authorization',
                    riskCategory: decision.risk_category || 'general',
                    tier: decision.tier,
                }));
                process.exit(0);
                break;
            case 'block':
            default:
                console.log(JSON.stringify({
                    permissionDecision: 'deny',
                    reason: decision.reasoning || 'Blocked by Laya security policy',
                    ruleId: decision.matched_rule,
                    tier: decision.tier,
                }));
                process.exit(0);
                break;
        }
    } catch (err) {
        // Fail closed on error for non-readonly operations
        console.log(JSON.stringify({
            permissionDecision: 'ask',
            reason: `Laya Policy Engine offline or error: ${err.message}. Prompting user for safety.`,
        }));
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
