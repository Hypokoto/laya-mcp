import { z } from "zod";
import { spawn } from "child_process";
import { CHARACTER_LIMIT } from "../constants.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authorizeAction, PolicyDecision } from "../laya_client.js";

function runProcessGroup(command: string, cwd: string, timeoutMs = 60000, maxBuffer = 10 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        // Command execution is pre-authorized by Laya Policy Engine in registerCommandTools
        // nosemgrep: javascript.lang.security.audit.dangerous-spawn-shell.dangerous-spawn-shell
        const proc = spawn("/bin/sh", ["-c", command], {
            cwd,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (proc.pid) {
                    process.kill(-proc.pid, "SIGKILL");
                }
            } catch {
                proc.kill("SIGKILL");
            }
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stdout.on("data", (d) => {
            if (stdout.length < maxBuffer) stdout += d.toString();
        });

        proc.stderr.on("data", (d) => {
            if (stderr.length < maxBuffer) stderr += d.toString();
        });

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (!timedOut) {
                if (code !== 0 && !stdout && stderr) {
                    reject(new Error(`Command exited with code ${code}: ${stderr}`));
                } else {
                    resolve({ stdout, stderr });
                }
            }
        });
    });
}

export function registerCommandTools(server: McpServer) {
    server.registerTool(
        "laya_run_command",
        {
            title: "Run Command",
            description: "Run a shell command within the project directory.",
            inputSchema: z.object({
                command: z.string().describe("The shell command to execute"),
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true
            }
        },
        async ({ command }) => {
            const decision = await authorizeAction({
                tool: "laya_run_command",
                args: { command }
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
                    content: [{ type: "text", text: `Action REQUIRES HUMAN AUTHORIZATION. Please ask the user to explicitly approve running the command '${command}' before proceeding.` }]
                };
            }

            try {
                const allowedDir = process.env.ALLOWED_DIR || process.cwd();
                const { stdout, stderr } = await runProcessGroup(command, allowedDir);
                
                let output = "";
                if (stdout) output += `STDOUT:\n${stdout}\n`;
                if (stderr) output += `STDERR:\n${stderr}\n`;
                
                if (output.length > CHARACTER_LIMIT) {
                    output = output.substring(0, CHARACTER_LIMIT) + "\n\n... (output truncated due to size limits)";
                }
                
                if (!output) output = "Command executed successfully with no output.";
                
                return {
                    content: [{ type: "text", text: output }],
                    structuredContent: { stdout, stderr, success: true }
                };
            } catch (error: any) {
                let errorOutput = `Error running command: ${error.message}\n`;
                if (error.stdout) errorOutput += `STDOUT:\n${error.stdout}\n`;
                if (error.stderr) errorOutput += `STDERR:\n${error.stderr}\n`;
                
                if (errorOutput.length > CHARACTER_LIMIT) {
                    errorOutput = errorOutput.substring(0, CHARACTER_LIMIT) + "\n\n... (error output truncated due to size limits)";
                }

                return {
                    isError: true,
                    content: [{ type: "text", text: errorOutput }],
                    structuredContent: { success: false, error: error.message, stdout: error.stdout, stderr: error.stderr }
                };
            }
        }
    );
}
