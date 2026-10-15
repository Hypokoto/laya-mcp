import { z } from "zod";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { CHARACTER_LIMIT } from "../constants.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as os from "os";

const execFileAsync = promisify(execFile);

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
    
    // Check symlink realpath containment if target exists
    const realAllowed = fsSync.existsSync(allowedDir) ? fsSync.realpathSync(allowedDir) : allowedDir;
    const realResolved = fsSync.existsSync(resolvedPath) ? fsSync.realpathSync(resolvedPath) : resolvedPath;

    const relative = path.relative(realAllowed, realResolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Access denied: Cannot access files outside the allowed directory (${allowedDir})`);
    }
    return resolvedPath;
}

export function registerCodeAnalysisTools(server: McpServer) {
    server.registerTool(
        "laya_analyze_code",
        {
            title: "Analyze Code",
            description: "Parse a Python or C/C++ file and extract symbols (functions, classes) using system tree-sitter CLI.",
            inputSchema: z.object({
                filepath: z.string().describe("Path to the source file to analyze"),
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
                
                // Determine language and grammar path
                const ext = path.extname(filepath).toLowerCase();
                let lang = "";
                let query = "";
                
                if (ext === ".py") {
                    lang = "python";
                    query = `
(function_definition name: (identifier) @function)
(class_definition name: (identifier) @class)
`;
                } else if (ext === ".c" || ext === ".h") {
                    lang = "c";
                    query = `
(function_definition declarator: (function_declarator declarator: (identifier) @function))
(struct_specifier name: (type_identifier) @class)
`;
                } else if (ext === ".cpp" || ext === ".cc" || ext === ".cxx" || ext === ".hpp") {
                    lang = "cpp";
                    query = `
(function_definition declarator: (function_declarator declarator: (identifier) @function))
(function_definition declarator: (function_declarator declarator: (field_identifier) @function))
(class_specifier name: (type_identifier) @class)
(struct_specifier name: (type_identifier) @class)
`;
                } else {
                    throw new Error(`Unsupported file extension: ${ext}`);
                }
                
                // Locate tree-sitter grammar library across standard search paths
                const candidateGrammarPaths = [
                    process.env.TREE_SITTER_DIR ? path.join(process.env.TREE_SITTER_DIR, `${lang}.so`) : "",
                    `/usr/lib/tree_sitter/${lang}.so`,
                    `/usr/local/lib/tree_sitter/${lang}.so`,
                    `/usr/lib/x86_64-linux-gnu/tree_sitter/${lang}.so`
                ].filter(Boolean);
                
                const grammarPath = candidateGrammarPaths.find(p => fsSync.existsSync(p)) || candidateGrammarPaths[1];
                
                // Secure atomic temporary directory
                const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "laya-query-"));
                const queryPath = path.join(tmpDir, "query.scm");
                await fs.writeFile(queryPath, query, "utf-8");
                
                let stdout = "";
                try {
                    // Safe execution without shell interpolation (prevents shell injection RCE)
                    const result = await execFileAsync("tree-sitter", ["query", "-l", grammarPath, queryPath, fullPath], {
                        timeout: 10000
                    });
                    stdout = result.stdout;
                } catch (execError: any) {
                    if (execError.stderr && execError.stderr.includes("dlopen failed")) {
                        throw new Error(`The tree-sitter-${lang} grammar is not installed. Please install tree-sitter-${lang}`);
                    }
                    if (execError.stdout) {
                        stdout = execError.stdout;
                    } else {
                        throw new Error(execError.stderr || execError.message);
                    }
                } finally {
                    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
                }
                
                // Parse tree-sitter query output
                // Example: capture: 0 - function, start: (0, 4), end: (0, 8), text: `main`
                const symbols: { type: string, name: string, line: number }[] = [];
                const regex = /capture: \d+ - (\w+), start: \((\d+), \d+\), end: \(\d+, \d+\), text: `([^`]+)`/g;
                let match;
                while ((match = regex.exec(stdout)) !== null) {
                    symbols.push({
                        type: match[1],
                        line: parseInt(match[2], 10) + 1, // 0-indexed to 1-indexed
                        name: match[3]
                    });
                }
                
                let output = `Symbols found in ${filepath}:\n`;
                for (const sym of symbols) {
                    output += `- [Line ${sym.line}] ${sym.type}: ${sym.name}\n`;
                }
                
                if (symbols.length === 0) {
                    output = `No supported symbols (functions/classes) found in ${filepath}.`;
                }
                
                if (output.length > CHARACTER_LIMIT) {
                    output = output.substring(0, CHARACTER_LIMIT) + "\n\n... (output truncated)";
                }
                
                return {
                    content: [{ type: "text", text: output }],
                    structuredContent: { symbols }
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Error analyzing code: ${error.message}` }]
                };
            }
        }
    );
}
