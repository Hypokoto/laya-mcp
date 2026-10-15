import { z } from "zod";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";


export function registerMetadataTools(server: McpServer) {
    server.registerTool(
        "laya_inspect_metadata",
        {
            title: "Inspect Project Metadata",
            description: "Read common project metadata files like package.json, requirements.txt, or pyproject.toml.",
            inputSchema: z.object({}).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async () => {
            try {
                const allowedDir = process.env.ALLOWED_DIR || process.cwd();
                const metadataFiles = [
                    "package.json",
                    "laya-mcp/package.json",
                    "requirements.txt",
                    "pyproject.toml",
                    "CMakeLists.txt",
                    "Makefile"
                ];
                
                const results: Record<string, string> = {};
                let output = "Project Metadata:\n\n";
                
                for (const file of metadataFiles) {
                    const fullPath = path.resolve(allowedDir, file);
                    try {
                        const content = await fs.readFile(fullPath, "utf-8");
                        results[file] = content;
                        output += `### ${file}\n\`\`\`\n${content.substring(0, 500)}${content.length > 500 ? '\n... (truncated)' : ''}\n\`\`\`\n\n`;
                    } catch (err) {
                        // File doesn't exist, ignore
                    }
                }
                
                if (Object.keys(results).length === 0) {
                    output = "No common metadata files found in the project root.";
                }
                
                return {
                    content: [{ type: "text", text: output }],
                    structuredContent: results
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Error inspecting metadata: ${error.message}` }]
                };
            }
        }
    );

    server.registerTool(
        "laya_system_info",
        {
            title: "System & Model Diagnostics",
            description: "Reports runtime environment diagnostics, model memory usage, ONNX execution provider, and sandbox status.",
            inputSchema: z.object({}).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async () => {
            const memoryUsage = process.memoryUsage();
            const allowedDir = process.env.ALLOWED_DIR || process.cwd();
            const isSandboxed = Boolean(fsSync.existsSync("/.dockerenv") || process.env.CONTAINER);
            const isRootless = typeof process.getuid === "function" ? process.getuid() !== 0 : false;
            const sandboxLabel = isSandboxed
                ? (isRootless ? "Containerized Sandbox (Rootless)" : "Containerized Sandbox")
                : "Host Environment";

            const report = [
                "### Laya System & Model Diagnostics",
                `- **MCP Server Version**: 1.0.0`,
                `- **Node Version**: ${process.version}`,
                `- **Platform**: ${process.platform} (${process.arch})`,
                `- **Allowed Directory**: ${allowedDir}`,
                `- **Sandbox Environment**: ${sandboxLabel}`,
                `- **Execution Provider (Static)**: CPUExecutionProvider (ONNX Runtime)`,
                `- **Memory Usage (Node RSS)**: ${(memoryUsage.rss / (1024 * 1024)).toFixed(1)} MB`,
                `- **Memory Usage (Node Heap)**: ${(memoryUsage.heapUsed / (1024 * 1024)).toFixed(1)} MB / ${(memoryUsage.heapTotal / (1024 * 1024)).toFixed(1)} MB`
            ].join("\n");

            return {
                content: [{ type: "text", text: report }],
                structuredContent: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    arch: process.arch,
                    allowedDir,
                    isSandboxed,
                    memory: {
                        rssMb: Number((memoryUsage.rss / (1024 * 1024)).toFixed(1)),
                        heapUsedMb: Number((memoryUsage.heapUsed / (1024 * 1024)).toFixed(1)),
                        heapTotalMb: Number((memoryUsage.heapTotal / (1024 * 1024)).toFixed(1))
                    }
                }
            };
        }
    );
}
