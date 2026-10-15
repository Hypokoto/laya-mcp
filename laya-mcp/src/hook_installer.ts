/**
 * Laya Hook Installer & Uninstaller
 * 
 * Configures the universal PreToolUse decision hook in:
 * 1. Antigravity IDE & CLI (~/.gemini/antigravity-ide/settings.json)
 * 2. Cursor IDE (~/.cursor/hooks.json or .cursor/hooks.json)
 * 3. Claude Code CLI (~/.claude/settings.json)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface HookInstallResult {
    harness: string;
    path: string;
    status: "installed" | "uninstalled" | "skipped" | "already_installed" | "error";
    message: string;
}

export function getHomeDir(): string {
    return process.env.HOME || os.homedir();
}

function safeBackupAndAtomicWrite(targetPath: string, data: any) {
    const serialized = JSON.stringify(data, null, 2);
    if (fs.existsSync(targetPath)) {
        const origContent = fs.readFileSync(targetPath, "utf-8");
        const origBak = `${targetPath}.orig.bak`;
        if (!fs.existsSync(origBak)) {
            fs.writeFileSync(origBak, origContent, "utf-8");
        }
        fs.writeFileSync(`${targetPath}.bak`, origContent, "utf-8");
    }
    const tmpFile = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmpFile, serialized, "utf-8");
    fs.renameSync(tmpFile, targetPath);
}

/**
 * Resolves the absolute path to the hook script.
 */
export function getHookScriptPath(): string {
    const repoRoot = path.resolve(__dirname, "../..");
    return path.join(repoRoot, "hooks", "laya-pretool-hook.js");
}

/**
 * Installs the Laya PreToolUse hook into detected harnesses.
 */
export async function installLayaHook(): Promise<HookInstallResult[]> {
    const results: HookInstallResult[] = [];
    const hookScript = getHookScriptPath();
    const homedir = getHomeDir();

    if (!fs.existsSync(hookScript)) {
        throw new Error(`Hook script not found at ${hookScript}`);
    }

    // 1. Antigravity IDE / CLI settings
    const antigravitySettingsPaths = [
        path.join(homedir, ".gemini", "antigravity-ide", "settings.json"),
        path.join(homedir, ".gemini", "config", "settings.json")
    ];

    for (const settingsPath of antigravitySettingsPaths) {
        if (fs.existsSync(path.dirname(settingsPath))) {
            try {
                let settings: any = {};
                if (fs.existsSync(settingsPath)) {
                    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
                }

                if (!settings.hooks) settings.hooks = {};
                if (!Array.isArray(settings.hooks.BeforeTool)) settings.hooks.BeforeTool = [];

                // Check if already registered
                const exists = settings.hooks.BeforeTool.some((entry: any) =>
                    entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                );

                if (exists) {
                    results.push({
                        harness: "Antigravity",
                        path: settingsPath,
                        status: "already_installed",
                        message: "Laya PreToolUse hook is already registered."
                    });
                } else {
                    const hookEntry = {
                        matcher: ".*",
                        hooks: [
                            {
                                type: "command",
                                command: `node "${hookScript}"`,
                                timeout: 30
                            }
                        ]
                    };

                    settings.hooks.BeforeTool.unshift(hookEntry);
                    safeBackupAndAtomicWrite(settingsPath, settings);

                    results.push({
                        harness: "Antigravity",
                        path: settingsPath,
                        status: "installed",
                        message: "Successfully registered Laya PreToolUse hook in BeforeTool array."
                    });
                }
            } catch (err: any) {
                results.push({
                    harness: "Antigravity",
                    path: settingsPath,
                    status: "error",
                    message: `Failed to configure Antigravity settings: ${err.message}`
                });
            }
            break;
        }
    }

    // 2. Cursor IDE hooks (~/.cursor/hooks.json or .cursor/hooks.json)
    const cursorHooksPaths = [
        path.join(homedir, ".cursor", "hooks.json"),
        path.join(process.cwd(), ".cursor", "hooks.json")
    ];

    for (const cursorPath of cursorHooksPaths) {
        const dir = path.dirname(cursorPath);
        if (fs.existsSync(dir)) {
            try {
                let hooksJson: any = { version: 1, hooks: {} };
                if (fs.existsSync(cursorPath)) {
                    hooksJson = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
                }
                if (!hooksJson.hooks) hooksJson.hooks = {};
                if (!Array.isArray(hooksJson.hooks.beforeToolUse)) hooksJson.hooks.beforeToolUse = [];

                const already = hooksJson.hooks.beforeToolUse.some((h: any) => h.command?.includes("laya-pretool-hook.js"));
                if (already) {
                    results.push({
                        harness: "Cursor",
                        path: cursorPath,
                        status: "already_installed",
                        message: "Laya hook already present in Cursor hooks.json."
                    });
                } else {
                    hooksJson.hooks.beforeToolUse.push({
                        command: `node "${hookScript}"`
                    });
                    safeBackupAndAtomicWrite(cursorPath, hooksJson);
                    results.push({
                        harness: "Cursor",
                        path: cursorPath,
                        status: "installed",
                        message: "Registered Laya hook in beforeToolUse."
                    });
                }
            } catch (err: any) {
                results.push({
                    harness: "Cursor",
                    path: cursorPath,
                    status: "error",
                    message: `Error updating Cursor hooks: ${err.message}`
                });
            }
            break;
        }
    }

    // 3. Claude Code CLI hooks (~/.claude/settings.json)
    const claudeSettingsPath = path.join(homedir, ".claude", "settings.json");
    if (fs.existsSync(path.dirname(claudeSettingsPath))) {
        try {
            let claudeSettings: any = {};
            if (fs.existsSync(claudeSettingsPath)) {
                claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf-8"));
            }
            if (!claudeSettings.hooks) claudeSettings.hooks = {};
            if (!Array.isArray(claudeSettings.hooks.PreToolUse)) claudeSettings.hooks.PreToolUse = [];

            const exists = claudeSettings.hooks.PreToolUse.some((entry: any) =>
                entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
            );

            if (exists) {
                results.push({
                    harness: "Claude Code",
                    path: claudeSettingsPath,
                    status: "already_installed",
                    message: "Laya hook already present in Claude Code settings."
                });
            } else {
                claudeSettings.hooks.PreToolUse.unshift({
                    matcher: ".*",
                    hooks: [
                        {
                            type: "command",
                            command: `node "${hookScript}"`,
                            timeout: 30
                        }
                    ]
                });
                safeBackupAndAtomicWrite(claudeSettingsPath, claudeSettings);
                results.push({
                    harness: "Claude Code",
                    path: claudeSettingsPath,
                    status: "installed",
                    message: "Registered Laya PreToolUse hook in Claude Code settings."
                });
            }
        } catch (err: any) {
            results.push({
                harness: "Claude Code",
                path: claudeSettingsPath,
                status: "error",
                message: `Failed to configure Claude Code settings: ${err.message}`
            });
        }
    }

    return results;
}

/**
 * Uninstalls and removes the Laya PreToolUse hook from detected harnesses.
 */
export async function uninstallLayaHook(): Promise<HookInstallResult[]> {
    const results: HookInstallResult[] = [];
    const homedir = getHomeDir();

    // 1. Antigravity settings
    const antigravitySettingsPaths = [
        path.join(homedir, ".gemini", "antigravity-ide", "settings.json"),
        path.join(homedir, ".gemini", "config", "settings.json")
    ];

    for (const settingsPath of antigravitySettingsPaths) {
        if (fs.existsSync(settingsPath)) {
            try {
                const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
                if (settings.hooks?.BeforeTool) {
                    const initialLen = settings.hooks.BeforeTool.length;
                    settings.hooks.BeforeTool = settings.hooks.BeforeTool.filter((entry: any) =>
                        !entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                    );

                    if (settings.hooks.BeforeTool.length < initialLen) {
                        safeBackupAndAtomicWrite(settingsPath, settings);
                        results.push({
                            harness: "Antigravity",
                            path: settingsPath,
                            status: "uninstalled",
                            message: "Removed Laya PreToolUse hook from BeforeTool array."
                        });
                    } else {
                        results.push({
                            harness: "Antigravity",
                            path: settingsPath,
                            status: "skipped",
                            message: "Hook was not found in Antigravity settings."
                        });
                    }
                }
            } catch (err: any) {
                results.push({
                    harness: "Antigravity",
                    path: settingsPath,
                    status: "error",
                    message: `Error removing hook: ${err.message}`
                });
            }
            break;
        }
    }

    // 2. Cursor settings
    const cursorHooksPaths = [
        path.join(homedir, ".cursor", "hooks.json"),
        path.join(process.cwd(), ".cursor", "hooks.json")
    ];

    for (const cursorPath of cursorHooksPaths) {
        if (fs.existsSync(cursorPath)) {
            try {
                const hooksJson = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
                if (hooksJson.hooks?.beforeToolUse) {
                    const initialLen = hooksJson.hooks.beforeToolUse.length;
                    hooksJson.hooks.beforeToolUse = hooksJson.hooks.beforeToolUse.filter((h: any) =>
                        !h.command?.includes("laya-pretool-hook.js")
                    );

                    if (hooksJson.hooks.beforeToolUse.length < initialLen) {
                        safeBackupAndAtomicWrite(cursorPath, hooksJson);
                        results.push({
                            harness: "Cursor",
                            path: cursorPath,
                            status: "uninstalled",
                            message: "Removed Laya hook from Cursor hooks.json."
                        });
                    }
                }
            } catch (err: any) {
                results.push({
                    harness: "Cursor",
                    path: cursorPath,
                    status: "error",
                    message: `Error removing Cursor hook: ${err.message}`
                });
            }
            break;
        }
    }

    // 3. Claude Code settings
    const claudeSettingsPath = path.join(homedir, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
        try {
            const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf-8"));
            if (claudeSettings.hooks?.PreToolUse) {
                const initialLen = claudeSettings.hooks.PreToolUse.length;
                claudeSettings.hooks.PreToolUse = claudeSettings.hooks.PreToolUse.filter((entry: any) =>
                    !entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                );

                if (claudeSettings.hooks.PreToolUse.length < initialLen) {
                    safeBackupAndAtomicWrite(claudeSettingsPath, claudeSettings);
                    results.push({
                        harness: "Claude Code",
                        path: claudeSettingsPath,
                        status: "uninstalled",
                        message: "Removed Laya PreToolUse hook from Claude Code settings."
                    });
                }
            }
        } catch (err: any) {
            results.push({
                harness: "Claude Code",
                path: claudeSettingsPath,
                status: "error",
                message: `Error removing Claude Code hook: ${err.message}`
            });
        }
    }

    return results;
}
