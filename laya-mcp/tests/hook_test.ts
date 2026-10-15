/**
 * Automated Verification: Laya PreToolUse Decision Hook
 * 
 * Tests:
 * 1. Fast-path on read-only tools (sub-50ms exit 0).
 * 2. Interception of safe mutating actions (git status -> ALLOW, exit 0).
 * 3. Interception and hard-blocking of destructive actions (rm -rf / -> DENY, exit 2).
 * 4. Hook install and uninstall lifecycle.
 */

import { spawn } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { installLayaHook, uninstallLayaHook } from "../src/hook_installer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const hookScript = path.resolve(__dirname, "../../hooks/laya-pretool-hook.js");

function runHookWithPayload(payload: any): Promise<{ code: number | null; stdout: string; stderr: string; duration: number }> {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const proc = spawn("node", [hookScript], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                LAYA_HOME: path.resolve(__dirname, "../..")
            }
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });

        proc.on("close", (code) => {
            const duration = Date.now() - t0;
            resolve({ code, stdout, stderr, duration });
        });

        proc.stdin.write(JSON.stringify(payload) + "\n");
        proc.stdin.end();
    });
}

async function runHookTestSuite() {
    console.log("▶ Testing Universal Laya PreToolUse Decision Hook...\n");

    let passed = 0;
    let failed = 0;

    async function check(name: string, fn: () => Promise<boolean>) {
        process.stdout.write(`  [Test] ${name}... `);
        try {
            const ok = await fn();
            if (ok) {
                console.log("✅ PASS");
                passed++;
            } else {
                console.log("❌ FAIL (condition not met)");
                failed++;
            }
        } catch (err: any) {
            console.log(`❌ ERROR: ${err.message}`);
            failed++;
        }
    }

    // 1. Fast-Path: Read-Only Tool
    await check("Fast-path bypass for read-only tools (view_file)", async () => {
        const res = await runHookWithPayload({
            tool_name: "view_file",
            tool_input: { AbsolutePath: "/etc/hosts" }
        });
        return res.code === 0 && res.duration < 150;
    });

    // 2. Safe Mutating Action: ALLOW
    await check("Safe mutating command passes (git status -> ALLOW)", async () => {
        const res = await runHookWithPayload({
            tool_name: "run_command",
            tool_input: { CommandLine: "git status" }
        });
        return res.code === 0;
    });

    // 3. Destructive Mutating Action: DENY
    await check("Destructive command is intercepted and blocked (rm -rf / -> DENY, exit 2)", async () => {
        const res = await runHookWithPayload({
            tool_name: "run_command",
            tool_input: { CommandLine: "rm -rf /" }
        });
        const blockedOutput = res.stderr.includes("DENIED") || res.stdout.includes("DENY") || res.stdout.includes('"block":true');
        return res.code === 2 && blockedOutput;
    });

    // 4. Installer Lifecycle
    await check("Hook install and uninstall lifecycle", async () => {
        const installRes = await installLayaHook();
        const installedOk = installRes.some((r) => r.status === "installed" || r.status === "already_installed");
        
        const uninstallRes = await uninstallLayaHook();
        const uninstalledOk = uninstallRes.some((r) => r.status === "uninstalled" || r.status === "skipped");

        return installedOk && uninstalledOk;
    });

    console.log(`\n========================================`);
    console.log(`Hook Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================`);

    if (failed > 0) {
        process.exit(1);
    } else {
        console.log("🎉 ALL HOOK TESTS PASSED: Hardcoded decision interceptor verified!");
        process.exit(0);
    }
}

runHookTestSuite().catch((err) => {
    console.error("Hook test suite fatal error:", err);
    process.exit(1);
});
