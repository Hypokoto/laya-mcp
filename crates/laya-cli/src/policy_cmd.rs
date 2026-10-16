use anyhow::Result;
use laya_core::policy::PolicyEngine;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use crate::paths::{get_laya_config_dir, resolve_default_paths};

pub fn run_policy_test(path: Option<PathBuf>) -> Result<()> {
    let ws = path.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let canonical_ws = fs::canonicalize(&ws).unwrap_or(ws.clone());

    println!("================================================================================");
    println!("🧪 LAYA POLICY CONFORMANCE & MONOTONICITY TEST");
    println!("================================================================================");
    println!("Workspace: {}", canonical_ws.display());

    let policy_path = if canonical_ws.is_file() {
        canonical_ws.clone()
    } else {
        canonical_ws.join(".laya").join("policy.toml")
    };

    if !policy_path.exists() {
        println!("❌ No project policy found at: {}", policy_path.display());
        println!("   Run 'laya init' to create a .laya/policy.toml template.");
        std::process::exit(1);
    }

    println!("Testing:   {}", policy_path.display());

    let global_config = get_laya_config_dir();
    let trust_file = global_config.join("trusted-manifests").join("trusted_projects.json");
    let is_trusted = is_project_trusted(&canonical_ws, &trust_file);

    println!("Trust:     {}", if is_trusted { "TRUSTED (Explicit user consent granted)" } else { "UNTRUSTED (Monotonic enforcement active)" });
    println!("--------------------------------------------------------------------------------");

    // Initialize policy engine with global policy
    let mut engine = PolicyEngine::new();
    let (_, _, _, global_rules_path) = resolve_default_paths(None, None, None, None);
    if let Some(ref grp) = global_rules_path {
        if grp.exists() {
            match engine.load_from_file(grp) {
                Ok(()) => println!("  [✓] Loaded base policy: {}", grp.display()),
                Err(e) => anyhow::bail!("Failed to load base policy {}: {}", grp.display(), e),
            }
        }
    }

    // Load project policy overrides
    let warnings = engine.load_project_override(&policy_path, is_trusted)?;
    if !warnings.is_empty() {
        println!("\n⚠️  MONOTONICITY RESTRICTIONS TRIGGERED:");
        for w in &warnings {
            println!("    - {}", w);
        }
        println!();
    } else {
        println!("  [✓] Project policy loaded without monotonicity violations.");
    }

    println!("\nRunning simulated decision scenarios:");

    // Scenario 1: Safe inspection
    let safe_args = json!({ "CommandLine": "git status" });
    let safe_res = engine.evaluate("run_command", &safe_args, Some(&canonical_ws));
    println!("  [1/4] Safe command ('git status'):");
    println!("        Verdict: {:?} (Expected: No local block)", safe_res);

    // Scenario 2: Tier 0 invariant
    let t0_args = json!({ "CommandLine": "rm -rf /" });
    let t0_res = laya_core::policy::check_tier0_invariants("run_command", &t0_args);
    anyhow::ensure!(t0_res.is_some(), "Tier 0 invariant failed to intercept catastrophic command");
    println!("  [2/4] Catastrophic sweep ('rm -rf /'):");
    println!("        Verdict: DENY (Tier 0 Hard Invariant enforced, non-bypassable)");

    // Scenario 3: Protected secret access
    let secret_args = json!({ "filepath": ".env.production" });
    let secret_res = engine.evaluate("write_file", &secret_args, Some(&canonical_ws));
    println!("  [3/4] Protected secret mutation ('.env.production'):");
    println!("        Verdict: {:?} (Expected: Project DENY rule)", secret_res);

    // Scenario 4: Sensitive publish command
    let pub_args = json!({ "CommandLine": "cargo publish" });
    let pub_res = engine.evaluate("run_command", &pub_args, Some(&canonical_ws));
    println!("  [4/4] Sensitive operation ('cargo publish'):");
    println!("        Verdict: {:?} (Expected: REQUIRE_AUTHORIZATION)", pub_res);

    println!("\n================================================================================");
    println!("✓ POLICY TEST PASSED: Rules parsed and evaluated successfully.");
    println!("================================================================================");
    Ok(())
}

pub fn run_policy_trust(path: Option<PathBuf>) -> Result<()> {
    let ws = path.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let canonical_ws = fs::canonicalize(&ws).unwrap_or(ws.clone());

    println!("================================================================================");
    println!("🔐 LAYA POLICY TRUST AUTHORIZATION");
    println!("================================================================================");
    let (target_ws, policy_path) = if canonical_ws.is_file() {
        let p_name = canonical_ws.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if p_name.starts_with("policy.") || p_name.ends_with(".json") || p_name.ends_with(".toml") {
            let parent = canonical_ws.parent().unwrap_or(&canonical_ws);
            let ws_dir = if parent.file_name().and_then(|s| s.to_str()) == Some(".laya") {
                parent.parent().unwrap_or(parent).to_path_buf()
            } else {
                parent.to_path_buf()
            };
            (ws_dir, canonical_ws.clone())
        } else {
            anyhow::bail!("Path '{}' identifies a file, but 'laya policy trust' must be keyed to a workspace directory.", canonical_ws.display());
        }
    } else {
        let p = canonical_ws.join(".laya").join("policy.toml");
        (canonical_ws.clone(), p)
    };

    println!("Workspace: {}", target_ws.display());
    println!("Policy:    {}", policy_path.display());

    if !policy_path.exists() {
        eprintln!("Error: No policy file found at {}", policy_path.display());
        std::process::exit(1);
    }

    let content = fs::read_to_string(&policy_path)?;
    let digest = hex::encode(Sha256::digest(content.as_bytes()));
    println!("Policy SHA-256: {}", digest);

    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        anyhow::bail!("Refusing to grant trust: 'laya policy trust' requires an interactive terminal (TTY) for human verification to prevent automated self-authorization.");
    }

    let raw_rules: Vec<serde_json::Value> = if policy_path.extension().and_then(|s| s.to_str()) == Some("toml") {
        let val: toml::Value = toml::from_str(&content)
            .map_err(|e| anyhow::anyhow!("Failed to parse policy TOML: {}", e))?;
        val.get("rules")
            .and_then(|r| r.as_array())
            .map(|arr| arr.iter().map(|v| serde_json::to_value(v).unwrap_or_default()).collect())
            .unwrap_or_default()
    } else {
        serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|v| {
                if let Some(arr) = v.as_array() {
                    Some(arr.clone())
                } else {
                    v.get("rules").and_then(|r| r.as_array().cloned())
                }
            })
            .unwrap_or_default()
    };

    let allow_rules: Vec<&serde_json::Value> = raw_rules
        .iter()
        .filter(|r| r.get("action").and_then(|a| a.as_str()).map(|s| s.trim().eq_ignore_ascii_case("ALLOW")).unwrap_or(false))
        .collect();

    if allow_rules.is_empty() {
        println!("Policy contains no custom ALLOW rules. Trusting this project will not grant additional execution privileges.");
    } else {
        println!("\n⚠️  THE FOLLOWING CUSTOM ALLOW RULES WILL BE AUTHORIZED:");
        for r in &allow_rules {
            let name = r.get("name").or_else(|| r.get("id")).and_then(|n| n.as_str()).unwrap_or("<unnamed>");
            let tool = r.get("tool").or_else(|| r.get("toolPattern")).and_then(|t| t.as_str()).unwrap_or("*");
            let cmd = r.get("commandPattern").or_else(|| r.get("command_pattern")).and_then(|p| p.as_str()).unwrap_or("*");
            let path = r.get("pathPattern").or_else(|| r.get("path_pattern")).and_then(|p| p.as_str()).unwrap_or("*");
            println!("    - [{}] tool: '{}', command: '{}', path: '{}'", name, tool, cmd, path);
        }
    }

    use std::io::{stdin, stdout, Write};
    print!("\nDo you explicitly trust this repository to execute these actions without confirmation? [y/N]: ");
    stdout().flush()?;
    let mut response = String::new();
    stdin().read_line(&mut response)?;
    let trimmed = response.trim();
    if !trimmed.eq_ignore_ascii_case("y") && !trimmed.eq_ignore_ascii_case("yes") {
        anyhow::bail!("Policy trust authorization was aborted by user.");
    }

    let global_config = get_laya_config_dir();
    let manifests_dir = global_config.join("trusted-manifests");
    fs::create_dir_all(&manifests_dir)?;
    let trust_file = manifests_dir.join("trusted_projects.json");

    let mut entries: Vec<serde_json::Value> = if trust_file.exists() {
        let prev = fs::read_to_string(&trust_file)?;
        serde_json::from_str(&prev)
            .map_err(|e| anyhow::anyhow!("Corrupt trust registry {}: {}", trust_file.display(), e))?
    } else {
        Vec::new()
    };

    let ws_str = target_ws.to_string_lossy().to_string();
    entries.retain(|e| e.get("path").and_then(|p| p.as_str()) != Some(&ws_str));

    entries.push(json!({
        "path": ws_str,
        "policy_sha256": digest,
        "trusted_at": chrono_now_iso(),
    }));

    let tmp = trust_file.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&entries)?)?;
    fs::rename(&tmp, &trust_file)?;

    println!("\n🎉 PROJECT POLICY TRUST RECORDED!");
    println!("Workspace '{}' is now trusted to declare custom ALLOW rules.", target_ws.display());
    println!("Trust registry: {}", trust_file.display());
    println!("================================================================================");
    Ok(())
}

pub(crate) fn verify_and_read_project_policy(
    workspace: &Path,
    trust_file: &Path,
) -> Option<(String, bool, PathBuf)> {
    let canon = fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    let (target_ws, policy_path) = if canon.is_file() {
        let parent = canon.parent().unwrap_or(&canon);
        let ws = if parent.file_name().and_then(|s| s.to_str()) == Some(".laya") {
            parent.parent().unwrap_or(parent).to_path_buf()
        } else {
            parent.to_path_buf()
        };
        (ws, canon.clone())
    } else {
        let p = canon.join(".laya").join("policy.toml");
        (canon.clone(), p)
    };

    if !policy_path.exists() {
        return None;
    }
    let content = match fs::read_to_string(&policy_path) {
        Ok(c) => c,
        Err(_) => return None,
    };
    let current_digest = hex::encode(Sha256::digest(content.as_bytes()));

    let mut is_trusted = false;
    if trust_file.exists() {
        if let Ok(trust_content) = fs::read_to_string(trust_file) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&trust_content) {
                let ws_str = target_ws.to_string_lossy();
                if let Some(arr) = json.as_array() {
                    for entry in arr {
                        let matches_path = entry.get("path").and_then(|p| p.as_str()) == Some(&ws_str);
                        let matches_hash = entry.get("policy_sha256").and_then(|h| h.as_str()) == Some(&current_digest);
                        if matches_path && matches_hash {
                            is_trusted = true;
                            break;
                        }
                    }
                }
            }
        }
    }
    Some((content, is_trusted, policy_path))
}

pub(crate) fn is_project_trusted(workspace: &Path, trust_file: &Path) -> bool {
    verify_and_read_project_policy(workspace, trust_file)
        .map(|(_, trusted, _)| trusted)
        .unwrap_or(false)
}

fn chrono_now_iso() -> String {
    let now = std::time::SystemTime::now();
    let secs = now.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{}-unix", secs)
}
