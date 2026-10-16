use crate::tokenizer::{LayaTokenizer, CLS_ID, MASK_ID, SEP_ID};
use laya_core::error::Result;
use laya_core::types::QType;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct PreprocessedSequence {
    pub input_ids: Vec<i64>,
    pub attention_mask: Vec<i64>,
    pub marker_pos: Vec<i64>,
    pub marker_mask: Vec<bool>,
    pub qtype: i64,
    pub option_keys: Vec<String>,
    pub is_truncated: bool,
}

pub fn render_options(qtype: QType, criteria: &HashMap<String, String>) -> (Vec<String>, Vec<String>) {
    match qtype {
        QType::Choice => {
            let mut keys: Vec<String> = criteria.keys().cloned().collect();
            // Deterministic order: if ALLOW/DENY/REQUIRE_AUTHORIZATION, keep consistent ordering
            keys.sort_by(|a, b| {
                let rank = |k: &str| match k {
                    "ALLOW" => 0,
                    "DENY" => 1,
                    "REQUIRE_AUTHORIZATION" => 2,
                    _ => 3,
                };
                rank(a).cmp(&rank(b)).then_with(|| a.cmp(b))
            });

            let opts = keys
                .iter()
                .map(|k| {
                    if let Some(v) = criteria.get(k) {
                        if !v.trim().is_empty() {
                            format!("{}: {}", k, v)
                        } else {
                            k.clone()
                        }
                    } else {
                        k.clone()
                    }
                })
                .collect();
            (keys, opts)
        }
        QType::Score => {
            let mut keys: Vec<String> = criteria.keys().cloned().collect();
            keys.sort();
            let opts = keys
                .iter()
                .map(|k| {
                    if let Some(v) = criteria.get(k) {
                        if !v.trim().is_empty() {
                            format!("{}: {}", k, v)
                        } else {
                            k.clone()
                        }
                    } else {
                        k.clone()
                    }
                })
                .collect();
            (keys, opts)
        }
        QType::Noul => {
            let keys = vec!["false".to_string(), "true".to_string()];
            let f_desc = criteria
                .get("false")
                .map(|s| s.as_str())
                .unwrap_or("no, the statement does not hold");
            let t_desc = criteria
                .get("true")
                .map(|s| s.as_str())
                .unwrap_or("yes, the statement holds");
            let opts = vec![format!("false: {}", f_desc), format!("true: {}", t_desc)];
            (keys, opts)
        }
    }
}

pub fn build_sequence(
    tokenizer: &LayaTokenizer,
    state: &Value,
    qtype: QType,
    instruction: &str,
    criteria: &HashMap<String, String>,
    max_len: usize,
    head_max_len: usize,
) -> Result<PreprocessedSequence> {
    let (option_keys, opts) = render_options(qtype, criteria);

    let scrubbed_ins = tokenizer.scrub(instruction);
    let head_text = format!("{} question: {}", qtype.as_str(), scrubbed_ins);
    let mut head_ids = tokenizer.encode_simple(&head_text)?;

    let mut opt_ids = Vec::with_capacity(opts.len());
    for opt in &opts {
        let scrubbed_opt = tokenizer.scrub(opt);
        let mut enc = tokenizer.encode_simple(&format!(" {}", scrubbed_opt))?;
        if enc.len() > 48 {
            enc.truncate(48);
        }
        let mut combined = Vec::with_capacity(1 + enc.len());
        combined.push(MASK_ID);
        combined.extend(enc);
        opt_ids.push(combined);
    }

    let total_opt_len: usize = opt_ids.iter().map(|o| o.len()).sum();
    let mut opt_budget = head_max_len.saturating_sub(total_opt_len);

    if opt_budget < 16 {
        let per = std::cmp::max(4, (head_max_len.saturating_sub(16)) / std::cmp::max(1, opt_ids.len()));
        for opt in &mut opt_ids {
            if opt.len() > per {
                opt.truncate(per);
            }
        }
        let new_total: usize = opt_ids.iter().map(|o| o.len()).sum();
        opt_budget = head_max_len.saturating_sub(new_total);
    }

    let head_limit = std::cmp::max(8, opt_budget);
    if head_ids.len() > head_limit {
        head_ids.truncate(head_limit);
    }

    let mut seq = Vec::with_capacity(max_len);
    seq.push(CLS_ID);
    seq.extend(head_ids);
    seq.push(SEP_ID);

    let mut markers = Vec::with_capacity(opt_ids.len());
    for opt in opt_ids {
        markers.push(seq.len() as i64);
        seq.extend(opt);
    }
    seq.push(SEP_ID);

    let serialized_state = match state {
        Value::String(s) => s.clone(),
        _ => serde_json::to_string(state).unwrap_or_else(|_| "{}".to_string()),
    };

    let scrubbed_state = tokenizer.scrub(&serialized_state);
    let state_ids = tokenizer.encode_simple(&scrubbed_state)?;

    let room = max_len.saturating_sub(seq.len() + 1);
    let is_truncated = state_ids.len() > room;

    let take_len = std::cmp::min(state_ids.len(), room);
    seq.extend_from_slice(&state_ids[..take_len]);
    seq.push(SEP_ID);

    if seq.len() > max_len {
        seq.truncate(max_len);
    }
    markers.retain(|&m| (m as usize) < max_len);

    let attention_mask = vec![1i64; seq.len()];
    let marker_mask = vec![true; markers.len()];

    Ok(PreprocessedSequence {
        input_ids: seq,
        attention_mask,
        marker_pos: markers,
        marker_mask,
        qtype: qtype.as_i64(),
        option_keys,
        is_truncated,
    })
}
