use laya_core::error::{LayaError, Result};
use std::path::Path;
use tokenizers::Tokenizer;

pub const CLS_ID: i64 = 50281;
pub const SEP_ID: i64 = 50282;
pub const PAD_ID: i64 = 50283;
pub const MASK_ID: i64 = 50284;
pub const UNK_ID: i64 = 50280;

pub struct LayaTokenizer {
    inner: Tokenizer,
}

impl LayaTokenizer {
    pub fn from_file<P: AsRef<Path>>(path: P) -> Result<Self> {
        let inner = Tokenizer::from_file(path)
            .map_err(|e| LayaError::Tokenizer(format!("Failed to load tokenizer from file: {}", e)))?;
        Ok(Self { inner })
    }

    pub fn encode_simple(&self, text: &str) -> Result<Vec<i64>> {
        let encoding = self
            .inner
            .encode(text, false)
            .map_err(|e| LayaError::Tokenizer(format!("Encoding error: {}", e)))?;

        Ok(encoding.get_ids().iter().map(|&id| id as i64).collect())
    }

    pub fn scrub(&self, input: &str) -> String {
        let mut text = input.to_string();
        for sp in &["[CLS]", "[SEP]", "[MASK]", "[PAD]", "[UNK]"] {
            if text.contains(sp) {
                text = text.replace(sp, " ");
            }
        }
        text
    }
}
