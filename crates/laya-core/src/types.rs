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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionRequest {
    pub tool: String,
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criteria: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionResponse {
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probability: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probabilities: Option<HashMap<String, f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logits: Option<Vec<f32>>,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayaConfig {
    #[serde(default = "default_max_len")]
    pub max_len: usize,
    #[serde(default = "default_head_max_len")]
    pub head_max_len: usize,
    #[serde(default)]
    pub temperature_by_options: HashMap<String, f32>,
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
        }
    }
}
