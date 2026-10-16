use std::path::PathBuf;

pub fn get_laya_config_dir() -> PathBuf {
    if let Ok(c) = std::env::var("LAYA_CONFIG_DIR") {
        PathBuf::from(c)
    } else if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        PathBuf::from(home).join(".config").join("laya")
    } else {
        PathBuf::from(".config").join("laya")
    }
}

pub fn get_laya_state_dir() -> PathBuf {
    if let Ok(s) = std::env::var("LAYA_STATE_DIR") {
        PathBuf::from(s)
    } else if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        PathBuf::from(home).join(".local").join("state").join("laya")
    } else {
        PathBuf::from(".local").join("state").join("laya")
    }
}

pub fn get_laya_models_dir() -> PathBuf {
    get_laya_config_dir().join("models")
}

pub fn get_laya_socket_path() -> PathBuf {
    get_laya_state_dir().join("laya.sock")
}

pub fn resolve_default_paths(
    cli_model: Option<PathBuf>,
    cli_tokenizer: Option<PathBuf>,
    cli_config: Option<PathBuf>,
    cli_rules: Option<PathBuf>,
) -> (PathBuf, PathBuf, Option<PathBuf>, Option<PathBuf>) {
    // Never trust artifacts in the current working directory implicitly.
    // Repo-relative paths are only resolved if LAYA_HOME is explicitly configured.
    let repo_root: Option<PathBuf> = std::env::var("LAYA_HOME").ok().map(PathBuf::from);
    let global_config_dir = get_laya_config_dir();
    let global_models_dir = get_laya_models_dir();

    let model_path = cli_model.unwrap_or_else(|| {
        if let Some(ref root) = repo_root {
            let local_int8 = root.join("laya_int8.onnx");
            if local_int8.exists() {
                return local_int8;
            }
            let local_fp32 = root.join("laya.onnx");
            if local_fp32.exists() {
                return local_fp32;
            }
        }
        let global_int8 = global_models_dir.join("laya_int8.onnx");
        if global_int8.exists() {
            return global_int8;
        }
        let global_fp32 = global_models_dir.join("laya.onnx");
        if global_fp32.exists() {
            return global_fp32;
        }
        global_models_dir.join("laya_int8.onnx")
    });

    let tokenizer_path = cli_tokenizer.unwrap_or_else(|| {
        if let Some(ref root) = repo_root {
            let local_tok = root.join("tokenizer").join("tokenizer.json");
            if local_tok.exists() {
                return local_tok;
            }
            let local_tok_root = root.join("tokenizer.json");
            if local_tok_root.exists() {
                return local_tok_root;
            }
        }
        let global_tok = global_models_dir.join("tokenizer").join("tokenizer.json");
        if global_tok.exists() {
            return global_tok;
        }
        let global_tok_root = global_models_dir.join("tokenizer.json");
        if global_tok_root.exists() {
            return global_tok_root;
        }
        global_models_dir.join("tokenizer").join("tokenizer.json")
    });

    let config_path = cli_config.or_else(|| {
        if let Some(ref root) = repo_root {
            let local_config = root.join("laya_config.json");
            if local_config.exists() {
                return Some(local_config);
            }
        }
        let global_json = global_config_dir.join("laya_config.json");
        if global_json.exists() {
            return Some(global_json);
        }
        None
    });

    let rules_path = cli_rules.or_else(|| {
        // 1. Explicit LAYA_HOME repo rules
        if let Some(ref root) = repo_root {
            let local_rules = root.join("laya_rules.json");
            if local_rules.exists() {
                return Some(local_rules);
            }
        }
        // 2. Global policy (~/.config/laya/policy/global.toml)
        let global_policy = global_config_dir.join("policy").join("global.toml");
        if global_policy.exists() {
            return Some(global_policy);
        }
        // 3. Global model rules (~/.config/laya/models/laya_rules.json)
        let global_rules = global_models_dir.join("laya_rules.json");
        if global_rules.exists() {
            return Some(global_rules);
        }
        None
    });

    (model_path, tokenizer_path, config_path, rules_path)
}

