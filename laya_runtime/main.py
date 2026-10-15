from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, Optional, List, Tuple
from contextlib import asynccontextmanager
import os
import re
import json
import numpy as np
import uvicorn
import onnxruntime as ort
from transformers import AutoTokenizer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "..", "laya.onnx")
TOKENIZER_PATH = os.path.join(BASE_DIR, "..", "tokenizer")
CONFIG_PATH = os.path.join(BASE_DIR, "..", "laya_config.json")

tokenizer = None
session = None
config_data = {}
temperature_by_options = {}

if os.path.exists(CONFIG_PATH):
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            config_data = json.load(f)
            temperature_by_options = config_data.get("temperature_by_options", {})
    except Exception as e:
        print(f"Warning: Could not load laya_config.json: {e}")

def load_model():
    global tokenizer, session
    print(f"Loading tokenizer from {TOKENIZER_PATH}...")
    tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_PATH)
    
    print(f"Loading ONNX model from {MODEL_PATH}...")
    session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    print("Laya ONNX model successfully loaded.")

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    yield
    print("Shutting down Laya ONNX runtime.")

app = FastAPI(title="Laya Runtime", description="Calibrated Decision & Policy Engine", lifespan=lifespan)

# --- Sequence Building ---
def py_json_dumps(v):
    return json.dumps(v, ensure_ascii=False)

def serialize_state(state):
    return state if isinstance(state, str) else py_json_dumps(state)

def render_options(qtype_str, crit):
    if qtype_str == "choice":
        return [f"{k}: {v}" if v else k for k, v in crit.items()]
    elif qtype_str == "noul":
        c = crit or {}
        return [
            "false: " + c.get("false", "no, the statement does not hold"),
            "true: " + c.get("true", "yes, the statement holds")
        ]
    return []

def scrub(s: str) -> str:
    if not isinstance(s, str):
        s = str(s)
    # Scrub all special tokens from input strings to prevent sequence forgery
    if tokenizer and hasattr(tokenizer, "all_special_tokens"):
        for tok in tokenizer.all_special_tokens:
            if tok and tok in s:
                s = s.replace(tok, " ")
    elif tokenizer and tokenizer.mask_token:
        s = s.replace(tokenizer.mask_token, " ")
    return s

def build_sequence(state, qtype_str, ins, crit, max_len=512, head_max_len=192):
    cls_id = tokenizer.cls_token_id
    sep_id = tokenizer.sep_token_id
    mask_id = tokenizer.mask_token_id
    
    def encode(text):
        return tokenizer.encode(text, add_special_tokens=False)
        
    opts = render_options(qtype_str, crit)
    head_ids = encode(f"{qtype_str} question: {scrub(ins)}")
    
    opt_ids = [[mask_id] + encode(" " + scrub(o))[:48] for o in opts]
    
    total_opt_len = sum(len(o) for o in opt_ids)
    opt_budget = head_max_len - total_opt_len
    if opt_budget < 16:
        per = max(4, (head_max_len - 16) // max(1, len(opt_ids)))
        opt_ids = [o[:per] for o in opt_ids]
        opt_budget = head_max_len - sum(len(o) for o in opt_ids)
        
    head_ids = head_ids[:max(8, opt_budget)]
    
    seq = [cls_id] + head_ids + [sep_id]
    markers = []
    for o in opt_ids:
        markers.append(len(seq))
        seq.extend(o)
    seq.append(sep_id)
    
    st_full_ids = encode(scrub(serialize_state(state)))
    room = max(0, max_len - len(seq) - 1)
    
    truncated = len(st_full_ids) > room
    st_ids = st_full_ids[:room]
    seq.extend(st_ids)
    seq.append(sep_id)
    
    seq = seq[:max_len]
    markers = [m for m in markers if m < max_len]
    
    return seq, markers, list(crit.keys()) if qtype_str == "choice" else [], truncated

# --- API Models ---
class DecisionRequest(BaseModel):
    tool: str
    args: Dict[str, Any]
    context: Optional[str] = None
    criteria: Optional[Dict[str, str]] = None

class DecisionResponse(BaseModel):
    decision: str
    reasoning: Optional[str] = None
    probability: Optional[float] = None
    probabilities: Optional[Dict[str, float]] = None

# Self-protection targets: guard engine files and harness configs against AI self-modification
PROTECTED_PATHS_RE = re.compile(
    r"(hooks/laya-pretool-hook\.js|laya_runtime/|laya_config\.json|\.claude/settings\.json|\.gemini/)",
    re.I
)

OTHER_DESTRUCTIVE_REGEXES = [
    re.compile(r"find\s+.*\s+-delete\b", re.I),
    re.compile(r"\b(mkfs|fdisk|parted)\b", re.I),
    re.compile(r"dd\s+if=/dev/(zero|urandom)\s+of=", re.I),
    re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", re.I),
    re.compile(r"chmod\s+(-[a-zA-Z]*R\s+)?777\s+/", re.I),
    re.compile(r">\s*/dev/sd[a-z]", re.I)
]

AUTHORIZATION_REGEXES = [
    re.compile(r"(curl|wget)\b.*\|\s*(sudo\s+)?(/bin/|/usr/bin/)?(bash|sh|zsh|python|perl)\b", re.I),
    re.compile(r"(bash|sh|zsh)\s+-c\s+[\"'].*\b(curl|wget)\b", re.I),
    re.compile(r"(bash|sh|zsh)\s+<\s*\(\s*(curl|wget)\b", re.I),
    re.compile(r"(curl|wget)\s+.*-o\s+\S+\s*(&&|;)\s*(sudo\s+)?(/bin/|/usr/bin/)?(bash|sh|python)", re.I),
    re.compile(r"git\s+push\s+.*(-f\b|--force\b)", re.I),
    re.compile(r"git\s+reset\s+--hard\b", re.I),
    re.compile(r"git\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d", re.I)
]

SHELL_TOOL_RE = re.compile(r"^(run_command|Bash|terminal|shell|execute_command)$", re.I)

def normalize_shell_command(cmd: str) -> str:
    # 1. Expand IFS shell substitutions commonly used to evade whitespace regex
    cmd = re.sub(r"\$\{?IFS\}?", " ", cmd)
    # 2. Collapse whitespace
    cmd = " ".join(cmd.split())
    return cmd

def is_destructive_rm(cmd: str) -> bool:
    norm = normalize_shell_command(cmd)
    rm_match = re.search(r"\b(sudo\s+)?(/bin/|/usr/bin/)?rm\b", norm, re.I)
    if not rm_match:
        return False

    after_rm = norm[rm_match.end():].strip()
    tokens = [t.strip("\"'") for t in after_rm.split() if t.strip()]

    has_recursive = False
    has_force = False
    targets = []

    for t in tokens:
        if t.startswith("-"):
            if t == "--recursive" or re.search(r"^-[a-zA-Z]*r", t, re.I):
                has_recursive = True
            if t == "--force" or re.search(r"^-[a-zA-Z]*f", t, re.I):
                has_force = True
            if t in ("-rf", "-fr", "-rfi", "-fir"):
                has_recursive = True
                has_force = True
            if t == "--no-preserve-root":
                has_force = True
        else:
            targets.append(t)

    if has_recursive and (has_force or "--no-preserve-root" in norm):
        destructive_targets = {"/", "/*", "~", "~/*", "$HOME", "${HOME}", ".", "./*", "*"}
        for tgt in targets:
            clean_tgt = tgt.rstrip("/") if tgt != "/" else "/"
            if tgt in destructive_targets or clean_tgt in ("/", "~", "$HOME", "${HOME}", "."):
                return True
    return False

def synthesize_dynamic_criteria(tool: str, args: Dict[str, Any]) -> Tuple[str, Dict[str, str]]:
    is_shell = bool(SHELL_TOOL_RE.match(tool))
    is_file_mut = bool(re.search(r"^(write|edit|replace|append|delete|remove|laya_write_file)", tool, re.I))

    cmd_str = args.get("CommandLine") or args.get("command") or args.get("cmd") or ""
    is_git = bool(re.search(r"\bgit\b", cmd_str, re.I))

    if is_git:
        context = "Evaluate the Git version control command. Is this operation standard project development or risky to repository history?"
        criteria = {
            "ALLOW": "Standard non-destructive git command: status, diff, log, commit, checkout branch, or local stash.",
            "DENY": "Catastrophic or permanent git destruction: force-deleting repositories or wiping .git configuration.",
            "REQUIRE_AUTHORIZATION": "Sensitive git operation: force pushing to remote branches (git push --force), hard resets (git reset --hard), or discarding uncommitted work."
        }
    elif is_shell:
        context = "Evaluate the shell command. Is this safe developmental work or potentially harmful to system integrity?"
        criteria = {
            "ALLOW": "Safe, non-destructive developmental command: running builds, running tests, checking status, inspecting files, local compilation, or project cleanup.",
            "DENY": "Catastrophic or malicious command: deleting root files (rm -rf /), formatting drives, raw disk writes, or executing fork bombs.",
            "REQUIRE_AUTHORIZATION": "Sensitive command requiring user awareness: installing external dependencies, executing remote download scripts (curl | bash), modifying system network settings, or launching background daemons."
        }
    elif is_file_mut:
        context = "Evaluate the file modification. Is this safe project work or does it violate security boundaries?"
        criteria = {
            "ALLOW": "Standard project file modification: editing source code, documentation, test files, or assets within the project workspace.",
            "DENY": "Malicious or unauthorized file action: writing outside the project sandbox, path traversal, or modifying protected system files.",
            "REQUIRE_AUTHORIZATION": "Sensitive configuration change: modifying package lockfiles, root configuration files (package.json, pyproject.toml), or CI/CD workflow scripts."
        }
    else:
        context = f"The agent wants to run the tool '{tool}'. Is this action safe or potentially harmful?"
        criteria = {
            "ALLOW": "The action is safe, read-only, or modifies project files in an expected, non-destructive way.",
            "DENY": "The action is highly destructive (e.g. deleting system files) or clearly malicious.",
            "REQUIRE_AUTHORIZATION": "The action carries security risk or modifies sensitive configs and requires human approval."
        }
    return context, criteria

def check_emergency_invariants(tool: str, args: Dict[str, Any]) -> Optional[str]:
    cmd_str = args.get("CommandLine") or args.get("command") or args.get("cmd") or ""
    filepath = args.get("filepath") or args.get("path") or args.get("file_path") or args.get("TargetFile") or ""

    # 1. Self-protection check: intercept any tool targeting policy engine files or harness hooks
    combined_target = f"{cmd_str} {filepath}"
    if PROTECTED_PATHS_RE.search(combined_target):
        if not re.search(r"^(read|view|search|grep)", tool, re.I):
            return "REQUIRE_AUTHORIZATION"

    # 2. Emergency invariant: Literal catastrophic destruction (e.g. rm -rf /)
    if not cmd_str and SHELL_TOOL_RE.match(tool):
        cmd_str = serialize_state(args)

    if cmd_str:
        norm_cmd = normalize_shell_command(cmd_str)
        if is_destructive_rm(norm_cmd):
            return "DENY"
        for rx in OTHER_DESTRUCTIVE_REGEXES:
            if rx.search(norm_cmd):
                return "DENY"
        for rx in AUTHORIZATION_REGEXES:
            if rx.search(norm_cmd):
                return "REQUIRE_AUTHORIZATION"
    return None

# --- Decision Endpoint ---
@app.post("/decide", response_model=DecisionResponse)
def decide(req: DecisionRequest):
    print(f"Authorizing/Evaluating with Laya Neural Brain: {req.tool} ...")
    state = req.args

    # 1. Synthesize Tool-Specific Dynamic Criteria if not explicitly provided
    if req.criteria and req.context:
        ins = req.context
        crit = req.criteria
    else:
        dynamic_ins, dynamic_crit = synthesize_dynamic_criteria(req.tool, state)
        ins = req.context if req.context else dynamic_ins
        crit = req.criteria if req.criteria else dynamic_crit

    option_keys = list(crit.keys())

    # 2. Build Sequence & Detect Truncation
    seq, markers, option_keys, truncated = build_sequence(
        state=state,
        qtype_str="choice",
        ins=ins,
        crit=crit
    )

    # Truncation Guardrail: If input exceeds sequence window, escalate to prevent payload hiding
    if truncated and "REQUIRE_AUTHORIZATION" in option_keys:
        return DecisionResponse(
            decision="REQUIRE_AUTHORIZATION",
            reasoning="Input payload exceeds 512 token context budget; truncated payloads require human authorization.",
            probability=1.0
        )

    qtype_int = 0 # 0 for choice

    inputs = {
        "input_ids": np.array([seq], dtype=np.int64),
        "attention_mask": np.ones((1, len(seq)), dtype=np.int64),
        "marker_pos": np.array([markers], dtype=np.int64),
        "marker_mask": np.ones((1, len(markers)), dtype=np.bool_),
        "qtype": np.array([qtype_int], dtype=np.int64)
    }

    # 3. Model Inference (Laya's Neural Brain Evaluates Action Upfront)
    outputs = session.run(["logits", "act_probs"], inputs)
    logits = outputs[0][0] # [K]

    # 4. Temperature-Calibrated Softmax
    K = len(option_keys)
    temp_key = f"choice:{K}"
    if temp_key not in temperature_by_options:
        if 3 <= K <= 5:
            temp_key = "choice:3-5"
        elif 6 <= K <= 10:
            temp_key = "choice:6-10"
        elif K >= 11:
            temp_key = "choice:11+"
        else:
            temp_key = "choice:2"

    T = float(temperature_by_options.get(temp_key, 1.0))
    raw_logits = np.array(logits[:K], dtype=np.float64)
    scaled_logits = raw_logits / max(1e-4, T)

    exp_logits = np.exp(scaled_logits - np.max(scaled_logits))
    probs = exp_logits / np.sum(exp_logits)

    prob_dict = {k: float(probs[i]) for i, k in enumerate(option_keys)}
    best_idx = int(np.argmax(probs))
    decision = option_keys[best_idx]
    best_prob = float(probs[best_idx])

    # 5. Security Threshold Enforcement & Multi-Class Risk Bounds
    TAU = float(os.getenv("LAYA_ALLOW_THRESHOLD", "0.60"))
    deny_prob = prob_dict.get("DENY", 0.0)
    req_prob = prob_dict.get("REQUIRE_AUTHORIZATION", 0.0)

    if decision == "ALLOW" and "REQUIRE_AUTHORIZATION" in option_keys:
        if best_prob < TAU or deny_prob > 0.25 or req_prob > 0.35:
            decision = "REQUIRE_AUTHORIZATION"
            reasoning = (
                f"Calibrated ALLOW probability {best_prob*100:.1f}% is below security threshold ({TAU*100:.0f}%) "
                f"or risk margins exceeded (DENY={deny_prob*100:.1f}%, REQ={req_prob*100:.1f}%); escalated to human authorization."
            )
        else:
            reasoning = f"Evaluated by Laya neural brain: {decision} ({best_prob*100:.1f}% confidence, temp={T:.2f})."
    else:
        reasoning = f"Evaluated by Laya neural brain: {decision} ({best_prob*100:.1f}% confidence, temp={T:.2f})."

    # 6. Emergency Invariants Safety Net:
    # Catastrophic destruction (e.g. rm -rf /) must ALWAYS DENY, overriding ALLOW and REQUIRE_AUTHORIZATION.
    # Self-protection and sensitive patterns override ALLOW to REQUIRE_AUTHORIZATION.
    emergency_verdict = check_emergency_invariants(req.tool, state)
    if emergency_verdict == "DENY":
        decision = "DENY"
        reasoning = f"Emergency safety net overrule: caught catastrophic {emergency_verdict} invariant violation."
    elif emergency_verdict == "REQUIRE_AUTHORIZATION" and decision == "ALLOW":
        decision = "REQUIRE_AUTHORIZATION"
        reasoning = f"Emergency safety net overrule: caught {emergency_verdict} invariant violation despite neural output."

    print(f"-> Final Decision: {decision} (neural={option_keys[best_idx]}, prob={best_prob:.4f}, T={T:.2f})")

    return DecisionResponse(
        decision=decision,
        reasoning=reasoning,
        probability=best_prob,
        probabilities=prob_dict
    )

def start():
    uvicorn.run(app, host="127.0.0.1", port=8000)

if __name__ == "__main__":
    start()
