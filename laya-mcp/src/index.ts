#!/usr/bin/env node
/**
 * Laya MCP Server
 * 
 * Provides local file access, command execution, and code structure analysis
 * for the Laya AI Harness.
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

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function ensurePythonServer(): Promise<void> {
    return new Promise((resolve) => {
        // Check if port 8000 is already in use by the Laya server
        const req = http.get("http://localhost:8000/openapi.json", (res) => {
            if (res.statusCode === 200) {
                console.error("Laya Python Server is already running.");
                resolve();
            }
        }).on('error', () => {
            console.error("Laya Python Server not detected. Booting ONNX model in background (this may take ~20s)...");
            
            // Navigate up from dist/ to laya-mcp/ to laya-onnx/
            const rootDir = join(__dirname, "../..");
            const layaRuntimeDir = join(rootDir, "laya_runtime");
            const venvPython = join(rootDir, ".venv/bin/python");
            const mainPy = join(layaRuntimeDir, "main.py");
            
            const pythonProcess = spawn(venvPython, [mainPy], {
                cwd: layaRuntimeDir,
                stdio: 'ignore', // Don't pollute stdio transport
                detached: true
            });
            
            pythonProcess.unref(); // Don't block exit
            
            // Make sure we kill the Python server when the MCP server shuts down
            const cleanup = () => {
                try { process.kill(-pythonProcess.pid!); } catch (e) {}
                try { pythonProcess.kill(); } catch (e) {}
            };
            process.on('exit', cleanup);
            process.on('SIGINT', () => { cleanup(); process.exit(0); });
            process.on('SIGTERM', () => { cleanup(); process.exit(0); });
            
            // Poll until it's ready
            const interval = setInterval(() => {
                http.get("http://localhost:8000/openapi.json", (res) => {
                    if (res.statusCode === 200) {
                        clearInterval(interval);
                        console.error("Laya Python Server is now online.");
                        resolve();
                    }
                }).on('error', () => {}); 
            }, 2000);
        });
    });
}


// Initialize server
const server = new McpServer({
    name: "laya-mcp-server",
    version: "1.0.0"
});

// Register all tools
registerFileTools(server);
registerCommandTools(server);
registerCodeAnalysisTools(server);
registerMetadataTools(server);
registerDecideTools(server);

async function main() {
    console.error(`Starting Laya MCP Server...`);
    console.error(`Allowed directory for operations: ${process.env.ALLOWED_DIR || process.cwd()}`);
    
    // Auto-start Python backend if it's not running
    await ensurePythonServer();
    
    // Check if we want to run as an SSE server (remote/local network accessible)
    const port = process.env.PORT ? parseInt(process.env.PORT) : null;
    
    if (port) {
        const app = express();
        
        let transport: SSEServerTransport;

        app.get("/sse", async (req, res) => {
            transport = new SSEServerTransport("/message", res);
            await server.connect(transport);
            
            // Allow server to handle disconnects properly if needed
            req.on('close', () => {
                console.error("SSE connection closed");
            });
        });

        app.post("/message", async (req, res) => {
            if (!transport) {
                return res.status(400).send("No active SSE connection");
            }
            await transport.handlePostMessage(req, res);
        });

        app.listen(port, "0.0.0.0", () => {
            console.error(`Laya MCP Server running on SSE at http://0.0.0.0:${port}/sse`);
            console.error(`Any AI harness can connect to this endpoint over the local network.`);
        });
    } else {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("Laya MCP Server running on stdio");
    }
}

main().catch(err => {
    console.error("Fatal server error:", err);
    process.exit(1);
});
