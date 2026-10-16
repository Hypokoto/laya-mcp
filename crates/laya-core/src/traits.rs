use crate::error::Result;
use crate::types::{DecisionRequest, DecisionResponse};

pub trait DecisionModel: Send + Sync {
    fn decide(&self, request: DecisionRequest) -> Result<DecisionResponse>;
}
