import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fsSync from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CHARACTER_LIMIT } from "../constants.js";

const execFileAsync = promisify(execFile);

function sanitizeRelativePath(requestedPath?: string): string | undefined {
    if (!requestedPath) return undefined;
    if (requestedPath.indexOf("\0") !== -1) {
        throw new Error("Null bytes are not allowed in path");
    }
    const cleanPath = requestedPath.replace(/\0/g, "").replace(/^(\.\.[\/\\])+/, "");
    const allowedDir = path.resolve(process.env.ALLOWED_DIR || process.cwd());
    const resolvedPath = path.resolve(allowedDir, cleanPath);
    const realAllowed = fsSync.existsSync(allowedDir) ? fsSync.realpathSync(allowedDir) : allowedDir;
    
    // Check ancestor
    let curr = resolvedPath;
    while (!fsSync.existsSync(curr)) {
        const parent = path.dirname(curr);
        if (parent === curr) break;
        curr = parent;
    }
    const realAncestor = fsSync.existsSync(curr) ? fsSync.realpathSync(curr) : curr;
    const relAncestor = path.relative(realAllowed, realAncestor);
    if (relAncestor.startsWith("..") || path.isAbsolute(relAncestor)) {
        throw new Error(`Access denied: Cannot access files outside allowed directory`);
    }

    return path.relative(allowedDir, resolvedPath);
}

export function registerGitTools(server: McpServer) {
    server.registerTool(
        "laya_git_diff",
        {
            title: "Git Diff",
            description: "Safely retrieve and inspect working directory or staged Git diffs without executing unsanitized shell commands.",
            inputSchema: z.object({
                staged: z.boolean().optional().default(false).describe("If true, inspect staged changes (--cached). If false, inspect unstaged working directory changes."),
                filepath: z.string().optional().describe("Optional path to limit diff to a specific file or directory (relative to project root)")
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ staged, filepath }) => {
            try {
                const allowedDir = path.resolve(process.env.ALLOWED_DIR || process.cwd());
                const cleanRelPath = sanitizeRelativePath(filepath);

                const args = ["diff"];
                if (staged) {
                    args.push("--cached");
                }
                if (cleanRelPath) {
                    args.push("--", cleanRelPath);
                }

                const { stdout, stderr } = await execFileAsync("git", args, {
                    cwd: allowedDir,
                    maxBuffer: 10 * 1024 * 1024
                });

                let diffOutput = stdout;
                const truncated = diffOutput.length > CHARACTER_LIMIT;
                if (truncated) {
                    diffOutput = diffOutput.slice(0, CHARACTER_LIMIT) + `\n\n... (diff truncated: output exceeded ${CHARACTER_LIMIT} characters)`;
                }

                if (!diffOutput.trim()) {
                    diffOutput = staged ? "No staged changes detected." : "No working tree changes detected.";
                }

                return {
                    content: [{ type: "text", text: `\`\`\`diff\n${diffOutput}\n\`\`\`` }],
                    structuredContent: {
                        staged: Boolean(staged),
                        filepath: cleanRelPath || null,
                        truncated,
                        diff: diffOutput,
                        hasChanges: Boolean(stdout.trim())
                    }
                };
            } catch (err: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Error executing git diff: ${err.message}` }],
                    structuredContent: { hasChanges: false, error: err.message }
                };
            }
        }
    );
}
