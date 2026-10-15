#!/usr/bin/env node
/**
 * Laya MCP Server (Model Context Protocol)
 * 
 * Production-ready MCP server that seamlessly connects with any AI harness
 * (Claude Desktop, Cursor, Windsurf, Claude Code, Cline, Continue, etc.).
 * 
 * Features:
 * - Sub-100ms instant stdio/HTTP handshake to prevent client timeouts
 * - Non-blocking asynchronous Python ONNX model warmup
 * - Dual transport (stdio + Streamable HTTP/SSE with CORS)
 * - Calibrated decision making, security policy enforcement & code analysis
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";

import { registerFileTools } from "./tools/file_ops.js";
import { registerCommandTools } from "./tools/command_ops.js";
import { registerCodeAnalysisTools } from "./tools/code_analysis.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerDecideTools } from "./tools/decide.js";
import { isRuntimeHealthy } from "./laya_client.js";
import { setupAllHarnesses } from "./setup.js";
import { installLayaHook, uninstallLayaHook } from "./hook_installer.js";

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import * as fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolves the root directory of the Laya repository.
 */
function resolveLayaHome(): string {
    if (process.env.LAYA_HOME && fs.existsSync(process.env.LAYA_HOME)) {
        return process.env.LAYA_HOME;
    }
    // Traverse upwards from dist/ or src/ to repository root
    const candidate = resolve(__dirname, "../..");
    if (fs.existsSync(join(candidate, "laya_runtime"))) {
        return candidate;
    }
    return process.cwd();
}

/**
 * Asynchronously warms up the Python ONNX backend without blocking the MCP handshake.
 */
let pythonSpawned = false;

async function triggerPythonWarmup(): Promise<void> {
    if (pythonSpawned) return;

    // Check if Python engine is already alive
    if (await isRuntimeHealthy()) {
        console.error("✓ Laya Python ONNX Engine is active and ready.");
        return;
    }

    pythonSpawned = true;
    console.error("ℹ Laya Python ONNX Engine not detected. Warming up in background (takes ~15-20s)...");

    const layaHome = resolveLayaHome();
    const layaRuntimeDir = join(layaHome, "laya_runtime");
    const venvPython = join(layaHome, ".venv/bin/python");
    const mainPy = join(layaRuntimeDir, "main.py");

    const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3";

    try {
        const pythonProcess = spawn(pythonBin, [mainPy], {
            cwd: layaRuntimeDir,
            stdio: "ignore", // Prevent stdout interference with MCP stdio protocol
            detached: true
        });

        pythonProcess.unref();

        const cleanup = () => {
            try {
                if (pythonProcess.pid) process.kill(-pythonProcess.pid);
            } catch {}
            try {
                pythonProcess.kill();
            } catch {}
        };

        process.on("exit", cleanup);
        process.on("SIGINT", () => { cleanup(); process.exit(0); });
        process.on("SIGTERM", () => { cleanup(); process.exit(0); });

        // Poll asynchronously in background
        const checkInterval = setInterval(async () => {
            if (await isRuntimeHealthy()) {
                clearInterval(checkInterval);
                console.error("✓ Laya Python ONNX Engine is now online and serving inferences.");
            }
        }, 1500);

        // Stop polling after 45 seconds to avoid infinite timers
        setTimeout(() => clearInterval(checkInterval), 45000);
    } catch (err: any) {
        console.error(`⚠ Warning: Could not auto-spawn Python backend: ${err.message}.`);
        console.error(`  Please start the engine manually via: cd laya_runtime && python main.py`);
    }
}

/**
 * Initializes and registers all tools on the McpServer.
 */
function createLayaMcpServer(): McpServer {
    const server = new McpServer({
        name: "laya-mcp",
        version: "1.0.0"
    });

    registerFileTools(server);
    registerCommandTools(server);
    registerCodeAnalysisTools(server);
    registerMetadataTools(server);
    registerDecideTools(server);

    return server;
}

async function main() {
    const args = process.argv.slice(2);

    // Subcommand: setup harnesses
    if (args.includes("setup") || args.includes("--setup")) {
        console.error("🔍 Detecting installed AI harnesses...");
        const results = await setupAllHarnesses();
        console.log("\n=================================================");
        console.log("       Laya MCP Harness Setup Results");
        console.log("=================================================");
        for (const res of results) {
            const icon = res.status === "configured" || res.status === "created" ? "✅" : res.status === "skipped" ? "⚪" : "❌";
            console.log(`${icon} ${res.harness}: ${res.message}`);
            if (res.status !== "skipped") {
                console.log(`   Config: ${res.path}`);
            }
        }
        console.log("=================================================\n");
        process.exit(0);
    }

    // Subcommand: hook:install
    if (args.includes("hook:install") || args.includes("--hook-install")) {
        console.error("🔒 Installing hardcoded Laya PreToolUse hook into AI harnesses...");
        const results = await installLayaHook();
        console.log("\n=================================================");
        console.log("       Laya PreToolUse Hook Installation");
        console.log("=================================================");
        for (const res of results) {
            const icon = res.status === "installed" || res.status === "already_installed" ? "✅" : res.status === "skipped" ? "⚪" : "❌";
            console.log(`${icon} ${res.harness}: ${res.message}`);
            console.log(`   Settings: ${res.path}`);
        }
        console.log("=================================================\n");
        process.exit(0);
    }

    // Subcommand: hook:uninstall
    if (args.includes("hook:uninstall") || args.includes("--hook-uninstall")) {
        console.error("🔓 Uninstalling Laya PreToolUse hook from AI harnesses...");
        const results = await uninstallLayaHook();
        console.log("\n=================================================");
        console.log("       Laya PreToolUse Hook Removal");
        console.log("=================================================");
        for (const res of results) {
            const icon = res.status === "uninstalled" ? "✅" : "⚪";
            console.log(`${icon} ${res.harness}: ${res.message}`);
        }
        console.log("=================================================\n");
        process.exit(0);
    }

    if (args.includes("--help") || args.includes("-h")) {
        console.log(`
Laya MCP Server — Universal AI Decision & Policy Engine

Usage:
  npx laya-mcp                Start in standard stdio mode (for Claude Desktop, Cursor, etc.)
  npx laya-mcp setup          Auto-configure Laya in all installed AI harnesses
  npx laya-mcp hook:install   Install hardcoded PreToolUse decision hook into Antigravity/Cursor
  npx laya-mcp hook:uninstall Remove PreToolUse decision hook
  npx laya-mcp --http [port]  Start HTTP/SSE server (default port: 3000)

Options:
  --http, -p [port]     Run HTTP/SSE server on specified port (or PORT env var)
  --setup               Scan and configure installed AI harnesses
  --hook-install        Install PreToolUse decision hook in AI harnesses
  --hook-uninstall      Uninstall PreToolUse decision hook
  --help, -h            Show this help message

Environment Variables:
  PORT                  Port for HTTP/SSE server (e.g. 3000)
  LAYA_HOME             Path to laya-onnx repository root
  LAYA_RUNTIME_URL      URL of the Python Laya backend (default: http://127.0.0.1:8000)
  ALLOWED_DIR           Directory root for file/command operations
`);
        process.exit(0);
    }

    const server = createLayaMcpServer();

    // Trigger Python model warmup asynchronously in background
    triggerPythonWarmup().catch((err) => {
        console.error("Background warmup error:", err);
    });

    // Check for HTTP/SSE mode
    const httpArgIdx = args.findIndex((a) => a === "--http" || a === "-p");
    let port = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
    if (httpArgIdx !== -1) {
        const nextArg = args[httpArgIdx + 1];
        port = nextArg && !nextArg.startsWith("-") ? parseInt(nextArg, 10) : (port || 3000);
    }

    if (port) {
        const app = express();

        // Enable CORS for browser-based AI agents & web extensions
        app.use((req, res, next) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Bypass-Tunnel-Reminder");
            if (req.method === "OPTIONS") {
                return res.sendStatus(204);
            }
            next();
        });

        // Health endpoint
        app.get("/health", async (req, res) => {
            const pythonReady = await isRuntimeHealthy();
            res.json({
                status: "ok",
                mcp: "connected",
                pythonEngine: pythonReady ? "online" : "warming_up",
                timestamp: new Date().toISOString()
            });
        });

        let sseTransport: SSEServerTransport | null = null;

        app.get("/sse", async (req, res) => {
            sseTransport = new SSEServerTransport("/message", res);
            await server.connect(sseTransport);
            req.on("close", () => {
                console.error("SSE connection closed by client");
            });
        });

        app.post("/message", async (req, res) => {
            if (!sseTransport) {
                return res.status(400).json({ error: "No active SSE transport connection." });
            }
            await sseTransport.handlePostMessage(req, res);
        });

        app.listen(port, "0.0.0.0", () => {
            console.error(`\n🚀 Laya MCP Server running on HTTP/SSE at:`);
            console.error(`   SSE Endpoint:    http://0.0.0.0:${port}/sse`);
            console.error(`   Health Status:   http://0.0.0.0:${port}/health`);
            console.error(`Ready for connections from web harnesses and local agents.\n`);
        });
    } else {
        // Standard stdio transport for desktop/CLI harnesses
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("⚡ Laya MCP Server connected on stdio (instant handshake active)");
    }
}

main().catch((err) => {
    console.error("Fatal Laya MCP server error:", err);
    process.exit(1);
});
