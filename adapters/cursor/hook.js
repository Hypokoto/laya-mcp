#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { queryLayaPolicy } = require('../common/laya_client');

async function main() {
    let rawInput = '';
    try {
        rawInput = fs.readFileSync(0, 'utf8');
    } catch (err) {
        console.log(JSON.stringify({
            allow: false,
            permission: 'deny',
            message: `Failed to read hook input from stdin: ${err.message}`,
            userMessage: `Failed to read hook input from stdin: ${err.message}`,
            agentMessage: 'Stdin read failure in Cursor Laya adapter',
        }));
        process.exit(0);
    }

    if (!rawInput.trim()) {
        console.log(JSON.stringify({
            allow: false,
            permission: 'deny',
            message: 'Empty hook payload received from stdin',
            userMessage: 'Empty hook payload received from stdin',
            agentMessage: 'Empty stdin payload in Cursor Laya adapter',
        }));
        process.exit(0);
    }

    let payload = {};
    try {
        payload = JSON.parse(rawInput);
    } catch {
        console.log(JSON.stringify({
            allow: false,
            permission: 'deny',
            message: 'Malformed input payload in Cursor Laya adapter',
            userMessage: 'Malformed input payload in Cursor Laya adapter',
            agentMessage: 'Malformed stdin payload in Cursor Laya adapter',
        }));
        process.exit(0);
    }

    const command = payload.command || payload.cmd || '';
    const toolName = payload.tool || (command ? 'run_command' : 'file_op');
    const toolArgs = payload.args || (command ? { command } : payload);
    const workspace = payload.workspace || payload.cwd || process.cwd();

    try {
        const decision = await queryLayaPolicy(toolName, 'execute', workspace, toolArgs);

        switch (decision.enforcement_action) {
            case 'execute':
                console.log(JSON.stringify({
                    allow: true,
                    permission: 'allow',
                }));
                process.exit(0);
                break;
            case 'prompt_user':
                console.log(JSON.stringify({
                    allow: false,
                    ask: true,
                    permission: 'ask',
                    message: decision.reasoning || 'Laya policy requires interactive user confirmation',
                    userMessage: decision.reasoning || 'Laya policy requires interactive user confirmation',
                    agentMessage: `Interactive confirmation required by policy rule ${decision.matched_rule || 'general'}`,
                    user_message: decision.reasoning || 'Laya policy requires interactive user confirmation',
                    agent_message: `Interactive confirmation required by policy rule ${decision.matched_rule || 'general'}`,
                }));
                process.exit(0);
                break;
            case 'block':
            default:
                console.log(JSON.stringify({
                    allow: false,
                    permission: 'deny',
                    message: decision.reasoning || 'Action blocked by Laya security policy',
                    userMessage: decision.reasoning || 'Action blocked by Laya security policy',
                    agentMessage: `Blocked by Laya rule ${decision.matched_rule || 'hard_security_invariant'}`,
                    user_message: decision.reasoning || 'Action blocked by Laya security policy',
                    agent_message: `Blocked by Laya rule ${decision.matched_rule || 'hard_security_invariant'}`,
                }));
                process.exit(0);
                break;
        }
    } catch (err) {
        console.log(JSON.stringify({
            allow: false,
            ask: true,
            permission: 'ask',
            message: `Laya Policy Engine error: ${err.message}. Confirm action manually.`,
            userMessage: `Laya Policy Engine error: ${err.message}. Confirm action manually.`,
            agentMessage: 'Policy engine offline or errored',
            user_message: `Laya Policy Engine error: ${err.message}. Confirm action manually.`,
            agent_message: 'Policy engine offline or errored',
        }));
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
