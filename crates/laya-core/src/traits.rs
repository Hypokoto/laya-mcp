use crate::error::Result;
use crate::types::{DecisionRequest, DecisionResponse};

/// Core trait representing neural or deterministic decision-making models.
pub trait DecisionModel: Send + Sync {
    fn decide(&self, request: DecisionRequest) -> Result<DecisionResponse>;
}

/// Abstract transport layer interface (UDS, Windows named pipes, authenticated loopback HTTP).
pub trait PolicyTransport: Send + Sync {
    fn transport_name(&self) -> &'static str;
}

/// Host-specific approval prompt provider (interactive TTY, IDE modal, non-interactive deny).
pub trait ApprovalProvider: Send + Sync {
    fn provider_name(&self) -> &'static str;
    fn prompt_approval(&self, request: &DecisionRequest, response: &DecisionResponse) -> Result<bool>;
}

/// Isolated execution backend (direct process, Bubblewrap / platform sandbox, host-mediated execution).
pub trait ExecutionBackend: Send + Sync {
    fn backend_name(&self) -> &'static str;
    fn execute(&self, command_tokens: &[String], isolated: bool) -> Result<i32>;
}

/// Abstract runtime evaluating policy requests with calibrated scoring or deterministic matching.
pub trait ModelRuntime: Send + Sync {
    fn runtime_name(&self) -> &'static str;
    fn evaluate(&self, request: &DecisionRequest) -> Result<DecisionResponse>;
}
