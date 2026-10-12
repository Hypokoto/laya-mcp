import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { CHARACTER_LIMIT } from "../constants.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as os from "os";

const execAsync = promisify(exec);

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
                
                const grammarPath = `/usr/lib/tree_sitter/${lang}.so`;
                
                // Write query to temporary file
                const queryPath = path.join(os.tmpdir(), `laya_query_${Date.now()}.scm`);
                await fs.writeFile(queryPath, query, "utf-8");
                
                let stdout = "";
                try {
                    const result = await execAsync(`tree-sitter query -l ${grammarPath} ${queryPath} "${fullPath}"`);
                    stdout = result.stdout;
                } catch (execError: any) {
                    if (execError.stderr && execError.stderr.includes("dlopen failed")) {
                        throw new Error(`The tree-sitter-${lang} grammar is not installed. Please run: sudo pacman -S tree-sitter-${lang}`);
                    }
                    if (execError.stdout) {
                        stdout = execError.stdout;
                    } else {
                        throw new Error(execError.stderr || execError.message);
                    }
                } finally {
                    await fs.unlink(queryPath).catch(() => {});
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
