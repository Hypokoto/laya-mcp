export enum PolicyDecision {
    ALLOW = "ALLOW",
    DENY = "DENY",
    REQUIRE_AUTHORIZATION = "REQUIRE_AUTHORIZATION"
}

export interface DecisionRequest {
    tool: string;
    args: Record<string, any>;
    context?: string;
    criteria?: Record<string, string>;
}

export interface DecisionResponse {
    decision: PolicyDecision | string;
    reasoning?: string;
    logits?: number[];
    isError?: boolean;
}

const getRuntimeUrl = () => process.env.LAYA_RUNTIME_URL || "http://127.0.0.1:8000";

/**
 * Checks if the Laya Python runtime is healthy and ready to serve inferences.
 */
export async function isRuntimeHealthy(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(`${getRuntimeUrl()}/openapi.json`, { signal: controller.signal });
        clearTimeout(timeout);
        return res.status === 200;
    } catch {
        return false;
    }
}

/**
 * Waits for the Laya runtime to become ready within the specified timeout.
 */
export async function waitForRuntime(maxWaitMs: number = 25000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
        if (await isRuntimeHealthy()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
}

/**
 * Calls the local Laya Python runtime to authorize a tool action.
 * If the runtime is still warming up, it briefly waits rather than immediately failing.
 */
export async function authorizeAction(request: DecisionRequest): Promise<DecisionResponse> {
    const runtimeUrl = getRuntimeUrl();

    // If runtime is not ready yet, give it up to 15 seconds before failing
    if (!(await isRuntimeHealthy())) {
        console.error("Laya runtime is warming up. Awaiting readiness...");
        const ready = await waitForRuntime(15000);
        if (!ready) {
            return {
                decision: PolicyDecision.DENY,
                reasoning: "Laya policy engine is still warming up or unreachable at " + runtimeUrl + ". Please retry in a few seconds.",
                isError: true
            };
        }
    }
    
    try {
        const response = await fetch(`${runtimeUrl}/decide`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`Laya runtime returned ${response.status}: ${errText}`);
            return {
                decision: PolicyDecision.DENY,
                reasoning: `Policy engine returned HTTP ${response.status}: ${errText}`,
                isError: true
            };
        }

        const data = await response.json() as DecisionResponse;
        data.isError = false;
        return data;
    } catch (error: any) {
        console.error(`Error connecting to Laya runtime: ${error.message}`);
        return {
            decision: PolicyDecision.DENY,
            reasoning: `Could not connect to the Laya policy engine: ${error.message}`,
            isError: true
        };
    }
}
