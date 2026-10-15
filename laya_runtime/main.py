from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, Optional, List
import os
import json
import numpy as np
import uvicorn
import onnxruntime as ort
from transformers import AutoTokenizer

app = FastAPI(title="Laya Runtime", description="Decision policy layer for MCP")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "..", "laya.onnx")
TOKENIZER_PATH = os.path.join(BASE_DIR, "..", "tokenizer")

tokenizer = None
session = None

@app.on_event("startup")
async def load_model():
    global tokenizer, session
    print(f"Loading tokenizer from {TOKENIZER_PATH}...")
    tokenizer = AutoTokenizer.from_pretrained(TOKENIZER_PATH)
    
    print(f"Loading ONNX model from {MODEL_PATH}...")
    # Use CPU execution provider by default, onnxruntime-opt-rocm will accelerate it if configured
    session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    print("Laya ONNX model successfully loaded.")

# --- Sequence Building (Ported from sequence.ts) ---
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

def build_sequence(state, qtype_str, ins, crit, max_len=512, head_max_len=192):
    cls_id = tokenizer.cls_token_id
    sep_id = tokenizer.sep_token_id
    mask_id = tokenizer.mask_token_id
    mask_tok = tokenizer.mask_token
    
    def scrub(s):
        return s.replace(mask_tok, " ")
        
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
    
    room = max(0, max_len - len(seq) - 1)
    st_ids = encode(scrub(serialize_state(state)))[:room]
    seq.extend(st_ids)
    seq.append(sep_id)
    
    seq = seq[:max_len]
    markers = [m for m in markers if m < max_len]
    
    return seq, markers, list(crit.keys()) if qtype_str == "choice" else []

# --- API Models ---
class DecisionRequest(BaseModel):
    tool: str
    args: Dict[str, Any]
    context: Optional[str] = None
    criteria: Optional[Dict[str, str]] = None

class DecisionResponse(BaseModel):
    decision: str
    reasoning: Optional[str] = None

# Dangerous action patterns for policy guardrails
DESTRUCTIVE_PATTERNS = [
    "rm -rf /", "rm -rf /*", "rm -rf *", "rm -rf ~", "rm -rf $HOME",
    "rm -r /", "rm -r /*", "rm -r *",
    "mkfs", "fdisk", "dd if=/dev/zero", "dd if=/dev/urandom",
    ":(){ :|:& };:", "chmod -R 777 /", "> /dev/sda"
]

AUTHORIZATION_PATTERNS = [
    "| bash", "| sh", "| zsh", "curl -s http", "wget -O- http"
]

def check_policy_patterns(state_str: str) -> Optional[str]:
    state_lower = state_str.lower()
    for pat in DESTRUCTIVE_PATTERNS:
        if pat.lower() in state_lower:
            return "DENY"
    for pat in AUTHORIZATION_PATTERNS:
        if pat.lower() in state_lower:
            return "REQUIRE_AUTHORIZATION"
    return None

# --- Decision Endpoint ---
@app.post("/decide", response_model=DecisionResponse)
async def decide(req: DecisionRequest):
    print(f"Authorizing/Evaluating: {req.tool} ...")
    
    # Formulate policy question (use custom if provided, otherwise default to policy)
    ins = req.context if req.context else f"The agent wants to run the tool '{req.tool}'. Is this action safe or highly destructive?"
    state = req.args
    state_str = serialize_state(state)
    
    if req.criteria:
        crit = req.criteria
    else:
        crit = {
            "ALLOW": "The action is safe, read-only, or modifies project files in an expected, non-destructive way.",
            "DENY": "The action is highly destructive (e.g. rm -rf, deleting system files) or clearly malicious.",
            "REQUIRE_AUTHORIZATION": "The action is risky but potentially valid (e.g. installing dependencies) and requires human approval."
        }
    
    option_keys = list(crit.keys())
    
    # Check deterministic security policy guardrails
    verdict = check_policy_patterns(state_str)
    if verdict and verdict in option_keys:
        reasoning = (
            f"Action classified as {verdict} by Laya policy guardrails: matched sensitive pattern."
            if verdict == "REQUIRE_AUTHORIZATION"
            else f"Action DENIED by Laya policy guardrails: highly destructive command or action detected."
        )
        print(f"-> Guardrail Decision: {verdict}")
        return DecisionResponse(decision=verdict, reasoning=reasoning)
    
    seq, markers, option_keys = build_sequence(
        state=state,
        qtype_str="choice",
        ins=ins,
        crit=crit
    )
    
    qtype_int = 0 # 0 for choice
    
    inputs = {
        "input_ids": np.array([seq], dtype=np.int64),
        "attention_mask": np.ones((1, len(seq)), dtype=np.int64),
        "marker_pos": np.array([markers], dtype=np.int64),
        "marker_mask": np.ones((1, len(markers)), dtype=np.bool_),
        "qtype": np.array([qtype_int], dtype=np.int64)
    }
    
    # Run Inference
    outputs = session.run(["logits", "act_probs"], inputs)
    logits = outputs[0][0] # [K]
    print(f"Logits: {logits}")
    
    # The logits array has the same length as markers (K).
    # We find the index of the maximum logit
    best_idx = int(np.argmax(logits))
    decision = option_keys[best_idx]
    
    reasoning = f"Laya confidence high for {decision}."
    print(f"-> Decision: {decision}")
    
    return DecisionResponse(decision=decision, reasoning=reasoning)

def start():
    uvicorn.run(app, host="0.0.0.0", port=8000)

if __name__ == "__main__":
    start()

