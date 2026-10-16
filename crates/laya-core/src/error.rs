use thiserror::Error;

#[derive(Error, Debug)]
pub enum LayaError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Tokenizer error: {0}")]
    Tokenizer(String),

    #[error("ONNX Runtime error: {0}")]
    Onnx(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Internal engine error: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, LayaError>;
