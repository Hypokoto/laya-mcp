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
                if (!Array.isArray(settings.hooks.AfterTool)) settings.hooks.AfterTool = [];

                // Check if already registered
                const beforeExists = settings.hooks.BeforeTool.some((entry: any) =>
                    entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                );
                const afterExists = settings.hooks.AfterTool.some((entry: any) =>
                    entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                );

                if (beforeExists && afterExists) {
                    results.push({
                        harness: "Antigravity",
                        path: settingsPath,
                        status: "already_installed",
                        message: "Laya hooks are already registered in BeforeTool and AfterTool."
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

                    if (!beforeExists) settings.hooks.BeforeTool.unshift(hookEntry);
                    if (!afterExists) settings.hooks.AfterTool.unshift(hookEntry);
                    safeBackupAndAtomicWrite(settingsPath, settings);

                    results.push({
                        harness: "Antigravity",
                        path: settingsPath,
                        status: "installed",
                        message: "Successfully registered Laya hooks in BeforeTool and AfterTool arrays."
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
                if (!Array.isArray(hooksJson.hooks.afterToolUse)) hooksJson.hooks.afterToolUse = [];

                const beforeCursor = hooksJson.hooks.beforeToolUse.some((h: any) => h.command?.includes("laya-pretool-hook.js"));
                const afterCursor = hooksJson.hooks.afterToolUse.some((h: any) => h.command?.includes("laya-pretool-hook.js"));

                if (beforeCursor && afterCursor) {
                    results.push({
                        harness: "Cursor",
                        path: cursorPath,
                        status: "already_installed",
                        message: "Laya hooks already present in Cursor hooks.json."
                    });
                } else {
                    if (!beforeCursor) hooksJson.hooks.beforeToolUse.push({ command: `node "${hookScript}"` });
                    if (!afterCursor) hooksJson.hooks.afterToolUse.push({ command: `node "${hookScript}"` });
                    safeBackupAndAtomicWrite(cursorPath, hooksJson);
                    results.push({
                        harness: "Cursor",
                        path: cursorPath,
                        status: "installed",
                        message: "Registered Laya hooks in beforeToolUse and afterToolUse."
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
            if (!Array.isArray(claudeSettings.hooks.PostToolUse)) claudeSettings.hooks.PostToolUse = [];

            const preExists = claudeSettings.hooks.PreToolUse.some((entry: any) =>
                entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
            );
            const postExists = claudeSettings.hooks.PostToolUse.some((entry: any) =>
                entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
            );

            if (preExists && postExists) {
                results.push({
                    harness: "Claude Code",
                    path: claudeSettingsPath,
                    status: "already_installed",
                    message: "Laya hooks already present in Claude Code settings."
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

                if (!preExists) claudeSettings.hooks.PreToolUse.unshift(hookEntry);
                if (!postExists) claudeSettings.hooks.PostToolUse.unshift(hookEntry);
                safeBackupAndAtomicWrite(claudeSettingsPath, claudeSettings);
                results.push({
                    harness: "Claude Code",
                    path: claudeSettingsPath,
                    status: "installed",
                    message: "Registered Laya PreToolUse and PostToolUse hooks in Claude Code settings."
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
                let modified = false;

                if (settings.hooks?.BeforeTool) {
                    const initialLen = settings.hooks.BeforeTool.length;
                    settings.hooks.BeforeTool = settings.hooks.BeforeTool.filter((entry: any) =>
                        !entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                    );
                    if (settings.hooks.BeforeTool.length < initialLen) {
                        modified = true;
                    }
                }

                if (settings.hooks?.AfterTool) {
                    const initialLen = settings.hooks.AfterTool.length;
                    settings.hooks.AfterTool = settings.hooks.AfterTool.filter((entry: any) =>
                        !entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                    );
                    if (settings.hooks.AfterTool.length < initialLen) {
                        modified = true;
                    }
                }

                if (modified) {
                    safeBackupAndAtomicWrite(settingsPath, settings);
                    results.push({
                        harness: "Antigravity",
                        path: settingsPath,
                        status: "uninstalled",
                        message: "Removed Laya hooks from BeforeTool and AfterTool arrays."
                    });
                } else {
                    results.push({
                        harness: "Antigravity",
                        path: settingsPath,
                        status: "skipped",
                        message: "Hook was not found in Antigravity settings."
                    });
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
                let modified = false;

                if (hooksJson.hooks?.beforeToolUse) {
                    const initialLen = hooksJson.hooks.beforeToolUse.length;
                    hooksJson.hooks.beforeToolUse = hooksJson.hooks.beforeToolUse.filter((h: any) =>
                        !h.command?.includes("laya-pretool-hook.js")
                    );
                    if (hooksJson.hooks.beforeToolUse.length < initialLen) {
                        modified = true;
                    }
                }

                if (hooksJson.hooks?.afterToolUse) {
                    const initialLen = hooksJson.hooks.afterToolUse.length;
                    hooksJson.hooks.afterToolUse = hooksJson.hooks.afterToolUse.filter((h: any) =>
                        !h.command?.includes("laya-pretool-hook.js")
                    );
                    if (hooksJson.hooks.afterToolUse.length < initialLen) {
                        modified = true;
                    }
                }

                if (modified) {
                    safeBackupAndAtomicWrite(cursorPath, hooksJson);
                    results.push({
                        harness: "Cursor",
                        path: cursorPath,
                        status: "uninstalled",
                        message: "Removed Laya hooks from Cursor hooks.json."
                    });
                } else {
                    results.push({
                        harness: "Cursor",
                        path: cursorPath,
                        status: "skipped",
                        message: "Hook was not found in Cursor hooks.json."
                    });
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
            let modified = false;

            if (claudeSettings.hooks?.PreToolUse) {
                const initialLen = claudeSettings.hooks.PreToolUse.length;
                claudeSettings.hooks.PreToolUse = claudeSettings.hooks.PreToolUse.filter((entry: any) =>
                    !entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                );
                if (claudeSettings.hooks.PreToolUse.length < initialLen) {
                    modified = true;
                }
            }

            if (claudeSettings.hooks?.PostToolUse) {
                const initialLen = claudeSettings.hooks.PostToolUse.length;
                claudeSettings.hooks.PostToolUse = claudeSettings.hooks.PostToolUse.filter((entry: any) =>
                    !entry.hooks?.some((h: any) => h.command?.includes("laya-pretool-hook.js"))
                );
                if (claudeSettings.hooks.PostToolUse.length < initialLen) {
                    modified = true;
                }
            }

            if (modified) {
                safeBackupAndAtomicWrite(claudeSettingsPath, claudeSettings);
                results.push({
                    harness: "Claude Code",
                    path: claudeSettingsPath,
                    status: "uninstalled",
                    message: "Removed Laya PreToolUse and PostToolUse hooks from Claude Code settings."
                });
            } else {
                results.push({
                    harness: "Claude Code",
                    path: claudeSettingsPath,
                    status: "skipped",
                    message: "Hook was not found in Claude Code settings."
                });
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
