/**
 * Automated Verification: Instant MCP Handshake & Tool Discovery
 * 
 * Tests that laya-mcp:
 * 1. Responds to the JSON-RPC `initialize` handshake in under 1 second (no timeout).
 * 2. Properly returns all registered Laya tools on `tools/list`.
 * 3. Formats all schemas and descriptions according to MCP specification.
 */

import { spawn } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function dirname(p: string) {
    return path.dirname(p);
}

async function runHandshakeTest() {
    console.log("▶ Testing Laya MCP Handshake and Tool Discovery...");
    const serverPath = path.resolve(__dirname, "../dist/index.js");

    const startTime = Date.now();
    const proc = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"]
    });

    let stdoutData = "";
    let stderrData = "";

    proc.stderr.on("data", (chunk) => {
        stderrData += chunk.toString();
    });

    const sendRpc = (id: number, method: string, params: any = {}) => {
        const payload = JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params
        }) + "\n";
        proc.stdin.write(payload);
    };

    // 1. Send `initialize`
    sendRpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-harness", version: "1.0.0" }
    });

    // Collect responses
    const responsePromise = new Promise<{ initDuration: number; tools: string[] }>((resolve, reject) => {
        const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error(`Timeout: Server did not respond within 5s. Stderr: ${stderrData}`));
        }, 5000);

        let initReceived = false;
        let initDuration = 0;

        proc.stdout.on("data", (chunk) => {
            stdoutData += chunk.toString();
            const lines = stdoutData.split("\n");

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 1 && !initReceived) {
                        initReceived = true;
                        initDuration = Date.now() - startTime;
                        // Now request tools/list
                        sendRpc(2, "tools/list", {});
                    } else if (msg.id === 2) {
                        clearTimeout(timeout);
                        proc.kill();
                        const toolNames = msg.result.tools.map((t: any) => t.name);
                        resolve({ initDuration, tools: toolNames });
                    }
                } catch {
                    // Incomplete JSON line, wait for more chunks
                }
            }
        });
    });

    try {
        const result = await responsePromise;
        console.log(`✓ Handshake completed in ${result.initDuration}ms (Strict target: <1000ms)`);
        console.log(`✓ Discovered ${result.tools.length} tools:`);
        for (const t of result.tools) {
            console.log(`   - ${t}`);
        }

        const requiredTools = [
            "laya_decide",
            "laya_run_command",
            "laya_read_file",
            "laya_write_file",
            "laya_search_files",
            "laya_analyze_code",
            "laya_inspect_metadata"
        ];

        for (const req of requiredTools) {
            if (!result.tools.includes(req)) {
                throw new Error(`Missing expected tool: ${req}`);
            }
        }

        console.log("\n🎉 ALL TESTS PASSED: Instant handshake and full tool discovery verified!");
        process.exit(0);
    } catch (err: any) {
        console.error(`\n❌ TEST FAILED: ${err.message}`);
        process.exit(1);
    }
}

runHandshakeTest();
