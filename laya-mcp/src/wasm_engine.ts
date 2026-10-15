import * as ort from "onnxruntime-web";
import { Tokenizer } from "@huggingface/tokenizers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { DecisionRequest, DecisionResponse, PolicyDecision } from "./laya_client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveLayaHome(): string {
    if (process.env.LAYA_HOME && fs.existsSync(process.env.LAYA_HOME)) {
        return process.env.LAYA_HOME;
    }
    const candidate = path.resolve(__dirname, "../..");
    if (fs.existsSync(path.join(candidate, "tokenizer"))) {
        return candidate;
    }
    return process.cwd();
}

interface LayaConfig {
    max_len: number;
    head_max_len: number;
    temperature_by_options: Record<string, number>;
}

interface UserRule {
    name: string;
    action: "ALLOW" | "DENY" | "REQUIRE_AUTHORIZATION";
    tool_re?: RegExp;
    cmd_re?: RegExp;
    path_re?: RegExp;
}

const PROTECTED_PATHS_RE = /(hooks\/laya-pretool-hook\.js|laya_runtime\/|laya_config\.json|laya_rules\.json|\.laya\/|\.claude\/settings\.json|\.gemini\/)/i;

const OTHER_DESTRUCTIVE_REGEXES = [
    /find\s+.*\s+-delete\b/i,
    /\b(mkfs|fdisk|parted)\b/i,
    /dd\s+if=\/dev\/(zero|urandom)\s+of=/i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i,
    /chmod\s+(-[a-zA-Z]*R\s+)?777\s+\//i,
    />\s*\/dev\/sd[a-z]/i
];

const AUTHORIZATION_REGEXES = [
    /(curl|wget)\b.*\|\s*(sudo\s+)?(\/bin\/|\/usr\/bin\/)?(bash|sh|zsh|python|perl)\b/i,
    /(bash|sh|zsh)\s+-c\s+["'].*\b(curl|wget)\b/i,
    /(bash|sh|zsh)\s+<\s*\(\s*(curl|wget)\b/i,
    /(curl|wget)\s+.*-o\s+\S+\s*(&&|;)\s*(sudo\s+)?(\/bin\/|\/usr\/bin\/)?(bash|sh|python)/i,
    /git\s+push\s+.*(-f\b|--force\b)/i,
    /git\s+reset\s+--hard\b/i,
    /git\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d/i
];

const SHELL_TOOL_RE = /^(run_command|Bash|terminal|shell|execute_command)$/i;

function normalizeShellCommand(cmd: string): string {
    return cmd.replace(/\$\{?IFS\}?/g, " ").replace(/\s+/g, " ").trim();
}

function isDestructiveRm(cmd: string): boolean {
    const norm = normalizeShellCommand(cmd);
    const rmMatch = norm.match(/\b(sudo\s+)?(\/bin\/|\/usr\/bin\/)?rm\b/i);
    if (!rmMatch || rmMatch.index === undefined) return false;

    const afterRm = norm.slice(rmMatch.index + rmMatch[0].length).trim();
    const tokens = afterRm.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);

    let hasRecursive = false;
    let hasForce = false;
    const targets: string[] = [];

    for (const t of tokens) {
        if (t.startsWith("-")) {
            if (t === "--recursive" || /^-[a-zA-Z]*r/i.test(t)) hasRecursive = true;
            if (t === "--force" || /^-[a-zA-Z]*f/i.test(t)) hasForce = true;
            if (["-rf", "-fr", "-rfi", "-fir"].includes(t)) {
                hasRecursive = true;
                hasForce = true;
            }
            if (t === "--no-preserve-root") hasForce = true;
        } else {
            targets.push(t);
        }
    }

    if (hasRecursive && (hasForce || norm.includes("--no-preserve-root"))) {
        const destructiveTargets = new Set(["/", "/*", "~", "~/*", "$HOME", "${HOME}", ".", "./*", "*"]);
        for (const tgt of targets) {
            const cleanTgt = tgt !== "/" ? tgt.replace(/\/+$/, "") : "/";
            if (destructiveTargets.has(tgt) || destructiveTargets.has(cleanTgt)) {
                return true;
            }
        }
    }
    return false;
}

function checkEmergencyInvariants(tool: string, args: Record<string, any>): string | null {
    const cmdStr = String(args.CommandLine || args.command || args.cmd || "");
    const filepath = String(args.filepath || args.path || args.file_path || args.TargetFile || "");

    const combinedTarget = `${cmdStr} ${filepath}`;
    if (PROTECTED_PATHS_RE.test(combinedTarget)) {
        if (!/^(read|view|search|grep)/i.test(tool)) {
            return "REQUIRE_AUTHORIZATION";
        }
    }

    let targetCmd = cmdStr;
    if (!targetCmd && SHELL_TOOL_RE.test(tool)) {
        targetCmd = JSON.stringify(args);
    }

    if (targetCmd) {
        const norm = normalizeShellCommand(targetCmd);
        if (isDestructiveRm(norm)) return "DENY";
        for (const rx of OTHER_DESTRUCTIVE_REGEXES) {
            if (rx.test(norm)) return "DENY";
        }
        for (const rx of AUTHORIZATION_REGEXES) {
            if (rx.test(norm)) return "REQUIRE_AUTHORIZATION";
        }
    }

    return null;
}

class WasmLayaEngine {
    private session: ort.InferenceSession | null = null;
    private tokenizer: Tokenizer | null = null;
    private config: LayaConfig | null = null;
    private initPromise: Promise<void> | null = null;
    private isReady: boolean = false;
    private rulesCache: { filePath: string | null; mtime: number; rules: UserRule[] } = {
        filePath: null,
        mtime: 0,
        rules: []
    };

    private readonly CLS_ID = 50281n;
    private readonly SEP_ID = 50282n;
    private readonly MASK_ID = 50284n;

    public isWasmReady(): boolean {
        return this.isReady;
    }

    public async initialize(): Promise<void> {
        if (this.isReady) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            const layaHome = resolveLayaHome();
            const tokenizerPath = path.join(layaHome, "tokenizer/tokenizer.json");
            const tokenizerConfigPath = path.join(layaHome, "tokenizer/tokenizer_config.json");
            const configPath = path.join(layaHome, "laya_config.json");

            const int8ModelPath = path.join(layaHome, "laya_int8.onnx");
            const fp32ModelPath = path.join(layaHome, "laya.onnx");
            const modelPath = fs.existsSync(int8ModelPath) ? int8ModelPath : fp32ModelPath;

            if (!fs.existsSync(tokenizerPath) || !fs.existsSync(tokenizerConfigPath)) {
                throw new Error(`Laya tokenizer files not found at ${tokenizerPath}`);
            }
            if (!fs.existsSync(modelPath)) {
                throw new Error(`Laya ONNX model not found at ${modelPath}`);
            }

            const tokenizerJson = JSON.parse(fs.readFileSync(tokenizerPath, "utf-8"));
            const tokenizerConfig = JSON.parse(fs.readFileSync(tokenizerConfigPath, "utf-8"));
            this.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

            if (fs.existsSync(configPath)) {
                try {
                    this.config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                } catch {
                    this.config = { max_len: 512, head_max_len: 192, temperature_by_options: {} };
                }
            } else {
                this.config = { max_len: 512, head_max_len: 192, temperature_by_options: {} };
            }

            ort.env.wasm.numThreads = Math.min(4, Math.max(1, (await import("os")).cpus().length - 1));

            try {
                const distPath = path.resolve(__dirname, "../../node_modules/onnxruntime-web/dist/");
                if (fs.existsSync(distPath)) {
                    ort.env.wasm.wasmPaths = distPath + "/";
                }
            } catch {}

            const modelBuffer = fs.readFileSync(modelPath);
            this.session = await ort.InferenceSession.create(modelBuffer, {
                executionProviders: ["wasm"]
            });

            this.isReady = true;
            console.error(`⚡ Laya In-Process WASM Engine initialized (${path.basename(modelPath)}, threads: ${ort.env.wasm.numThreads})`);
        })();

        return this.initPromise;
    }

    private loadUserRules(): UserRule[] {
        const layaHome = resolveLayaHome();
        const candidatePaths: string[] = [];

        if (process.env.LAYA_RULES_PATH) {
            candidatePaths.push(process.env.LAYA_RULES_PATH);
        }
        candidatePaths.push(
            path.join(layaHome, ".laya", "rules.json"),
            path.join(layaHome, "laya_rules.json")
        );

        let foundPath: string | null = null;
        for (const cp of candidatePaths) {
            if (fs.existsSync(cp)) {
                foundPath = cp;
                break;
            }
        }

        if (!foundPath) return [];

        try {
            const stat = fs.statSync(foundPath);
            if (this.rulesCache.filePath === foundPath && this.rulesCache.mtime === stat.mtimeMs) {
                return this.rulesCache.rules;
            }

            const rawData = JSON.parse(fs.readFileSync(foundPath, "utf-8"));
            const ruleList = Array.isArray(rawData) ? rawData : (rawData.rules || []);
            const compiled: UserRule[] = [];

            for (const r of ruleList) {
                const action = String(r.action || "").trim().toUpperCase();
                if (action !== "ALLOW" && action !== "DENY" && action !== "REQUIRE_AUTHORIZATION") {
                    continue;
                }

                const entry: UserRule = {
                    name: String(r.name || r.id || "unnamed-rule"),
                    action: action as any
                };

                const toolPat = r.tool || r.toolPattern;
                if (toolPat) entry.tool_re = new RegExp(toolPat, "i");

                const cmdPat = r.commandPattern;
                if (cmdPat) entry.cmd_re = new RegExp(cmdPat, "i");

                const pathPat = r.pathPattern;
                if (pathPat) entry.path_re = new RegExp(pathPat, "i");

                if (action === "ALLOW" && !entry.cmd_re && !entry.path_re) {
                    continue;
                }

                compiled.push(entry);
            }

            this.rulesCache = {
                filePath: foundPath,
                mtime: stat.mtimeMs,
                rules: compiled
            };
            return compiled;
        } catch {
            return [];
        }
    }

    private evaluateUserRules(tool: string, args: Record<string, any>): [string, string] | null {
        const rules = this.loadUserRules();
        if (!rules.length) return null;

        const cmdStr = String(args.CommandLine || args.command || args.cmd || "");
        const rawFp = String(args.filepath || args.path || args.file_path || args.TargetFile || "");

        let canonicalRelPath = rawFp;
        let isPathTraversal = false;

        if (rawFp) {
            const layaHome = resolveLayaHome();
            const workspaceDir = fs.realpathSync(process.env.ALLOWED_DIR || layaHome);
            const cleanPath = rawFp.replace(/\0/g, "");
            try {
                const targetJoined = path.resolve(workspaceDir, cleanPath);
                const resolvedTarget = fs.existsSync(targetJoined) ? fs.realpathSync(targetJoined) : targetJoined;
                const rel = path.relative(workspaceDir, resolvedTarget);
                if (rel.startsWith("..") || path.isAbsolute(rel)) {
                    isPathTraversal = true;
                } else {
                    canonicalRelPath = rel.replace(/\\/g, "/");
                }
            } catch {
                isPathTraversal = true;
            }
        }

        for (const r of rules) {
            if (r.tool_re && !r.tool_re.test(tool)) continue;
            if (r.action === "ALLOW" && cmdStr && !r.cmd_re) continue;
            if (r.action === "ALLOW" && isPathTraversal) continue;
            if (r.cmd_re && (!cmdStr || !r.cmd_re.test(cmdStr))) continue;
            if (r.path_re) {
                if (!rawFp) continue;
                if (!r.path_re.test(canonicalRelPath) && !r.path_re.test(rawFp)) continue;
                if (r.action === "ALLOW" && !r.path_re.test(canonicalRelPath)) continue;
            }
            return [r.action, r.name];
        }

        return null;
    }

    private scrub(str: string): string {
        if (typeof str !== "string") str = String(str);
        return str.replace(/\[(CLS|SEP|MASK|PAD|UNK)\]/g, " ");
    }

    private buildSequence(
        state: any,
        qtype: string,
        ins: string,
        criteria: Record<string, string>,
        maxLen: number = 512,
        headMaxLen: number = 192
    ): { seq: bigint[]; markers: bigint[]; optionKeys: string[] } {
        if (!this.tokenizer) throw new Error("Tokenizer not initialized");

        const optionKeys = Object.keys(criteria);
        const renderedOpts = optionKeys.map((k) => (criteria[k] ? `${k}: ${criteria[k]}` : k));

        const headText = `${qtype} question: ${this.scrub(ins)}`;
        const headEnc = this.tokenizer.encode(headText);
        let headIds = headEnc.ids.map((id: number) => BigInt(id));

        const optIds = renderedOpts.map((opt) => {
            const enc = this.tokenizer!.encode(" " + this.scrub(opt));
            const trimmed = enc.ids.slice(0, 48).map((id: number) => BigInt(id));
            return [this.MASK_ID, ...trimmed];
        });

        const totalOptLen = optIds.reduce((sum, o) => sum + o.length, 0);
        let optBudget = headMaxLen - totalOptLen;
        if (optBudget < 16) {
            const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
            for (let i = 0; i < optIds.length; i++) {
                optIds[i] = optIds[i].slice(0, per);
            }
            optBudget = headMaxLen - optIds.reduce((sum, o) => sum + o.length, 0);
        }

        headIds = headIds.slice(0, Math.max(8, optBudget));

        const seq: bigint[] = [this.CLS_ID, ...headIds, this.SEP_ID];
        const markers: bigint[] = [];

        for (const opt of optIds) {
            markers.push(BigInt(seq.length));
            seq.push(...opt);
        }
        seq.push(this.SEP_ID);

        const serializedState = typeof state === "string" ? state : JSON.stringify(state);
        const stateEnc = this.tokenizer.encode(this.scrub(serializedState));
        const room = Math.max(0, maxLen - seq.length - 1);
        const stateIds = stateEnc.ids.slice(0, room).map((id: number) => BigInt(id));

        seq.push(...stateIds);
        seq.push(this.SEP_ID);

        return {
            seq: seq.slice(0, maxLen),
            markers: markers.filter((m) => m < BigInt(maxLen)),
            optionKeys
        };
    }

    public async decide(request: DecisionRequest): Promise<DecisionResponse> {
        // 1. Emergency Invariants Safety Net (Tier 1 Precedence)
        const emergencyVerdict = checkEmergencyInvariants(request.tool, request.args);
        if (emergencyVerdict === "DENY") {
            return {
                decision: PolicyDecision.DENY,
                reasoning: "Emergency safety net overrule: caught catastrophic DENY invariant violation.",
                probability: 1.0,
                probabilities: { DENY: 1.0, ALLOW: 0.0, REQUIRE_AUTHORIZATION: 0.0 },
                matched_rule: "EMERGENCY_INVARIANT_DENY",
                temperature: 1.0,
                isError: false
            };
        } else if (emergencyVerdict === "REQUIRE_AUTHORIZATION") {
            const ruleMatch = this.evaluateUserRules(request.tool, request.args);
            if (ruleMatch && ruleMatch[0] === "DENY") {
                return {
                    decision: PolicyDecision.DENY,
                    reasoning: `Matched declarative policy rule '${ruleMatch[1]}': DENY.`,
                    probability: 1.0,
                    probabilities: { DENY: 1.0, ALLOW: 0.0, REQUIRE_AUTHORIZATION: 0.0 },
                    matched_rule: ruleMatch[1],
                    temperature: 1.0,
                    isError: false
                };
            }
            return {
                decision: PolicyDecision.REQUIRE_AUTHORIZATION,
                reasoning: "Emergency safety net overrule: self-protection or sensitive action invariant violation.",
                probability: 1.0,
                probabilities: { DENY: 0.0, ALLOW: 0.0, REQUIRE_AUTHORIZATION: 1.0 },
                matched_rule: "EMERGENCY_INVARIANT_REQUIRE_AUTH",
                temperature: 1.0,
                isError: false
            };
        }

        // 2. Declarative User Rules Engine (Tier 2 Precedence)
        const ruleMatch = this.evaluateUserRules(request.tool, request.args);
        if (ruleMatch) {
            const [ruleAction, ruleName] = ruleMatch;
            const probDict: Record<string, number> = {
                ALLOW: ruleAction === "ALLOW" ? 1.0 : 0.0,
                DENY: ruleAction === "DENY" ? 1.0 : 0.0,
                REQUIRE_AUTHORIZATION: ruleAction === "REQUIRE_AUTHORIZATION" ? 1.0 : 0.0
            };
            return {
                decision: ruleAction,
                reasoning: `Matched declarative policy rule '${ruleName}': ${ruleAction}.`,
                probability: 1.0,
                probabilities: probDict,
                matched_rule: ruleName,
                temperature: 1.0,
                isError: false
            };
        }

        // 3. Neural Brain Inference via WebAssembly (Tier 3)
        await this.initialize();

        if (!this.session || !this.tokenizer) {
            throw new Error("WASM engine failed to initialize.");
        }

        const criteria = request.criteria || {
            ALLOW: "The action is safe, standard development operation within bounds.",
            DENY: "The action violates security policies, destroys root files, or is clearly harmful.",
            REQUIRE_AUTHORIZATION: "The action is sensitive or alters critical project configuration."
        };

        const instruction = request.context || `Evaluate the action for tool '${request.tool}'`;
        const qtype = "choice";
        const maxLen = this.config?.max_len || 512;
        const headMaxLen = this.config?.head_max_len || 192;

        const { seq, markers, optionKeys } = this.buildSequence(
            request.args,
            qtype,
            instruction,
            criteria,
            maxLen,
            headMaxLen
        );

        const inputIdsTensor = new ort.Tensor("int64", BigInt64Array.from(seq), [1, seq.length]);
        const attentionMaskTensor = new ort.Tensor("int64", new BigInt64Array(seq.length).fill(1n), [1, seq.length]);
        const markerPosTensor = new ort.Tensor("int64", BigInt64Array.from(markers), [1, markers.length]);
        const markerMaskTensor = new ort.Tensor("bool", new Uint8Array(markers.length).fill(1), [1, markers.length]);
        const qtypeTensor = new ort.Tensor("int64", new BigInt64Array([0n]), [1]);

        const feeds: Record<string, ort.Tensor> = {
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
            marker_pos: markerPosTensor,
            marker_mask: markerMaskTensor,
            qtype: qtypeTensor
        };

        const t0 = performance.now();
        const results = await this.session.run(feeds);
        const elapsed = performance.now() - t0;

        const rawLogits = Array.from(results.logits.data as Float32Array).slice(0, optionKeys.length);

        const K = optionKeys.length;
        let tempKey = `choice:${K}`;
        const tempMap = this.config?.temperature_by_options || {};
        if (!(tempKey in tempMap)) {
            if (K >= 3 && K <= 5) tempKey = "choice:3-5";
            else if (K >= 6 && K <= 10) tempKey = "choice:6-10";
            else if (K >= 11) tempKey = "choice:11+";
            else tempKey = "choice:2";
        }

        const T = tempMap[tempKey] || 1.76;
        const scaledLogits = rawLogits.map((l) => l / Math.max(1e-4, T));
        const maxL = Math.max(...scaledLogits);
        const exps = scaledLogits.map((l) => Math.exp(l - maxL));
        const sumExps = exps.reduce((a, b) => a + b, 0);
        const probs = exps.map((e) => e / sumExps);

        const probMap: Record<string, number> = {};
        let bestIdx = 0;
        let bestProb = -1;

        for (let i = 0; i < optionKeys.length; i++) {
            probMap[optionKeys[i]] = probs[i];
            if (probs[i] > bestProb) {
                bestProb = probs[i];
                bestIdx = i;
            }
        }

        let decision = optionKeys[bestIdx];

        const TAU = parseFloat(process.env.LAYA_ALLOW_THRESHOLD || "0.60");
        const denyProb = probMap["DENY"] || 0.0;
        const reqProb = probMap["REQUIRE_AUTHORIZATION"] || 0.0;

        let reasoning = `Evaluated in-process via Laya WebAssembly brain: ${decision} (${(bestProb * 100).toFixed(1)}% confidence, ${elapsed.toFixed(0)}ms inference).`;

        if (decision === "ALLOW" && "REQUIRE_AUTHORIZATION" in criteria) {
            if (bestProb < TAU || denyProb > 0.25 || reqProb > 0.35) {
                decision = "REQUIRE_AUTHORIZATION";
                reasoning = `Calibrated ALLOW probability ${(bestProb * 100).toFixed(1)}% is below security threshold (${(TAU * 100).toFixed(0)}%) or risk margins exceeded (DENY=${(denyProb * 100).toFixed(1)}%, REQ=${(reqProb * 100).toFixed(1)}%); escalated to human authorization.`;
            }
        }

        return {
            decision,
            reasoning,
            probability: bestProb,
            probabilities: probMap,
            matched_rule: null,
            temperature: T,
            logits: rawLogits,
            isError: false
        };
    }
}

export const wasmEngine = new WasmLayaEngine();
