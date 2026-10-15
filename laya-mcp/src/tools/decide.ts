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
                instruction: z.string().optional().describe("The specific question, instruction, or prompt for the Laya decision model (omitted for automatic dynamic criteria synthesis)"),
                criteria: z.record(z.string()).optional().describe("A dictionary mapping option keys to their criteria descriptions (omitted for automatic dynamic criteria synthesis)")
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

                const isInfraFailure = decision.isError === true;
                return {
                    isError: isInfraFailure,
                    content: [
                        {
                            type: "text",
                            text: `Laya Decision: ${decision.decision}\nReasoning: ${decision.reasoning || "Evaluated by local ONNX model"}`
                        }
                    ],
                    structuredContent: {
                        decision: decision.decision,
                        reasoning: decision.reasoning,
                        matched_rule: decision.matched_rule,
                        probability: decision.probability,
                        success: !isInfraFailure
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

    server.registerTool(
        "laya_explain_decision",
        {
            title: "Explain Laya Decision",
            description: "Explain why Laya arrived at a decision for a given tool action, returning calibrated probabilities, temperature, risk margins, active rule matches, and rationale.",
            inputSchema: z.object({
                tool: z.string().describe("The context identifier or name of the action/data to evaluate (e.g. 'laya_run_command', 'write_file')"),
                args: z.record(z.any()).describe("The structured JSON state or input data payload to evaluate"),
                instruction: z.string().optional().describe("Optional question/instruction"),
                criteria: z.record(z.string()).optional().describe("Optional criteria dictionary")
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

                const isInfraFailure = decision.isError === true;
                const formattedProbabilities = decision.probabilities
                    ? Object.entries(decision.probabilities).map(([k, v]) => `  - **${k}**: ${(v * 100).toFixed(1)}%`).join("\n")
                    : "  None available";

                const explanationText = [
                    `### Laya Decision Explanation: ${decision.decision}`,
                    `- **Verdict**: ${decision.decision}`,
                    `- **Primary Reason**: ${decision.reasoning || "Evaluated by local ONNX model"}`,
                    `- **Matched Rule**: ${decision.matched_rule || "None (Neural Model Inference)"}`,
                    `- **Calibrated Temperature**: ${decision.temperature !== undefined ? decision.temperature.toFixed(2) : "1.00"}`,
                    `- **Confidence**: ${decision.probability !== undefined ? (decision.probability * 100).toFixed(1) + "%" : "N/A"}`,
                    `\n**Class Probabilities**:\n${formattedProbabilities}`
                ].join("\n");

                return {
                    isError: isInfraFailure,
                    content: [{ type: "text", text: explanationText }],
                    structuredContent: {
                        decision: decision.decision,
                        reasoning: decision.reasoning,
                        matched_rule: decision.matched_rule,
                        temperature: decision.temperature,
                        probability: decision.probability,
                        probabilities: decision.probabilities,
                        success: !isInfraFailure
                    }
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to explain Laya decision: ${error.message}` }],
                    structuredContent: { success: false, error: error.message }
                };
            }
        }
    );
}
