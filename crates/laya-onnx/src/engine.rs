use laya_core::error::{LayaError, Result};
use laya_core::policy::{check_tier0_invariants, PolicyEngine};
use laya_core::types::{DecisionRequest, DecisionResponse, LayaConfig, PolicyTier, QType};
use laya_preprocess::sequence::build_sequence;
use laya_preprocess::tokenizer::LayaTokenizer;
use ort::logging::LogLevel;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub struct LayaEngine {
    session: std::sync::Mutex<Session>,
    tokenizer: LayaTokenizer,
    config: LayaConfig,
    policy: RwLock<PolicyEngine>,
    workspace_root: Option<PathBuf>,
}

impl LayaEngine {
    pub fn load(
        model_path: &Path,
        tokenizer_path: &Path,
        config_path: Option<&Path>,
        rules_path: Option<&Path>,
        threads: usize,
    ) -> Result<Self> {
        let tokenizer = LayaTokenizer::from_file(tokenizer_path)?;

        let config = if let Some(cp) = config_path {
            if cp.exists() {
                let content = fs::read_to_string(cp)?;
                serde_json::from_str(&content).unwrap_or_default()
            } else {
                LayaConfig::default()
            }
        } else {
            LayaConfig::default()
        };

        let mut policy = PolicyEngine::new();
        if let Some(rp) = rules_path {
            if rp.exists() {
                policy.load_from_file(rp)?;
            }
        }

        let env = ort::init()
            .with_name("laya")
            .build()
            .map_err(|e| LayaError::Onnx(format!("Failed to initialize ORT environment: {}", e)))?;

        let session = Session::builder(&env)
            .map_err(|e| LayaError::Onnx(format!("Session builder error: {}", e)))?
            .with_log_level(LogLevel::Warning)
            .map_err(|e| LayaError::Onnx(format!("Log level error: {}", e)))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| LayaError::Onnx(format!("Optimization level error: {}", e)))?
            .with_intra_threads(threads)
            .map_err(|e| LayaError::Onnx(format!("Thread configuration error: {}", e)))?
            .commit_from_file(model_path)
            .map_err(|e| LayaError::Onnx(format!("Failed to load ONNX model: {}", e)))?;

        Ok(Self {
            session: std::sync::Mutex::new(session),
            tokenizer,
            config,
            policy: RwLock::new(policy),
            workspace_root: None,
        })
    }

    pub fn set_workspace_root<P: AsRef<Path>>(&mut self, root: P) {
        self.workspace_root = Some(root.as_ref().to_path_buf());
    }

    pub fn decide(&self, req: &DecisionRequest) -> Result<DecisionResponse> {
        // Tier 0: Hard Invariants & Self-Protection (Deterministic, zero ML, non-negotiable)
        if let Some((emergency_verdict, invariant_name)) = check_tier0_invariants(&req.tool, &req.args) {
            if emergency_verdict == "DENY" {
                let mut prob_map = HashMap::new();
                prob_map.insert("DENY".to_string(), 1.0);
                prob_map.insert("ALLOW".to_string(), 0.0);
                prob_map.insert("REQUIRE_AUTHORIZATION".to_string(), 0.0);

                return Ok(DecisionResponse {
                    decision: "DENY".to_string(),
                    reasoning: Some("Tier 0 hard security invariant overrule: catastrophic command violation.".to_string()),
                    probability: Some(1.0),
                    probabilities: Some(prob_map),
                    matched_rule: Some(invariant_name.to_string()),
                    tier: Some(PolicyTier::Tier0HardInvariant.as_str().to_string()),
                    temperature: Some(1.0),
                    logits: None,
                    is_error: false,
                });
            } else if emergency_verdict == "REQUIRE_AUTHORIZATION" {
                let policy = self.policy.read().unwrap();
                let rule_match = policy.evaluate(&req.tool, &req.args, self.workspace_root.as_deref());
                if let Some((rule_action, rule_name)) = rule_match {
                    if rule_action == "DENY" {
                        let mut prob_map = HashMap::new();
                        prob_map.insert("DENY".to_string(), 1.0);
                        prob_map.insert("ALLOW".to_string(), 0.0);
                        prob_map.insert("REQUIRE_AUTHORIZATION".to_string(), 0.0);

                        return Ok(DecisionResponse {
                            decision: "DENY".to_string(),
                            reasoning: Some(format!("Matched declarative policy rule '{}': DENY.", rule_name)),
                            probability: Some(1.0),
                            probabilities: Some(prob_map),
                            matched_rule: Some(rule_name.to_string()),
                            tier: Some(PolicyTier::Tier1DeterministicFastPath.as_str().to_string()),
                            temperature: Some(1.0),
                            logits: None,
                            is_error: false,
                        });
                    }
                }

                let mut prob_map = HashMap::new();
                prob_map.insert("DENY".to_string(), 0.0);
                prob_map.insert("ALLOW".to_string(), 0.0);
                prob_map.insert("REQUIRE_AUTHORIZATION".to_string(), 1.0);

                return Ok(DecisionResponse {
                    decision: "REQUIRE_AUTHORIZATION".to_string(),
                    reasoning: Some("Tier 0 hard invariant overrule: self-protection or sensitive operation invariant violation.".to_string()),
                    probability: Some(1.0),
                    probabilities: Some(prob_map),
                    matched_rule: Some(invariant_name.to_string()),
                    tier: Some(PolicyTier::Tier0HardInvariant.as_str().to_string()),
                    temperature: Some(1.0),
                    logits: None,
                    is_error: false,
                });
            }
        }

        // Tier 1: Declarative Fast-Path & User Rules Engine
        {
            let policy = self.policy.read().unwrap();
            let rule_match = policy.evaluate(&req.tool, &req.args, self.workspace_root.as_deref());
            if let Some((rule_action, rule_name)) = rule_match {
                let mut prob_map = HashMap::new();
                prob_map.insert("ALLOW".to_string(), if rule_action == "ALLOW" { 1.0 } else { 0.0 });
                prob_map.insert("DENY".to_string(), if rule_action == "DENY" { 1.0 } else { 0.0 });
                prob_map.insert("REQUIRE_AUTHORIZATION".to_string(), if rule_action == "REQUIRE_AUTHORIZATION" { 1.0 } else { 0.0 });

                return Ok(DecisionResponse {
                    decision: rule_action.to_string(),
                    reasoning: Some(format!("Matched declarative policy rule '{}': {}.", rule_name, rule_action)),
                    probability: Some(1.0),
                    probabilities: Some(prob_map),
                    matched_rule: Some(rule_name.to_string()),
                    tier: Some(PolicyTier::Tier1DeterministicFastPath.as_str().to_string()),
                    temperature: Some(1.0),
                    logits: None,
                    is_error: false,
                });
            }
        }

        // Tier 2: Neural Brain Inference (ModernBERT Calibrated Risk Assessment)
        let (dynamic_context, dynamic_criteria) = synthesize_dynamic_criteria(&req.tool, &req.args);

        let criteria = match &req.criteria {
            Some(c) if !c.is_empty() => c,
            _ => &dynamic_criteria,
        };

        let instruction = req.context.as_deref().unwrap_or(&dynamic_context);
        let qtype = QType::Choice;

        let seq = build_sequence(
            &self.tokenizer,
            &req.args,
            qtype,
            instruction,
            criteria,
            self.config.max_len,
            self.config.head_max_len,
        )?;

        // Guardrail: if truncated, escalate to human authorization
        if seq.is_truncated && criteria.contains_key("REQUIRE_AUTHORIZATION") {
            let mut prob_map = HashMap::new();
            for k in &seq.option_keys {
                prob_map.insert(k.clone(), if k == "REQUIRE_AUTHORIZATION" { 1.0 } else { 0.0 });
            }
            return Ok(DecisionResponse {
                decision: "REQUIRE_AUTHORIZATION".to_string(),
                reasoning: Some("Input payload exceeds 512 token context budget; truncated payloads require human authorization.".to_string()),
                probability: Some(1.0),
                probabilities: Some(prob_map),
                matched_rule: Some("TRUNCATION_ESCALATION".to_string()),
                tier: Some(PolicyTier::Tier2NeuralRiskAssessment.as_str().to_string()),
                temperature: Some(1.0),
                logits: None,
                is_error: false,
            });
        }

        let input_ids_len = seq.input_ids.len();
        let marker_len = seq.marker_pos.len();

        let input_ids_tensor = Tensor::from_array(([1, input_ids_len], seq.input_ids))
            .map_err(|e| LayaError::Onnx(e.to_string()))?;
        let attention_mask_tensor = Tensor::from_array(([1, input_ids_len], seq.attention_mask))
            .map_err(|e| LayaError::Onnx(e.to_string()))?;
        let marker_pos_tensor = Tensor::from_array(([1, marker_len], seq.marker_pos))
            .map_err(|e| LayaError::Onnx(e.to_string()))?;
        let marker_mask_tensor = Tensor::from_array(([1, marker_len], seq.marker_mask))
            .map_err(|e| LayaError::Onnx(e.to_string()))?;
        let qtype_tensor = Tensor::from_array(([1], vec![seq.qtype]))
            .map_err(|e| LayaError::Onnx(e.to_string()))?;

        let start_time = std::time::Instant::now();
        let mut session = self.session.lock().map_err(|e| LayaError::Internal(e.to_string()))?;
        let outputs = session.run(ort::inputs![
            "input_ids" => input_ids_tensor,
            "attention_mask" => attention_mask_tensor,
            "marker_pos" => marker_pos_tensor,
            "marker_mask" => marker_mask_tensor,
            "qtype" => qtype_tensor,
        ])
        .map_err(|e| LayaError::Onnx(format!("Inference run error: {}", e)))?;

        let elapsed = start_time.elapsed();

        let logits_val = outputs.get("logits")
            .ok_or_else(|| LayaError::Onnx("Missing 'logits' output in model response".to_string()))?;
        let (_, raw_logits) = logits_val.try_extract_tensor::<f32>()
            .map_err(|e| LayaError::Onnx(format!("Failed to extract logits tensor: {}", e)))?;

        let num_opts = seq.option_keys.len();
        let logits_slice = &raw_logits[..std::cmp::min(num_opts, raw_logits.len())];

        // Temperature calibration
        let k = num_opts;
        let temp_key = match k {
            2 => "choice:2",
            3..=5 => "choice:3-5",
            6..=10 => "choice:6-10",
            _ => "choice:11+",
        };
        let t = *self.config.temperature_by_options.get(temp_key).unwrap_or(&1.760152);

        let scaled_logits: Vec<f32> = logits_slice.iter().map(|&l| l / t.max(1e-4)).collect();
        let max_l = scaled_logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let exps: Vec<f32> = scaled_logits.iter().map(|&l| (l - max_l).exp()).collect();
        let sum_exps: f32 = exps.iter().sum();
        let probs: Vec<f32> = exps.iter().map(|&e| e / sum_exps.max(1e-8)).collect();

        let mut prob_map = HashMap::new();
        let mut best_idx = 0;
        let mut best_prob = -1.0f32;

        for (i, opt_key) in seq.option_keys.iter().enumerate() {
            let p = probs.get(i).copied().unwrap_or(0.0);
            prob_map.insert(opt_key.clone(), p);
            if p > best_prob {
                best_prob = p;
                best_idx = i;
            }
        }

        let mut decision = seq.option_keys.get(best_idx).cloned().unwrap_or_else(|| "DENY".to_string());

        let is_shell_tool = is_shell_execution_tool(&req.tool);
        let is_file_tool = is_file_mutation_tool(&req.tool);

        let domain_threshold = if is_shell_tool {
            &self.config.thresholds.shell
        } else if is_file_tool {
            &self.config.thresholds.file
        } else {
            &self.config.thresholds.default
        };

        let tau_allow = std::env::var("LAYA_ALLOW_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(domain_threshold.allow_min_prob);
        let tau_deny = domain_threshold.deny_max_prob;
        let tau_req = domain_threshold.require_auth_max_prob;

        let deny_prob = prob_map.get("DENY").copied().unwrap_or(0.0);
        let req_prob = prob_map.get("REQUIRE_AUTHORIZATION").copied().unwrap_or(0.0);

        let mut reasoning = format!(
            "Evaluated native Rust Laya ONNX engine: {} ({:.1}% confidence, {:.1}ms inference).",
            decision,
            best_prob * 100.0,
            elapsed.as_secs_f64() * 1000.0
        );

        if decision == "ALLOW"
            && criteria.contains_key("REQUIRE_AUTHORIZATION")
            && (best_prob < tau_allow || deny_prob > tau_deny || req_prob > tau_req)
        {
            decision = "REQUIRE_AUTHORIZATION".to_string();
            reasoning = format!(
                "Calibrated ALLOW probability {:.1}% is below domain threshold ({:.0}%) or risk margins exceeded (DENY={:.1}%, REQ={:.1}%); escalated to human authorization.",
                best_prob * 100.0,
                tau_allow * 100.0,
                deny_prob * 100.0,
                req_prob * 100.0
            );
        }

        Ok(DecisionResponse {
            decision,
            reasoning: Some(reasoning),
            probability: Some(best_prob),
            probabilities: Some(prob_map),
            matched_rule: None,
            tier: Some(PolicyTier::Tier2NeuralRiskAssessment.as_str().to_string()),
            temperature: Some(t),
            logits: Some(logits_slice.to_vec()),
            is_error: false,
        })
    }
}

pub fn is_shell_execution_tool(tool: &str) -> bool {
    let tool_lower = tool.to_lowercase();
    matches!(
        tool_lower.as_str(),
        "run_command" | "bash" | "terminal" | "shell" | "execute_command" | "laya_run_command"
    )
}

pub fn is_file_mutation_tool(tool: &str) -> bool {
    let tool_lower = tool.to_lowercase();
    tool_lower.starts_with("write")
        || tool_lower.starts_with("edit")
        || tool_lower.starts_with("replace")
        || tool_lower.starts_with("append")
        || tool_lower.starts_with("delete")
        || tool_lower.starts_with("remove")
        || tool_lower.starts_with("laya_write_file")
        || tool_lower.contains("write_file")
        || tool_lower.contains("edit_file")
        || tool_lower.contains("remove_file")
        || tool_lower.contains("delete_file")
}

fn synthesize_dynamic_criteria(tool: &str, args: &serde_json::Value) -> (String, HashMap<String, String>) {
    let is_shell = is_shell_execution_tool(tool);
    let is_file_mut = is_file_mutation_tool(tool);

    let cmd_str = args
        .get("CommandLine")
        .or_else(|| args.get("command"))
        .or_else(|| args.get("cmd"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let is_git = cmd_str.split_whitespace().any(|tok| tok.eq_ignore_ascii_case("git"));

    let mut criteria = HashMap::new();
    let context;

    if is_git {
        context = "Evaluate the Git version control command. Is this operation standard project development or risky to repository history?".to_string();
        criteria.insert("ALLOW".to_string(), "Standard non-destructive git command: status, diff, log, commit, checkout branch, or local stash.".to_string());
        criteria.insert("DENY".to_string(), "Catastrophic or permanent git destruction: force-deleting repositories or wiping .git configuration.".to_string());
        criteria.insert("REQUIRE_AUTHORIZATION".to_string(), "Sensitive git operation: force pushing to remote branches (git push --force), hard resets (git reset --hard), or discarding uncommitted work.".to_string());
    } else if is_shell {
        context = "Evaluate the shell command. Is this safe developmental work or potentially harmful to system integrity?".to_string();
        criteria.insert("ALLOW".to_string(), "Safe, non-destructive developmental command: running builds, running tests, checking status, inspecting files, local compilation, or project cleanup.".to_string());
        criteria.insert("DENY".to_string(), "Catastrophic or malicious command: deleting root files (rm -rf /), formatting drives, raw disk writes, or executing fork bombs.".to_string());
        criteria.insert("REQUIRE_AUTHORIZATION".to_string(), "Sensitive command requiring user awareness: installing external dependencies, executing remote download scripts (curl | bash), modifying system network settings, or launching background daemons.".to_string());
    } else if is_file_mut {
        context = "Evaluate the file modification. Is this safe project work or does it violate security boundaries?".to_string();
        criteria.insert("ALLOW".to_string(), "Standard project file modification: editing source code, documentation, test files, or assets within the project workspace.".to_string());
        criteria.insert("DENY".to_string(), "Malicious or unauthorized file action: writing outside the project sandbox, path traversal, or modifying protected system files.".to_string());
        criteria.insert("REQUIRE_AUTHORIZATION".to_string(), "Sensitive configuration change: modifying package lockfiles, root configuration files (package.json, pyproject.toml), or CI/CD workflow scripts.".to_string());
    } else {
        context = format!("The agent wants to run the tool '{}'. Is this action safe or potentially harmful?", tool);
        criteria.insert("ALLOW".to_string(), "The action is safe, read-only, or modifies project files in an expected, non-destructive way.".to_string());
        criteria.insert("DENY".to_string(), "The action is highly destructive (e.g. deleting system files) or clearly malicious.".to_string());
        criteria.insert("REQUIRE_AUTHORIZATION".to_string(), "The action carries security risk or modifies sensitive configs and requires human approval.".to_string());
    }

    (context, criteria)
}
