import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { CHARACTER_LIMIT } from "../constants.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authorizeAction, PolicyDecision } from "../laya_client.js";

const execAsync = promisify(exec);

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
                const { stdout, stderr } = await execAsync(command, { cwd: allowedDir });
                
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
