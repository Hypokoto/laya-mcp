import { z } from "zod";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat } from "../types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authorizeAction, PolicyDecision } from "../laya_client.js";

// Ensure all paths are strictly contained within ALLOWED_DIR, resolving symlinks for existing and new files
function sanitizePath(requestedPath: string, isWrite = false): string {
    if (!requestedPath || typeof requestedPath !== "string") {
        throw new Error("Invalid path parameter");
    }
    if (requestedPath.indexOf("\0") !== -1) {
        throw new Error("Null bytes are not allowed in path");
    }
    const cleanPath = requestedPath.replace(/\0/g, "").replace(/^(\.\.[\/\\])+/, "");
    const allowedDir = path.resolve(process.env.ALLOWED_DIR || process.cwd());
    const resolvedPath = path.resolve(allowedDir, cleanPath);

    // Resolve realpaths to prevent symlink directory escapes
    const realAllowed = fsSync.existsSync(allowedDir) ? fsSync.realpathSync(allowedDir) : allowedDir;

    // Check nearest existing ancestor to prevent symlink directory escape on new/non-existent files
    let curr = resolvedPath;
    while (!fsSync.existsSync(curr)) {
        const parent = path.dirname(curr);
        if (parent === curr) break;
        curr = parent;
    }
    const realAncestor = fsSync.existsSync(curr) ? fsSync.realpathSync(curr) : curr;
    const relAncestor = path.relative(realAllowed, realAncestor);
    if (relAncestor.startsWith("..") || path.isAbsolute(relAncestor)) {
        throw new Error(`Access denied: Cannot access files outside the allowed directory (${allowedDir})`);
    }

    if (fsSync.existsSync(resolvedPath)) {
        const realResolved = fsSync.realpathSync(resolvedPath);
        const relative = path.relative(realAllowed, realResolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Access denied: Cannot access files outside the allowed directory (${allowedDir})`);
        }
    }

    // Self-Protection check on mutating actions: protect policy engine files and configs
    if (isWrite) {
        const PROTECTED_TARGETS_RE = /(hooks\/laya-pretool-hook\.js|laya_runtime\/|laya_config\.json|\.claude\/settings\.json|\.gemini\/)/i;
        if (PROTECTED_TARGETS_RE.test(cleanPath) || PROTECTED_TARGETS_RE.test(resolvedPath)) {
            throw new Error(`Access denied: Modification of Laya policy engine or harness configuration files is restricted.`);
        }
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
                const fullPath = sanitizePath(filepath, false);
                const stat = await fs.stat(fullPath);
                
                // Do not load massive binary files into memory; cap at CHARACTER_LIMIT (25,000 bytes)
                const MAX_READ_BYTES = CHARACTER_LIMIT;
                const bytesToRead = Math.min(stat.size, MAX_READ_BYTES);
                
                const fh = await fs.open(fullPath, "r");
                const buffer = Buffer.alloc(bytesToRead);
                try {
                    await fh.read(buffer, 0, bytesToRead, 0);
                } finally {
                    await fh.close();
                }

                let textContent = buffer.toString("utf-8");
                if (stat.size > bytesToRead) {
                    textContent += `\n\n... (file truncated: read ${bytesToRead} of ${stat.size} bytes)`;
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
                const fullPath = sanitizePath(filepath, true);
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
