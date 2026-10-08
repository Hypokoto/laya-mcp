export enum PolicyDecision {
    ALLOW = "ALLOW",
    DENY = "DENY",
    REQUIRE_AUTHORIZATION = "REQUIRE_AUTHORIZATION"
}

export interface DecisionRequest {
    tool: string;
    args: Record<string, any>;
    context?: string;
}

export interface DecisionResponse {
    decision: PolicyDecision;
    reasoning?: string;
}

/**
 * Calls the local Laya Python runtime to authorize a tool action.
 */
export async function authorizeAction(request: DecisionRequest): Promise<DecisionResponse> {
    const runtimeUrl = process.env.LAYA_RUNTIME_URL || "http://localhost:8000";
    
    try {
        const response = await fetch(`${runtimeUrl}/decide`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            console.error(`Laya runtime returned ${response.status}: ${await response.text()}`);
            // Fail closed if the policy engine is unreachable or errors out
            return { decision: PolicyDecision.DENY, reasoning: "Policy engine error or unreachable." };
        }

        const data = await response.json() as DecisionResponse;
        return data;
    } catch (error: any) {
        console.error(`Error connecting to Laya runtime: ${error.message}`);
        // Fail closed
        return { decision: PolicyDecision.DENY, reasoning: "Could not connect to the Laya policy engine." };
    }
}
