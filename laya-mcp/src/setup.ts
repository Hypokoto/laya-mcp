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
import * as crypto from "crypto";
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

interface UpsertOptions {
    harness: HarnessConfigLocation;
    configPath: string;
    serverName: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    successMessage: string;
}

function upsertServerEntry(options: UpsertOptions): SetupResult {
    const { harness, configPath, serverName, command, args, env, successMessage } = options;
    const dirName = path.dirname(configPath);
    const exists = fs.existsSync(configPath);

    if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
    }

    let currentJson: any = {};
    let origMode = 0o600;
    if (exists) {
        const stat = fs.statSync(configPath);
        origMode = stat.mode & 0o777;
        const content = fs.readFileSync(configPath, "utf-8");
        try {
            currentJson = JSON.parse(content);
            const origBak = `${configPath}.orig.bak`;
            if (!fs.existsSync(origBak)) {
                fs.writeFileSync(origBak, content, { encoding: "utf-8", mode: 0o600 });
            }
            fs.writeFileSync(`${configPath}.bak`, content, { encoding: "utf-8", mode: 0o600 });
        } catch (parseErr: any) {
            throw new Error(`Failed to parse existing config JSON at ${configPath}: ${parseErr.message}. Aborting to prevent file clobbering.`);
        }
    }

    const entry = { command, args, env: env || {} };

    if (harness.format === "continue") {
        if (!Array.isArray(currentJson.mcpServers)) {
            currentJson.mcpServers = [];
        }
        const existingIdx = currentJson.mcpServers.findIndex((s: any) => s.name === serverName);
        const continueEntry = { name: serverName, ...entry };
        if (existingIdx >= 0) {
            currentJson.mcpServers[existingIdx] = continueEntry;
        } else {
            currentJson.mcpServers.push(continueEntry);
        }
    } else {
        if (!currentJson.mcpServers || typeof currentJson.mcpServers !== "object" || Array.isArray(currentJson.mcpServers)) {
            currentJson.mcpServers = {};
        }
        currentJson.mcpServers[serverName] = entry;
    }

    const tmpFile = `${configPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmpFile, JSON.stringify(currentJson, null, 2), { encoding: "utf-8", mode: exists ? origMode : 0o600 });
    try {
        fs.renameSync(tmpFile, configPath);
    } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch {}
        throw e;
    }

    return {
        harness: harness.name,
        path: configPath,
        status: exists ? "configured" : "created",
        message: successMessage
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

            if (exists || dirExists) {
                try {
                    const result = upsertServerEntry({
                        harness,
                        configPath,
                        serverName: "laya-mcp",
                        command: mcpConfig.command,
                        args: mcpConfig.args,
                        env: mcpConfig.env,
                        successMessage: `Successfully registered laya-mcp in ${harness.name}`
                    });
                    results.push(result);
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

/**
 * Configures all detected local harnesses to connect to a remote Laya instance via SSH stdio bridge.
 */
export async function setupRemoteHarnesses(remoteTarget: string, remoteAllowedDir?: string): Promise<SetupResult[]> {
    const results: SetupResult[] = [];
    const hash = crypto.createHash("sha256").update(remoteTarget).digest("hex").slice(0, 6);
    const serverName = `laya-remote-${remoteTarget.replace(/[^a-zA-Z0-9_-]/g, "_")}-${hash}`;
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const remoteCmd = remoteAllowedDir
        ? ["env", `ALLOWED_DIR=${quote(remoteAllowedDir)}`, "laya", "serve"]
        : ["laya", "serve"];
    const mcpConfig = {
        command: "ssh",
        args: ["-T", "--", remoteTarget, ...remoteCmd],
        env: {}
    };

    for (const harness of SUPPORTED_HARNESSES) {
        let configured = false;

        for (const configPath of harness.configPaths) {
            if (!configPath || configPath.trim() === "") continue;

            const dirName = path.dirname(configPath);
            const exists = fs.existsSync(configPath);
            const dirExists = fs.existsSync(dirName);

            if (exists || dirExists) {
                try {
                    const result = upsertServerEntry({
                        harness,
                        configPath,
                        serverName,
                        command: mcpConfig.command,
                        args: mcpConfig.args,
                        env: mcpConfig.env,
                        successMessage: `Successfully configured SSH stdio bridge (${serverName}) in ${harness.name}`
                    });
                    results.push(result);
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
