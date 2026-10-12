/**
 * Laya MCP Harness Configuration Wizard
 * 
 * Automatically detects installed AI harnesses on the machine (Claude Desktop,
 * Cursor, Windsurf, Claude Code, Cline, Continue, etc.) and seamlessly injects
 * the Laya MCP configuration into their respective config files.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface HarnessConfigLocation {
    id: string;
    name: string;
    configPaths: string[];
    format: "standard" | "continue" | "claude_code";
}

const homedir = os.homedir();

export const SUPPORTED_HARNESSES: HarnessConfigLocation[] = [
    {
        id: "claude-desktop",
        name: "Claude Desktop",
        configPaths: [
            path.join(homedir, ".config", "Claude", "claude_desktop_config.json"),
            path.join(homedir, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
            path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
        ],
        format: "standard"
    },
    {
        id: "claude-code",
        name: "Claude Code CLI",
        configPaths: [
            path.join(homedir, ".claude", "mcp.json"),
            path.join(homedir, ".claude.json")
        ],
        format: "standard"
    },
    {
        id: "cursor",
        name: "Cursor IDE",
        configPaths: [
            path.join(homedir, ".cursor", "mcp.json"),
            path.join(process.cwd(), ".cursor", "mcp.json")
        ],
        format: "standard"
    },
    {
        id: "windsurf",
        name: "Windsurf (Codeium)",
        configPaths: [
            path.join(homedir, ".codeium", "windsurf", "mcp_config.json")
        ],
        format: "standard"
    },
    {
        id: "roo-cline",
        name: "Roo Code / Cline (VS Code)",
        configPaths: [
            path.join(homedir, ".config", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
            path.join(homedir, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
            path.join(homedir, "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
        ],
        format: "standard"
    },
    {
        id: "continue",
        name: "Continue.dev",
        configPaths: [
            path.join(homedir, ".continue", "config.json")
        ],
        format: "continue"
    }
];

export interface SetupResult {
    harness: string;
    path: string;
    status: "configured" | "skipped" | "created" | "error";
    message: string;
}

/**
 * Resolves the absolute command and args required to launch laya-mcp.
 */
export function getLayaMcpCommand(): { command: string; args: string[]; env: Record<string, string> } {
    const layaMcpDir = path.resolve(__dirname, "..");
    const distIndex = path.join(layaMcpDir, "dist", "index.js");
    const repoRoot = path.resolve(layaMcpDir, "..");

    return {
        command: "node",
        args: [distIndex],
        env: {
            LAYA_HOME: repoRoot,
            ALLOWED_DIR: repoRoot
        }
    };
}

/**
 * Configures all detected harnesses on the current system.
 */
export async function setupAllHarnesses(targetDir?: string): Promise<SetupResult[]> {
    const results: SetupResult[] = [];
    const mcpConfig = getLayaMcpCommand();

    for (const harness of SUPPORTED_HARNESSES) {
        let configured = false;

        for (const configPath of harness.configPaths) {
            if (!configPath || configPath.trim() === "") continue;

            const dirName = path.dirname(configPath);
            const exists = fs.existsSync(configPath);
            const dirExists = fs.existsSync(dirName);

            // If the parent directory exists or the config file already exists, we configure it
            if (exists || dirExists) {
                try {
                    if (!fs.existsSync(dirName)) {
                        fs.mkdirSync(dirName, { recursive: true });
                    }

                    let currentJson: any = {};
                    if (exists) {
                        try {
                            const content = fs.readFileSync(configPath, "utf-8");
                            currentJson = JSON.parse(content);
                        } catch {
                            currentJson = {};
                        }
                    }

                    if (harness.format === "continue") {
                        if (!Array.isArray(currentJson.mcpServers)) {
                            currentJson.mcpServers = [];
                        }
                        const existingIdx = currentJson.mcpServers.findIndex((s: any) => s.name === "laya-mcp");
                        const entry = {
                            name: "laya-mcp",
                            command: mcpConfig.command,
                            args: mcpConfig.args,
                            env: mcpConfig.env
                        };
                        if (existingIdx >= 0) {
                            currentJson.mcpServers[existingIdx] = entry;
                        } else {
                            currentJson.mcpServers.push(entry);
                        }
                    } else {
                        // Standard format: { mcpServers: { "laya-mcp": { command, args, env } } }
                        if (!currentJson.mcpServers || typeof currentJson.mcpServers !== "object") {
                            currentJson.mcpServers = {};
                        }
                        currentJson.mcpServers["laya-mcp"] = {
                            command: mcpConfig.command,
                            args: mcpConfig.args,
                            env: mcpConfig.env
                        };
                    }

                    fs.writeFileSync(configPath, JSON.stringify(currentJson, null, 2), "utf-8");

                    results.push({
                        harness: harness.name,
                        path: configPath,
                        status: exists ? "configured" : "created",
                        message: `Successfully registered laya-mcp in ${harness.name}`
                    });
                    configured = true;
                    break;
                } catch (err: any) {
                    results.push({
                        harness: harness.name,
                        path: configPath,
                        status: "error",
                        message: `Error writing config: ${err.message}`
                    });
                }
            }
        }

        if (!configured) {
            results.push({
                harness: harness.name,
                path: harness.configPaths[0],
                status: "skipped",
                message: "App directory not found on this machine (not installed)."
            });
        }
    }

    return results;
}
