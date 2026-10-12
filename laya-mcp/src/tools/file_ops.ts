import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat } from "../types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authorizeAction, PolicyDecision } from "../laya_client.js";

// Ensure all paths are restricted to the ALLOWED_DIR
function sanitizePath(requestedPath: string): string {
    if (!requestedPath || typeof requestedPath !== "string") {
        throw new Error("Invalid path parameter");
    }
    if (requestedPath.indexOf("\0") !== -1) {
        throw new Error("Null bytes are not allowed in path");
    }
    const cleanPath = requestedPath.replace(/\0/g, "").replace(/^(\.\.[\/\\])+/, "");
    const allowedDir = path.resolve(process.env.ALLOWED_DIR || process.cwd());
    const resolvedPath = path.resolve(allowedDir, cleanPath);
    const relative = path.relative(allowedDir, resolvedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Access denied: Cannot access files outside the allowed directory (${allowedDir})`);
    }
    return resolvedPath;
}

export function registerFileTools(server: McpServer) {
    server.registerTool(
        "laya_read_file",
        {
            title: "Read File",
            description: "Read the contents of a file within the project directory.",
            inputSchema: z.object({
                filepath: z.string().describe("Path to the file to read (relative to the project root)"),
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ filepath }) => {
            try {
                const fullPath = sanitizePath(filepath);
                const content = await fs.readFile(fullPath, "utf-8");
                let textContent = content;
                if (content.length > CHARACTER_LIMIT) {
                    textContent = content.substring(0, CHARACTER_LIMIT) + "\n\n... (file truncated due to size limits)";
                }
                return {
                    content: [{ type: "text", text: textContent }],
                    structuredContent: { filepath, content: textContent }
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Error reading file: ${error.message}` }]
                };
            }
        }
    );

    server.registerTool(
        "laya_write_file",
        {
            title: "Write File",
            description: "Write content to a file within the project directory. Creates the file and directories if they don't exist.",
            inputSchema: z.object({
                filepath: z.string().describe("Path to the file to write (relative to the project root)"),
                content: z.string().describe("Content to write to the file")
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false
            }
        },
        async ({ filepath, content }) => {
            const decision = await authorizeAction({
                tool: "laya_write_file",
                args: { filepath }
            });

            if (decision.decision === PolicyDecision.DENY) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Action DENIED by Laya policy engine. Reason: ${decision.reasoning || "None provided"}` }]
                };
            }

            if (decision.decision === PolicyDecision.REQUIRE_AUTHORIZATION) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Action REQUIRES HUMAN AUTHORIZATION. Please ask the user to explicitly approve writing to ${filepath} before proceeding.` }]
                };
            }

            try {
                const fullPath = sanitizePath(filepath);
                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.writeFile(fullPath, content, "utf-8");
                return {
                    content: [{ type: "text", text: `Successfully wrote to ${filepath}` }],
                    structuredContent: { filepath, success: true }
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Error writing file: ${error.message}` }]
                };
            }
        }
    );

    server.registerTool(
        "laya_search_files",
        {
            title: "Search Files",
            description: "Search for files within the project directory matching a regular expression.",
            inputSchema: z.object({
                pattern: z.string().describe("Regular expression pattern to search for"),
                dir: z.string().default(".").describe("Directory to search in (relative to project root)")
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ pattern, dir }) => {
            try {
                if (!pattern || pattern.length > 256) {
                    throw new Error("Search pattern must be between 1 and 256 characters");
                }
                const searchDir = sanitizePath(dir);
                // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
                const regex = new RegExp(pattern);
                const results: string[] = [];
                
                async function walk(currentDir: string) {
                    if (currentDir.indexOf("\0") !== -1) return;
                    const entries = await fs.readdir(currentDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.name === "node_modules" || entry.name === ".git") continue;
                        
                        const fullPath = path.join(currentDir, entry.name);
                        if (entry.isDirectory()) {
                            await walk(fullPath);
                        } else {
                            if (regex.test(entry.name)) {
                                results.push(path.relative(process.env.ALLOWED_DIR || process.cwd(), fullPath));
                            }
                        }
                    }
                }
                
                await walk(searchDir);
                
                return {
                    content: [{ type: "text", text: `Found ${results.length} files matching '${pattern}':\n` + results.join("\n") }],
                    structuredContent: { results }
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Error searching files: ${error.message}` }]
                };
            }
        }
    );
}
