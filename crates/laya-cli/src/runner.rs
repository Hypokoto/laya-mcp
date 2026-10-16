use anyhow::{Context, Result};
use laya_core::types::DecisionRequest;
use laya_onnx::LayaEngine;
use serde_json::json;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use crate::paths::resolve_default_paths;

pub fn run_command_runner(
    command_tokens: Vec<String>,
    isolated: bool,
    model: Option<PathBuf>,
    tokenizer: Option<PathBuf>,
    config: Option<PathBuf>,
    rules: Option<PathBuf>,
    threads: usize,
) -> Result<()> {
    if command_tokens.is_empty() {
        eprintln!("Error: No command specified to run.");
        std::process::exit(1);
    }

    let full_command = shlex::try_join(command_tokens.iter().map(|s| s.as_str()))
        .unwrap_or_else(|_| command_tokens.join(" "));
    let (model_path, tokenizer_path, config_path, rules_path) =
        resolve_default_paths(model, tokenizer, config, rules);

    let engine = LayaEngine::load(
        &model_path,
        &tokenizer_path,
        config_path.as_deref(),
        rules_path.as_deref(),
        threads,
    )?;

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let canonical_cwd = std::fs::canonicalize(&cwd).unwrap_or_else(|_| cwd.clone());
    let mut policy = engine.get_policy_clone();

    let global_config = crate::paths::get_laya_config_dir();
    let trust_file = global_config.join("trusted-manifests").join("trusted_projects.json");

    if let Some((content, is_trusted, policy_path)) = crate::policy_cmd::verify_and_read_project_policy(&canonical_cwd, &trust_file) {
        let is_toml = policy_path.extension().and_then(|s| s.to_str()) == Some("toml");
        match policy.load_project_override_str(&content, is_toml, is_trusted) {
            Ok(warnings) => {
                for w in warnings {
                    eprintln!("[LAYA POLICY WARNING] {}", w);
                }
            }
            Err(err) => {
                eprintln!("[LAYA POLICY ERROR] Failed to load project policy '{}': {}", policy_path.display(), err);
                anyhow::bail!("Refusing command execution: project policy '{}' failed to load: {}", policy_path.display(), err);
            }
        }
    }

    let mut req = DecisionRequest::new("run_command", json!({ "command": &full_command }));
    req.workspace = Some(canonical_cwd.to_string_lossy().to_string());
    req.operation = Some("execute".to_string());

    let res = engine.decide_with_policy(&req, &policy, Some(&canonical_cwd))?;

    match res.decision.as_str() {
        "ALLOW" => {
            execute_command(&command_tokens, isolated)?;
        }
        "REQUIRE_AUTHORIZATION" => {
            eprintln!("================================================================================");
            eprintln!("⚠️  LAYA ENFORCEMENT: Command Requires Interactive Authorization");
            eprintln!("================================================================================");
            eprintln!("Command: {}", full_command);
            if let Some(ref r) = res.reasoning {
                eprintln!("Reason:  {}", r);
            }
            if let Some(ref cat) = res.risk_category {
                eprintln!("Risk:    {}", cat);
            }
            eprintln!("Tier:    {}", res.tier.as_deref().unwrap_or("unknown"));
            eprintln!("--------------------------------------------------------------------------------");
            eprint!("Authorize and execute this command? [y/N]: ");
            io::stderr().flush()?;

            use std::io::IsTerminal;
            if !io::stdin().is_terminal() {
                eprintln!("❌ Refusing authorization: interactive terminal (TTY) required.");
                std::process::exit(126);
            }

            let mut input = String::new();
            io::stdin().read_line(&mut input)?;
            let trimmed = input.trim().to_lowercase();

            if trimmed == "y" || trimmed == "yes" {
                eprintln!("✓ Authorization granted by user. Executing...\n");
                execute_command(&command_tokens, isolated)?;
            } else {
                eprintln!("❌ Execution cancelled by user authorization prompt.");
                std::process::exit(126);
            }
        }
        "DENY" => {
            eprintln!("================================================================================");
            eprintln!("🚫 LAYA ENFORCEMENT BLOCKED: Command Denied by Policy Engine");
            eprintln!("================================================================================");
            eprintln!("Command: {}", full_command);
            eprintln!("Rule:    {}", res.matched_rule.as_deref().unwrap_or("hard_security_boundary"));
            eprintln!("Tier:    {}", res.tier.as_deref().unwrap_or("unknown"));
            if let Some(ref r) = res.reasoning {
                eprintln!("Reason:  {}", r);
            }
            eprintln!("================================================================================");
            std::process::exit(1);
        }
        other => {
            eprintln!("Unknown decision verdict: {}. Refusing execution.", other);
            std::process::exit(1);
        }
    }

    Ok(())
}

fn execute_command(tokens: &[String], isolated: bool) -> Result<()> {
    let mut cmd = if isolated {
        if !which_exists("bwrap") {
            anyhow::bail!("Sandboxed execution failed: '--isolated' was requested, but bubblewrap (bwrap) was not found on PATH. Install bubblewrap or run without '--isolated'.");
        }
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let mut bwrap = Command::new("bwrap");
        bwrap.arg("--ro-bind").arg("/").arg("/")
            .arg("--dev").arg("/dev")
            .arg("--proc").arg("/proc")
            .arg("--bind").arg(&cwd).arg(&cwd)
            .arg("--chdir").arg(&cwd)
            .arg("--")
            .args(tokens);
        bwrap
    } else {
        // Pre-authorized by Laya policy evaluation; executed with discrete argv tokens without shell interpolation
        // nosemgrep: rust.actix.command-injection.rust-actix-command-injection.rust-actix-command-injection
        let mut direct = Command::new(&tokens[0]);
        direct.args(&tokens[1..]);
        direct
    };

    cmd.stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let status = cmd.status().with_context(|| format!("Failed to spawn command '{}'", tokens[0]))?;
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
    Ok(())
}

fn which_exists(binary: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        for p in path_var.split(':') {
            let full = PathBuf::from(p).join(binary);
            if full.is_file() {
                return true;
            }
        }
    }
    false
}
