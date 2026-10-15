from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, Optional, List
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

# Dangerous action patterns for policy guardrails (normalized regex)
DESTRUCTIVE_REGEXES = [
    re.compile(r"rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(/|/\*|~|\$HOME|\*)", re.I),
    re.compile(r"rm\s+-[a-zA-Z]*r[a-zA-Z]*f*\s+(/|/\*|~|\$HOME|\*)", re.I),
    re.compile(r"rm\s+-[a-zA-Z]*f[a-zA-Z]*r*\s+(/|/\*|~|\$HOME|\*)", re.I),
    re.compile(r"find\s+.*\s+-delete\b", re.I),
    re.compile(r"\b(mkfs|fdisk|parted)\b", re.I),
    re.compile(r"dd\s+if=/dev/(zero|urandom)\s+of=", re.I),
    re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", re.I),
    re.compile(r"chmod\s+(-[a-zA-Z]*R\s+)?777\s+/", re.I),
    re.compile(r">\s*/dev/sd[a-z]", re.I)
]

AUTHORIZATION_REGEXES = [
    re.compile(r"\|\s*(bash|sh|zsh)\b", re.I),
    re.compile(r"bash\s+<\s*\(", re.I),
    re.compile(r"(curl|wget)\s+.*(\||;|\&\&)\s*(sh|bash|python|perl)", re.I),
    re.compile(r"curl\s+-[a-zA-Z]*o\s+\S+;\s*(sh|bash)", re.I)
]

SHELL_TOOL_RE = re.compile(r"^(run_command|Bash|terminal|shell|execute_command)$", re.I)

def check_policy_patterns(tool: str, args: Dict[str, Any]) -> Optional[str]:
    # Extract command string if available
    cmd_str = args.get("CommandLine") or args.get("command") or args.get("cmd") or ""
    if not cmd_str and SHELL_TOOL_RE.match(tool):
        cmd_str = serialize_state(args)

    # Only run shell command regexes on shell tools or explicit command parameters
    if cmd_str:
        normalized_cmd = " ".join(cmd_str.split())
        for rx in DESTRUCTIVE_REGEXES:
            if rx.search(normalized_cmd):
                return "DENY"
        for rx in AUTHORIZATION_REGEXES:
            if rx.search(normalized_cmd):
                return "REQUIRE_AUTHORIZATION"
    return None

# --- Decision Endpoint ---
@app.post("/decide", response_model=DecisionResponse)
def decide(req: DecisionRequest):
    print(f"Authorizing/Evaluating: {req.tool} ...")
    
    ins = req.context if req.context else f"The agent wants to run the tool '{req.tool}'. Is this action safe or highly destructive?"
    state = req.args
    
    if req.criteria:
        crit = req.criteria
    else:
        crit = {
            "ALLOW": "The action is safe, read-only, or modifies project files in an expected, non-destructive way.",
            "DENY": "The action is highly destructive (e.g. rm -rf, deleting system files) or clearly malicious.",
            "REQUIRE_AUTHORIZATION": "The action is risky but potentially valid (e.g. installing dependencies) and requires human approval."
        }
    
    option_keys = list(crit.keys())
    
    # 1. Deterministic Security Pattern Guardrails
    verdict = check_policy_patterns(req.tool, state)
    if verdict and verdict in option_keys:
        reasoning = (
            f"Action classified as {verdict} by Laya policy guardrails: matched sensitive pattern."
            if verdict == "REQUIRE_AUTHORIZATION"
            else f"Action DENIED by Laya policy guardrails: highly destructive command or action detected."
        )
        print(f"-> Guardrail Decision: {verdict}")
        return DecisionResponse(decision=verdict, reasoning=reasoning, probability=1.0)
    
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
    
    # 3. Model Inference
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
    
    # 5. Security Threshold Enforcement (tau = 0.50 default, configurable via LAYA_ALLOW_THRESHOLD)
    TAU = float(os.getenv("LAYA_ALLOW_THRESHOLD", "0.50"))
    if decision == "ALLOW" and best_prob < TAU and "REQUIRE_AUTHORIZATION" in option_keys:
        decision = "REQUIRE_AUTHORIZATION"
        reasoning = f"Calibrated ALLOW probability {best_prob*100:.1f}% is below security threshold ({TAU*100:.0f}%); escalated to human authorization."
    else:
        reasoning = f"Calibrated decision: {decision} ({best_prob*100:.1f}% confidence, temp={T:.2f})."
        
    print(f"-> Decision: {decision} (prob={best_prob:.4f}, T={T:.2f})")
    
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
