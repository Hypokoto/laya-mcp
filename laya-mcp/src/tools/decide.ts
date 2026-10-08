import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerDecideTools(server: McpServer) {
    server.tool(
        "laya_decide",
        "Ask the Laya ONNX model a choice, score, or noul question to get a calibrated decision",
        {
            tool: z.string().describe("The context or name of the action/data to evaluate"),
            args: z.any().describe("The JSON state or data to evaluate"),
            instruction: z.string().describe("The specific question or instruction for Laya"),
            criteria: z.record(z.string()).describe("A dictionary mapping option keys to their descriptions (e.g. {'URGENT': '...', 'IGNORE': '...'})")
        },
        async ({ tool, args, instruction, criteria }) => {
            try {
                const response = await fetch("http://localhost:8000/decide", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        tool,
                        args,
                        context: instruction,
                        criteria // We need to update Python to accept this!
                    })
                });

                if (!response.ok) {
                    throw new Error(`Laya API returned status: ${response.status}`);
                }

                const data: any = await response.json();
                return {
                    content: [{ type: "text", text: `Laya Decision: ${data.decision}\nReasoning: ${data.reasoning}` }]
                };
            } catch (error: any) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to consult Laya: ${error.message}` }]
                };
            }
        }
    );
}
