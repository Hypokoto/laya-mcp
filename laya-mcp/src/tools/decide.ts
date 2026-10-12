import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorizeAction } from "../laya_client.js";

export function registerDecideTools(server: McpServer) {
    server.registerTool(
        "laya_decide",
        {
            title: "Laya Calibrated Decision Engine",
            description: "Ask the Laya ONNX decision model a structured choice, score, or classification question to receive a mathematically calibrated decision with confidence reasoning.",
            inputSchema: z.object({
                tool: z.string().describe("The context identifier or name of the action/data to evaluate (e.g. 'security_check', 'email_classification')"),
                args: z.record(z.any()).describe("The structured JSON state or input data payload to evaluate"),
                instruction: z.string().describe("The specific question, instruction, or prompt for the Laya decision model"),
                criteria: z.record(z.string()).describe("A dictionary mapping option keys to their criteria descriptions (e.g. {'ALLOW': 'Safe operation', 'DENY': 'Destructive operation'})")
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async ({ tool, args, instruction, criteria }) => {
            try {
                const decision = await authorizeAction({
                    tool,
                    args,
                    context: instruction,
                    criteria
                });

                return {
                    content: [
                        {
                            type: "text",
                            text: `Laya Decision: ${decision.decision}\nReasoning: ${decision.reasoning || "Evaluated by local ONNX model"}`
                        }
                    ],
                    structuredContent: {
                        decision: decision.decision,
                        reasoning: decision.reasoning,
                        success: true
                    }
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Failed to consult Laya decision engine: ${error.message}`
                        }
                    ],
                    structuredContent: {
                        success: false,
                        error: error.message
                    }
                };
            }
        }
    );
}
