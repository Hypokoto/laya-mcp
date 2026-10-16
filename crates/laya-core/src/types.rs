use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QType {
    Choice = 0,
    Score = 1,
    Noul = 2,
}

impl QType {
    pub fn as_i64(&self) -> i64 {
        *self as i64
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            QType::Choice => "choice",
            QType::Score => "score",
            QType::Noul => "noul",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyTier {
    #[serde(rename = "tier_0_hard_invariant")]
    Tier0HardInvariant,
    #[serde(rename = "tier_1_deterministic_fast_path")]
    Tier1DeterministicFastPath,
    #[serde(rename = "tier_2_neural_risk_assessment")]
    Tier2NeuralRiskAssessment,
    #[serde(rename = "tier_3_enforcement_audit")]
    Tier3EnforcementAudit,
}

impl PolicyTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            PolicyTier::Tier0HardInvariant => "tier_0_hard_invariant",
            PolicyTier::Tier1DeterministicFastPath => "tier_1_deterministic_fast_path",
            PolicyTier::Tier2NeuralRiskAssessment => "tier_2_neural_risk_assessment",
            PolicyTier::Tier3EnforcementAudit => "tier_3_enforcement_audit",
        }
    }
}

fn default_protocol_version() -> Option<String> {
    Some("1.0".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionRequest {
    #[serde(default = "default_protocol_version")]
    pub version: Option<String>,

    pub tool: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,

    /// Tool arguments, supporting both 'arguments' (v1) and 'args' (legacy)
    #[serde(default, alias = "arguments")]
    pub args: Value,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criteria: Option<HashMap<String, String>>,
}

impl DecisionRequest {
    pub fn new(tool: impl Into<String>, args: Value) -> Self {
        Self {
            version: Some("1.0".to_string()),
            tool: tool.into(),
            operation: None,
            workspace: None,
            args,
            context: None,
            criteria: None,
        }
    }

    /// Computes a deterministic canonical digest (SHA-256) over the action and its execution context.
    /// This binds authorization tokens directly to the exact tool, workspace, and arguments.
    pub fn compute_action_digest(&self, workspace: Option<&std::path::Path>) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(self.tool.trim().to_lowercase().as_bytes());
        hasher.update(b":");
        let ws_str = workspace
            .map(|p| p.to_string_lossy().to_string())
            .or_else(|| self.workspace.clone())
            .unwrap_or_default();
        hasher.update(ws_str.trim().as_bytes());
        hasher.update(b":");
        let args_str = serde_json::to_string(&self.args).unwrap_or_default();
        hasher.update(args_str.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Validates that an executed action strictly matches the cryptographically authorized digest.
    /// Returns Ok(()) if the digest matches, or an Err describing the exact tamper mismatch.
    pub fn verify_execution_binding(&self, workspace: Option<&std::path::Path>, approved_digest: &str) -> Result<(), String> {
        let current_digest = self.compute_action_digest(workspace);
        if current_digest.eq_ignore_ascii_case(approved_digest) {
            Ok(())
        } else {
            Err(format!(
                "Security violation: Action modified after authorization was granted! Approved digest: {}, Executed digest: {}",
                approved_digest, current_digest
            ))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionResponse {
    #[serde(default = "default_protocol_version")]
    pub version: Option<String>,

    pub decision: String,

    #[serde(default, skip_serializing_if = "Option::is_none", alias = "reason")]
    pub reasoning: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none", alias = "confidence")]
    pub probability: Option<f32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probabilities: Option<HashMap<String, f32>>,

    #[serde(default, skip_serializing_if = "Option::is_none", alias = "rule_id")]
    pub matched_rule: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk_category: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enforcement_action: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logits: Option<Vec<f32>>,

    /// True when the decision engine demands explicit human or adapter authorization
    #[serde(default)]
    pub approval_required: bool,

    /// Cryptographic context hash (SHA-256) binding this response to the exact tool, args, and workspace
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_digest: Option<String>,

    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskThresholds {
    pub allow_min_prob: f32,
    pub deny_max_prob: f32,
    pub require_auth_max_prob: f32,
}

impl RiskThresholds {
    pub fn new(allow_min: f32, deny_max: f32, req_max: f32) -> Self {
        Self {
            allow_min_prob: allow_min,
            deny_max_prob: deny_max,
            require_auth_max_prob: req_max,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainThresholds {
    #[serde(default = "default_shell_thresholds")]
    pub shell: RiskThresholds,
    #[serde(default = "default_file_thresholds")]
    pub file: RiskThresholds,
    #[serde(default = "default_general_thresholds")]
    pub default: RiskThresholds,
}

fn default_shell_thresholds() -> RiskThresholds {
    RiskThresholds::new(0.80, 0.10, 0.20)
}

fn default_file_thresholds() -> RiskThresholds {
    RiskThresholds::new(0.70, 0.15, 0.25)
}

fn default_general_thresholds() -> RiskThresholds {
    RiskThresholds::new(0.65, 0.20, 0.30)
}

impl Default for DomainThresholds {
    fn default() -> Self {
        Self {
            shell: default_shell_thresholds(),
            file: default_file_thresholds(),
            default: default_general_thresholds(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayaConfig {
    #[serde(default = "default_max_len")]
    pub max_len: usize,
    #[serde(default = "default_head_max_len")]
    pub head_max_len: usize,
    #[serde(default)]
    pub temperature_by_options: HashMap<String, f32>,
    #[serde(default)]
    pub thresholds: DomainThresholds,
}

fn default_max_len() -> usize {
    512
}

fn default_head_max_len() -> usize {
    192
}

impl Default for LayaConfig {
    fn default() -> Self {
        let mut map = HashMap::new();
        map.insert("choice:2".to_string(), 1.906356);
        map.insert("choice:3-5".to_string(), 1.760152);
        map.insert("choice:6-10".to_string(), 1.000016);
        map.insert("choice:11+".to_string(), 0.100583);
        map.insert("score:3-5".to_string(), 1.251_43);
        map.insert("noul:2".to_string(), 1.983_4);

        Self {
            max_len: 512,
            head_max_len: 192,
            temperature_by_options: map,
            thresholds: DomainThresholds::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_action_digest_deterministic() {
        let req1 = DecisionRequest::new("Bash", serde_json::json!({ "command": "git status" }));
        let req2 = DecisionRequest::new("Bash", serde_json::json!({ "command": "git status" }));
        let d1 = req1.compute_action_digest(Some(Path::new("/home/user/project")));
        let d2 = req2.compute_action_digest(Some(Path::new("/home/user/project")));
        assert_eq!(d1, d2);
        assert_eq!(d1.len(), 64);
    }

    #[test]
    fn test_action_digest_argument_sensitivity() {
        let req1 = DecisionRequest::new("Bash", serde_json::json!({ "command": "git status" }));
        let req2 = DecisionRequest::new("Bash", serde_json::json!({ "command": "git diff" }));
        let d1 = req1.compute_action_digest(Some(Path::new("/home/user/project")));
        let d2 = req2.compute_action_digest(Some(Path::new("/home/user/project")));
        assert_ne!(d1, d2);
    }

    #[test]
    fn test_action_digest_workspace_sensitivity() {
        let req = DecisionRequest::new("Bash", serde_json::json!({ "command": "git status" }));
        let d1 = req.compute_action_digest(Some(Path::new("/home/user/project_a")));
        let d2 = req.compute_action_digest(Some(Path::new("/home/user/project_b")));
        assert_ne!(d1, d2);
    }

    #[test]
    fn test_action_digest_tool_case_normalization() {
        let req1 = DecisionRequest::new("bash", serde_json::json!({ "command": "git status" }));
        let req2 = DecisionRequest::new("BASH", serde_json::json!({ "command": "git status" }));
        let d1 = req1.compute_action_digest(Some(Path::new("/home/user/project")));
        let d2 = req2.compute_action_digest(Some(Path::new("/home/user/project")));
        assert_eq!(d1, d2);
    }

    #[test]
    fn test_execution_binding_verification_success() {
        let req = DecisionRequest::new("Bash", serde_json::json!({ "command": "git branch -D feature" }));
        let ws = Path::new("/home/user/project");
        let digest = req.compute_action_digest(Some(ws));

        let res = req.verify_execution_binding(Some(ws), &digest);
        assert!(res.is_ok(), "Exact matching action must pass verification");
    }

    #[test]
    fn test_execution_binding_rejection_on_argument_tampering() {
        let req = DecisionRequest::new("Bash", serde_json::json!({ "command": "git branch -D feature" }));
        let ws = Path::new("/home/user/project");
        let approved_digest = req.compute_action_digest(Some(ws));

        // Attacker modifies command to target main branch
        let tampered_req = DecisionRequest::new("Bash", serde_json::json!({ "command": "git branch -D main" }));
        let res = tampered_req.verify_execution_binding(Some(ws), &approved_digest);
        assert!(res.is_err(), "Modified arguments must be rejected by execution binding");
        assert!(res.unwrap_err().contains("Security violation: Action modified"));
    }

    #[test]
    fn test_execution_binding_rejection_on_workspace_tampering() {
        let req = DecisionRequest::new("Bash", serde_json::json!({ "command": "git branch -D feature" }));
        let ws = Path::new("/home/user/project");
        let approved_digest = req.compute_action_digest(Some(ws));

        // Attacker redirects execution workspace to /etc
        let evil_ws = Path::new("/etc");
        let res = req.verify_execution_binding(Some(evil_ws), &approved_digest);
        assert!(res.is_err(), "Modified workspace must be rejected by execution binding");
        assert!(res.unwrap_err().contains("Security violation: Action modified"));
    }
}
