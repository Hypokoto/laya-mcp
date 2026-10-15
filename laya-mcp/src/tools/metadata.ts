import { z } from "zod";
import * as fs from "fs/promises";
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
}
