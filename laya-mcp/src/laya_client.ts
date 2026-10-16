import { wasmEngine } from "./wasm_engine.js";

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
    probability?: number;
    probabilities?: Record<string, number>;
    matched_rule?: string | null;
    temperature?: number;
    logits?: number[];
    isError?: boolean;
}

const getRuntimeUrl = () => process.env.LAYA_RUNTIME_URL || "http://127.0.0.1:8000";

/**
 * Checks if the Laya runtime (Native Rust Axum or Python FastAPI) is healthy and ready to serve inferences.
 */
export async function isRuntimeHealthy(): Promise<boolean> {
    let isMissingOrUnreachable = false;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        try {
            const res = await fetch(`${getRuntimeUrl()}/health`, { signal: controller.signal });
            if (res.status === 200) {
                try {
                    const data: any = await res.json();
                    return data?.status === "healthy" || data?.status === "ok";
                } catch {
                    return false;
                }
            }
            if (res.status === 404) {
                isMissingOrUnreachable = true;
            } else {
                return false;
            }
        } finally {
            clearTimeout(timeout);
        }
    } catch {
        isMissingOrUnreachable = true;
    }

    if (!isMissingOrUnreachable) {
        return false;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        try {
            const res = await fetch(`${getRuntimeUrl()}/openapi.json`, { signal: controller.signal });
            return res.status === 200;
        } finally {
            clearTimeout(timeout);
        }
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
 * Calls the Laya decision engine to authorize a tool action.
 * Supports dual-runtime execution:
 * 1. Primary: Python ONNX Engine daemon (if active or configured)
 * 2. In-Process Fallback: Pure WebAssembly Engine (onnxruntime-web + @huggingface/tokenizers)
 */
export async function authorizeAction(request: DecisionRequest): Promise<DecisionResponse> {
    const preferWasm = process.env.LAYA_ENGINE === "wasm" || process.env.LAYA_PREFER_WASM === "1";
    const forcePython = process.env.LAYA_ENGINE === "python";

    // 1. If WASM is explicitly preferred, execute directly via WebAssembly in-process
    if (preferWasm) {
        try {
            return await wasmEngine.decide(request);
        } catch (err: any) {
            console.error(`WASM engine error: ${err.message}. Falling back to Python runtime...`);
        }
    }

    // 2. Check if Python runtime is active
    const runtimeUrl = getRuntimeUrl();
    const pythonHealthy = await isRuntimeHealthy();

    if (pythonHealthy) {
        try {
            const response = await fetch(`${runtimeUrl}/decide`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(request)
            });

            if (response.ok) {
                const data = await response.json() as DecisionResponse;
                data.isError = false;
                return data;
            }
        } catch (error: any) {
            console.error(`Error connecting to Python runtime: ${error.message}`);
        }
    }

    // 3. Seamless in-process WebAssembly fallback if Python is offline
    if (!forcePython) {
        try {
            return await wasmEngine.decide(request);
        } catch (err: any) {
            console.error(`WASM fallback failed: ${err.message}`);
        }
    }

    // 4. Return policy DENY if both engines are unavailable
    return {
        decision: PolicyDecision.DENY,
        reasoning: `Both Laya Python engine (unreachable at ${runtimeUrl}) and in-process WebAssembly engine failed.`,
        isError: true
    };
}
