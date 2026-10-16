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
