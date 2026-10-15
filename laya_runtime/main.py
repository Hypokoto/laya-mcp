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
    matched_rule: Optional[str] = None
    temperature: Optional[float] = None

# Self-protection targets: guard engine files, rule files, and harness configs against AI self-modification
PROTECTED_PATHS_RE = re.compile(
    r"(hooks/laya-pretool-hook\.js|laya_runtime/|laya_config\.json|laya_rules\.json|\.laya/|\.claude/settings\.json|\.gemini/)",
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

_RULES_CACHE: Dict[str, Any] = {
    "file_path": None,
    "mtime": 0.0,
    "rules": []
}

def load_user_rules() -> List[Dict[str, Any]]:
    """Loads declarative policy rules cached by file modification time (mtime).
    Pre-compiles regex patterns at load time and skips rules with invalid regexes.
    """
    global _RULES_CACHE
    candidate_paths = [
        os.path.join(BASE_DIR, "..", ".laya", "rules.json"),
        os.path.join(BASE_DIR, "..", "laya_rules.json"),
    ]
    if os.environ.get("LAYA_RULES_PATH"):
        candidate_paths.insert(0, os.environ["LAYA_RULES_PATH"])
    if os.environ.get("LAYA_ALLOW_CWD_RULES") == "1":
        candidate_paths.extend([
            os.path.join(os.getcwd(), ".laya", "rules.json"),
            os.path.join(os.getcwd(), "laya_rules.json"),
        ])

    found_path = None
    for cp in candidate_paths:
        if os.path.exists(cp):
            found_path = cp
            break

    if not found_path:
        return []

    try:
        current_mtime = os.path.getmtime(found_path)
    except OSError:
        return []

    if _RULES_CACHE["file_path"] == found_path and _RULES_CACHE["mtime"] == current_mtime:
        return _RULES_CACHE["rules"]

    compiled_rules = []
    try:
        with open(found_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            raw_rules = data.get("rules", []) if isinstance(data, dict) else data
            if isinstance(raw_rules, list):
                for r in raw_rules:
                    if not isinstance(r, dict):
                        continue
                    action_raw = r.get("action")
                    if not isinstance(action_raw, str):
                        continue
                    action = action_raw.strip().upper()
                    if action not in ("ALLOW", "DENY", "REQUIRE_AUTHORIZATION"):
                        continue

                    rule_entry = {
                        "name": str(r.get("name") or r.get("id") or "unnamed-rule"),
                        "action": action,
                        "tool_re": None,
                        "cmd_re": None,
                        "path_re": None
                    }
                    try:
                        tool_pat = r.get("tool") or r.get("toolPattern")
                        if isinstance(tool_pat, str) and tool_pat:
                            rule_entry["tool_re"] = re.compile(tool_pat, re.I)
                        cmd_pat = r.get("commandPattern")
                        if isinstance(cmd_pat, str) and cmd_pat:
                            rule_entry["cmd_re"] = re.compile(cmd_pat, re.I)
                        path_pat = r.get("pathPattern")
                        if isinstance(path_pat, str) and path_pat:
                            rule_entry["path_re"] = re.compile(path_pat, re.I)

                        # Security restriction: Broad tool-only ALLOW rules (without a specific commandPattern or pathPattern)
                        # cannot bypass the neural model or risk-threshold evaluation.
                        if action == "ALLOW" and not rule_entry["cmd_re"] and not rule_entry["path_re"]:
                            print(f"Warning: Skipping tool-only ALLOW rule '{rule_entry['name']}': ALLOW rules must specify commandPattern or pathPattern to protect neural evaluation.")
                            continue
                        compiled_rules.append(rule_entry)
                    except Exception as e:
                        print(f"Warning: Skipping rule '{rule_entry['name']}' in {found_path}: {e}")
                        continue
    except Exception as e:
        print(f"Warning: Failed to load user rules from {found_path}: {e}")
        return []

    _RULES_CACHE = {
        "file_path": found_path,
        "mtime": current_mtime,
        "rules": compiled_rules
    }
    return compiled_rules

def evaluate_user_rules(tool: str, args: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """Evaluates declarative policy rules.
    Matches use cached, pre-compiled regex patterns to avoid disk I/O on the hot path.
    """
    rules = load_user_rules()
    if not rules:
        return None

    cmd_str = args.get("CommandLine") or args.get("command") or args.get("cmd") or ""
    raw_fp = args.get("filepath") or args.get("path") or args.get("file_path") or args.get("TargetFile") or ""
    filepath = raw_fp if isinstance(raw_fp, str) else str(raw_fp) if raw_fp is not None else ""

    canonical_rel_path = filepath
    is_path_traversal = False
    if filepath:
        workspace_dir = os.path.realpath(os.environ.get("ALLOWED_DIR") or os.path.abspath(os.path.join(BASE_DIR, "..")))
        clean_path = filepath.replace("\0", "")
        resolved_target = os.path.realpath(os.path.join(workspace_dir, clean_path))
        try:
            rel = os.path.relpath(resolved_target, workspace_dir)
            if rel.startswith("..") or os.path.isabs(rel):
                is_path_traversal = True
            else:
                canonical_rel_path = rel.replace("\\", "/")
        except (ValueError, OSError):
            is_path_traversal = True

    for r in rules:
        if r["tool_re"] and not r["tool_re"].search(tool):
            continue
        # Security restriction: A path-only ALLOW rule cannot approve a request that contains a shell command
        if r["action"] == "ALLOW" and cmd_str and not r["cmd_re"]:
            continue
        # Security restriction: An ALLOW rule cannot approve a path traversal attempt outside workspace
        if r["action"] == "ALLOW" and is_path_traversal:
            continue
        if r["cmd_re"] and (not cmd_str or not r["cmd_re"].search(cmd_str)):
            continue
        if r["path_re"]:
            if not filepath:
                continue
            if not r["path_re"].search(canonical_rel_path) and not r["path_re"].search(filepath):
                continue
            if r["action"] == "ALLOW" and not r["path_re"].search(canonical_rel_path):
                continue
        return r["action"], r["name"]

    return None

# --- Decision Endpoint ---
@app.post("/decide", response_model=DecisionResponse)
def decide(req: DecisionRequest):
    print(f"Authorizing/Evaluating with Laya Neural Brain: {req.tool} ...")
    state = req.args

    # 1. Synthesize Tool-Specific Dynamic Criteria if not explicitly provided or if security options are missing
    required_security_options = {"ALLOW", "DENY", "REQUIRE_AUTHORIZATION"}
    is_security_tool = bool(SHELL_TOOL_RE.match(req.tool) or re.search(r"^(write|edit|replace|append|delete|remove|laya_write_file)", req.tool, re.I))

    if req.criteria and req.context and (not is_security_tool or required_security_options.issubset(set(req.criteria.keys()))):
        ins = req.context
        crit = req.criteria
    else:
        dynamic_ins, dynamic_crit = synthesize_dynamic_criteria(req.tool, state)
        ins = req.context if req.context else dynamic_ins
        crit = dynamic_crit

    option_keys = list(crit.keys())

    # 2. Emergency Invariants Safety Net (Strict Supremacy: Runs BEFORE rules and truncation check)
    emergency_verdict = check_emergency_invariants(req.tool, state)
    if emergency_verdict == "DENY":
        return DecisionResponse(
            decision="DENY",
            reasoning="Emergency safety net overrule: caught catastrophic DENY invariant violation.",
            probability=1.0,
            probabilities={"DENY": 1.0, "ALLOW": 0.0, "REQUIRE_AUTHORIZATION": 0.0},
            matched_rule="EMERGENCY_INVARIANT_DENY",
            temperature=1.0
        )
    elif emergency_verdict == "REQUIRE_AUTHORIZATION":
        rule_match = evaluate_user_rules(req.tool, state)
        if rule_match and rule_match[0] == "DENY":
            return DecisionResponse(
                decision="DENY",
                reasoning=f"Matched declarative policy rule '{rule_match[1]}': DENY.",
                probability=1.0,
                probabilities={"DENY": 1.0, "ALLOW": 0.0, "REQUIRE_AUTHORIZATION": 0.0},
                matched_rule=rule_match[1],
                temperature=1.0
            )
        return DecisionResponse(
            decision="REQUIRE_AUTHORIZATION",
            reasoning="Emergency safety net overrule: self-protection or sensitive action invariant violation.",
            probability=1.0,
            probabilities={"DENY": 0.0, "ALLOW": 0.0, "REQUIRE_AUTHORIZATION": 1.0},
            matched_rule="EMERGENCY_INVARIANT_REQUIRE_AUTH",
            temperature=1.0
        )

    # 3. Build Sequence & Detect Truncation
    seq, markers, option_keys, truncated = build_sequence(
        state=state,
        qtype_str="choice",
        ins=ins,
        crit=crit
    )

    # Truncation Guardrail: If input exceeds sequence window, escalate to prevent payload hiding.
    # Note: Truncated payloads MUST NOT be bypassed by user ALLOW rules.
    if truncated and "REQUIRE_AUTHORIZATION" in option_keys:
        return DecisionResponse(
            decision="REQUIRE_AUTHORIZATION",
            reasoning="Input payload exceeds 512 token context budget; truncated payloads require human authorization.",
            probability=1.0,
            probabilities={k: (1.0 if k == "REQUIRE_AUTHORIZATION" else 0.0) for k in option_keys},
            matched_rule="TRUNCATION_ESCALATION",
            temperature=1.0
        )

    # 4. Declarative User Rules (.laya/rules.json / laya_rules.json)
    # When matched, explicit declarative policy rules override neural inference.
    rule_match = evaluate_user_rules(req.tool, state)
    if rule_match:
        rule_action, rule_name = rule_match
        prob_dict = {k: (1.0 if k == rule_action else 0.0) for k in option_keys}
        if rule_action not in prob_dict:
            prob_dict[rule_action] = 1.0
        return DecisionResponse(
            decision=rule_action,
            reasoning=f"Matched declarative policy rule '{rule_name}': {rule_action}.",
            probability=1.0,
            probabilities=prob_dict,
            matched_rule=rule_name,
            temperature=1.0
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
        probabilities=prob_dict,
        matched_rule=None,
        temperature=T
    )

def start():
    uvicorn.run(app, host="127.0.0.1", port=8000)

if __name__ == "__main__":
    start()
