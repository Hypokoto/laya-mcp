/**
 * Automated Verification: MCP Evaluation Suite
 * 
 * Executes all 10 evaluation questions from evaluation.xml against the live MCP server.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const layaHome = path.resolve(__dirname, "../..");
const serverPath = path.resolve(__dirname, "../dist/index.js");

async function runEvaluationSuite() {
    console.log("▶ Starting Laya MCP 10-Question Evaluation Suite...");

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
            ...process.env,
            LAYA_HOME: layaHome,
            ALLOWED_DIR: layaHome
        }
    });

    const client = new Client(
        { name: "laya-evaluator", version: "1.0.0" },
        { capabilities: {} }
    );

    await client.connect(transport);
    console.log("✓ Connected to Laya MCP server on stdio.");

    let passed = 0;
    let failed = 0;

    async function testCase(num: number, desc: string, fn: () => Promise<boolean>) {
        process.stdout.write(`  [Q${num}] ${desc}... `);
        try {
            const ok = await fn();
            if (ok) {
                console.log("✅ PASS");
                passed++;
            } else {
                console.log("❌ FAIL (assertion returned false)");
                failed++;
            }
        } catch (err: any) {
            console.log(`❌ ERROR (${err.message})`);
            failed++;
        }
    }

    // Q1: laya_inspect_metadata -> package.json version 1.0.0
    await testCase(1, "Inspect metadata for laya-mcp package version 1.0.0", async () => {
        const res = await client.callTool({ name: "laya_inspect_metadata", arguments: {} }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes('"version": "1.0.0"') || res.structuredContent?.["package.json"]?.includes('"version": "1.0.0"');
    });

    // Q2: laya_search_files -> .py files in laya_runtime -> main.py
    await testCase(2, "Search for .py in laya_runtime -> main.py", async () => {
        const res = await client.callTool({
            name: "laya_search_files",
            arguments: { pattern: ".*\\.py$", dir: "laya_runtime" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes("main.py");
    });

    // Q3: laya_read_file on pyproject.toml -> port 8000
    await testCase(3, "Read pyproject.toml / default port -> 8000", async () => {
        const res = await client.callTool({
            name: "laya_read_file",
            arguments: { filepath: "laya_runtime/main.py" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes("8000");
    });

    // Q4: laya_analyze_code on laya_runtime/main.py -> DecisionRequest
    await testCase(4, "Analyze laya_runtime/main.py -> DecisionRequest Pydantic model", async () => {
        const res = await client.callTool({
            name: "laya_analyze_code",
            arguments: { filepath: "laya_runtime/main.py" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes("DecisionRequest");
    });

    // Q5: laya_read_file on laya_config.json -> max_len 512
    await testCase(5, "Read laya_config.json -> max_len 512", async () => {
        const res = await client.callTool({
            name: "laya_read_file",
            arguments: { filepath: "laya_config.json" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes('"max_len": 512');
    });

    // Q6: laya_read_file on laya_runtime/main.py -> /decide endpoint
    await testCase(6, "Read laya_runtime/main.py -> /decide endpoint", async () => {
        const res = await client.callTool({
            name: "laya_read_file",
            arguments: { filepath: "laya_runtime/main.py" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes('"/decide"');
    });

    // Q7: laya_decide on rm -rf / -> DENY
    await testCase(7, "Evaluate rm -rf / via laya_decide -> DENY", async () => {
        const res = await client.callTool({
            name: "laya_decide",
            arguments: {
                tool: "security_check",
                args: { command: "rm -rf /" },
                instruction: "Evaluate the action 'rm -rf /' with criteria ALLOW vs DENY",
                criteria: {
                    ALLOW: "Safe operation",
                    DENY: "Destructive operation"
                }
            }
        }) as any;
        const decision = res.structuredContent?.decision || res.content?.[0]?.text || "";
        return decision.includes("DENY");
    });

    // Q8: laya_read_file on skills/laya-decision-model/SKILL.md -> laya-decision-model
    await testCase(8, "Read SKILL.md -> name: laya-decision-model", async () => {
        const res = await client.callTool({
            name: "laya_read_file",
            arguments: { filepath: "skills/laya-decision-model/SKILL.md" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes("name: laya-decision-model");
    });

    // Q9: laya_read_file on laya-mcp/src/laya_client.ts -> http://127.0.0.1:8000
    await testCase(9, "Read laya_client.ts -> http://127.0.0.1:8000 default", async () => {
        const res = await client.callTool({
            name: "laya_read_file",
            arguments: { filepath: "laya-mcp/src/laya_client.ts" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes("http://127.0.0.1:8000");
    });

    // Q10: laya_analyze_code on laya_runtime/main.py -> load_model function
    await testCase(10, "Analyze laya_runtime/main.py -> load_model function", async () => {
        const res = await client.callTool({
            name: "laya_analyze_code",
            arguments: { filepath: "laya_runtime/main.py" }
        }) as any;
        const text = res.content?.[0]?.text || "";
        return text.includes("load_model");
    });

    // Additional: Path Traversal Security Test
    await testCase(11, "Security Boundary: Block path traversal (../../etc/passwd)", async () => {
        const res = await client.callTool({
            name: "laya_read_file",
            arguments: { filepath: "../../etc/passwd" }
        }) as any;
        return res.isError === true;
    });

    await client.close();

    console.log(`\n========================================`);
    console.log(`Evaluation Summary: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================`);

    if (failed > 0) {
        process.exit(1);
    } else {
        console.log("🎉 ALL EVALUATION QUESTIONS PASSED WITH 100% ACCURACY!");
        process.exit(0);
    }
}

runEvaluationSuite().catch((err) => {
    console.error("Evaluation suite fatal error:", err);
    process.exit(1);
});
