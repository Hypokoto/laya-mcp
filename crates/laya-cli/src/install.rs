use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;
use crate::paths::{get_laya_config_dir, get_laya_models_dir, get_laya_state_dir};

pub fn run_install(bin_dir: Option<PathBuf>, force: bool) -> Result<()> {
    println!("================================================================================");
    println!("📦 LAYA GLOBAL POLICY SERVICE INSTALLER");
    println!("================================================================================");

    let config_dir = get_laya_config_dir();
    let models_dir = get_laya_models_dir();
    let state_dir = get_laya_state_dir();
    let policy_dir = config_dir.join("policy");
    let manifests_dir = config_dir.join("trusted-manifests");

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .context("Cannot determine user home directory: neither HOME nor USERPROFILE environment variable is set")?;
    let target_bin_dir = bin_dir.unwrap_or_else(|| home.join(".local").join("bin"));

    // 1. Create directory structures
    println!("\n[1/5] Creating global user directories...");
    for dir in [&config_dir, &models_dir, &policy_dir, &manifests_dir, &state_dir, &target_bin_dir] {
        if !dir.exists() {
            fs::create_dir_all(dir).with_context(|| format!("Failed to create directory {}", dir.display()))?;
            println!("  [+] Created: {}", dir.display());
        } else {
            println!("  [✓] Exists:  {}", dir.display());
        }
    }

    // 2. Locate source repository artifacts
    println!("\n[2/5] Locating and provisioning model artifacts into ~/.config/laya/models/...");
    let repo_candidates: Vec<PathBuf> = std::env::var("LAYA_HOME")
        .ok()
        .map(PathBuf::from)
        .into_iter()
        .chain(std::env::current_dir().ok().into_iter())
        .chain(std::env::current_exe().ok().into_iter().flat_map(|p| {
            p.ancestors().skip(1).take(3).map(|a| a.to_path_buf()).collect::<Vec<_>>()
        }))
        .collect();

    let mut repo_root: Option<PathBuf> = None;
    for cand in &repo_candidates {
        if cand.join("laya_int8.onnx").exists() || cand.join("laya.onnx").exists() {
            repo_root = Some(cand.clone());
            break;
        }
    }

    if let Some(ref root) = repo_root {
        println!("  Found source artifacts at: {}", root.display());
        let artifacts = [
            "laya_int8.onnx",
            "laya.onnx",
            "laya.onnx.data",
            "laya_config.json",
            "laya_rules.json",
        ];

        for art in artifacts {
            let src = root.join(art);
            let dst = models_dir.join(art);
            if src.exists() {
                let dst_present = dst.symlink_metadata().is_ok();
                if dst_present && force {
                    if dst.is_dir() && !dst.is_symlink() {
                        fs::remove_dir_all(&dst)
                            .with_context(|| format!("Failed to remove directory {}", dst.display()))?;
                    } else {
                        fs::remove_file(&dst)
                            .with_context(|| format!("Failed to remove {}", dst.display()))?;
                    }
                }
                if dst.symlink_metadata().is_err() {
                    fs::copy(&src, &dst)
                        .with_context(|| format!("Failed to copy {} -> {}", src.display(), dst.display()))?;
                    println!("  [✓] Copied:    {} -> {}", art, dst.display());
                } else {
                    println!("  [✓] Exists:    {}", dst.display());
                }
            }
        }

        // Tokenizer directory
        let tok_src = root.join("tokenizer");
        let tok_dst = models_dir.join("tokenizer");
        if tok_src.exists() {
            let tok_present = tok_dst.symlink_metadata().is_ok();
            if tok_present && force {
                if tok_dst.is_dir() && !tok_dst.is_symlink() {
                    let _ = fs::remove_dir_all(&tok_dst);
                } else {
                    let _ = fs::remove_file(&tok_dst);
                }
            }
            if tok_dst.symlink_metadata().is_err() {
                let _ = fs::create_dir_all(&tok_dst);
                if tok_src.is_dir() {
                    if let Ok(entries) = fs::read_dir(&tok_src) {
                        for entry in entries.flatten() {
                            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                                let _ = fs::copy(entry.path(), tok_dst.join(entry.file_name()));
                            }
                        }
                    }
                } else {
                    let _ = fs::copy(&tok_src, tok_dst.join("tokenizer.json"));
                }
                println!("  [✓] Copied tokenizer: {}", tok_dst.display());
            }
        }

        // Manifest
        let man_src = root.join("model_manifest.json");
        let man_dst = manifests_dir.join("model_manifest.json");
        if man_src.exists() && (!man_dst.exists() || force) {
            let _ = fs::copy(&man_src, &man_dst);
            println!("  [✓] Provisioned manifest: {}", man_dst.display());
        }
    } else {
        println!("  [!] No local model files found in repository candidates.");
        println!("      Models can be fetched from Hugging Face: receptron/laya-onnx");
    }

    // 3. Install binary to target_bin_dir
    println!("\n[3/5] Installing 'laya' binary to {}...", target_bin_dir.display());
    let current_exe = std::env::current_exe()?;
    let target_bin = target_bin_dir.join("laya");
    let same_file = match (fs::canonicalize(&current_exe), fs::canonicalize(&target_bin)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same_file && (!target_bin.exists() || force) {
        let tmp = target_bin.with_extension("tmp");
        fs::copy(&current_exe, &tmp)
            .with_context(|| format!("Failed to copy binary {} to {}", current_exe.display(), target_bin.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&tmp) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&tmp, perms);
            }
        }
        fs::rename(&tmp, &target_bin)
            .with_context(|| format!("Failed to atomically replace {}", target_bin.display()))?;
        println!("  [✓] Successfully installed binary to {}", target_bin.display());
    } else {
        println!("  [✓] Binary already installed at {}", target_bin.display());
    }

    // 4. Provision default global configurations
    println!("\n[4/5] Provisioning global user policy...");
    let global_config_file = config_dir.join("config.toml");
    if !global_config_file.exists() {
        let default_cfg = r#"# Laya Global Configuration
[daemon]
port = 8000
host = "127.0.0.1"
socket_path = "~/.local/state/laya/laya.sock"
threads = 4

[thresholds]
shell_allow_min = 0.80
file_allow_min = 0.70
default_allow_min = 0.65
"#;
        fs::write(&global_config_file, default_cfg)?;
        println!("  [+] Generated: {}", global_config_file.display());
    } else {
        println!("  [✓] Exists:    {}", global_config_file.display());
    }

    let global_policy_file = policy_dir.join("global.toml");
    if global_policy_file.exists() && force {
        let backup = global_policy_file.with_extension("toml.bak");
        fs::copy(&global_policy_file, &backup)
            .with_context(|| format!("Failed to back up {}", global_policy_file.display()))?;
        println!("  [✓] Backed up existing policy to {}", backup.display());
    }
    if !global_policy_file.exists() || force {
        let default_policy = r#"# Laya Global Policy Rules
version = "1.0"
name = "global-default"

[[rules]]
name = "allow-git-queries"
action = "ALLOW"
commandPattern = "^git[ \\t]+(status|diff|log|show)([ \\t]+[^;&|`$()<>\r\n]*)?$"

[[rules]]
name = "allow-git-branch-queries"
action = "ALLOW"
commandPattern = "^git[ \\t]+branch([ \\t]+(-[alr]+|--list|--show-current|--all|--remotes))?$"

[[rules]]
name = "allow-workspace-reads"
action = "ALLOW"
toolPattern = "^(view_file|read_file|laya_read_file|read_files|laya_read_files|Read|Grep|Glob|LS|search_files|list_dir|listdir|ls)$"
pathPattern = ".*"

[[rules]]
name = "block-git-sensitive-paths"
action = "DENY"
commandPattern = "^git\\s+.*(\\.env\\.production|prod\\.secrets|id_rsa|id_ed25519|\\.ssh/|\\.aws/|/etc/shadow|/etc/passwd).*"

[[rules]]
name = "block-git-file-overwrite"
action = "DENY"
commandPattern = "^git\\s+.*(--output|-o\\s).*"

[[rules]]
name = "require-auth-git-diff-external"
action = "REQUIRE_AUTHORIZATION"
commandPattern = "^git[ \\t]+diff\\b.*(--no-index|[ \\t][/~]|[ \\t]\\.\\./).*"

[[rules]]
name = "block-git-branch-mutation"
action = "REQUIRE_AUTHORIZATION"
commandPattern = "^git\\s+branch\\s+.*(-[dDfmM]|--delete|--set-upstream-to).*"

[[rules]]
name = "block-credential-theft"
action = "DENY"
commandPattern = "cat\\s+.*(\\.ssh/|id_rsa|\\.aws/credentials|id_ed25519)"

[[rules]]
name = "protect-sensitive-env"
action = "DENY"
pathPattern = ".*(\\.env\\.production|prod\\.secrets|id_rsa|id_ed25519|\\.ssh/|\\.aws/|credentials).*"

[[rules]]
name = "sensitive-system-commands"
action = "REQUIRE_AUTHORIZATION"
commandPattern = "(sudo|su|systemctl|journalctl)\\b"

[[rules]]
name = "require-auth-deploy"
action = "REQUIRE_AUTHORIZATION"
commandPattern = ".*(kubectl|docker\\s+push|helm|terraform).*"
"#;
        fs::write(&global_policy_file, default_policy)?;
        println!("  [+] Generated: {}", global_policy_file.display());
    } else {
        println!("  [✓] Exists:    {}", global_policy_file.display());
    }

    // 5. Check and configure host integrations
    println!("\n[5/5] Host coding tool hook adapters");
    let adapters_dst = config_dir.join("adapters");
    let _ = fs::create_dir_all(&adapters_dst);
    if let Some(ref root) = repo_root {
        let adapters_src = root.join("adapters");
        if adapters_src.exists() {
            let _ = fs::create_dir_all(adapters_dst.join("common"));
            let _ = fs::copy(adapters_src.join("common").join("laya_client.js"), adapters_dst.join("common").join("laya_client.js"));

            let _ = fs::create_dir_all(adapters_dst.join("antigravity"));
            let _ = fs::copy(adapters_src.join("antigravity").join("hook.js"), adapters_dst.join("antigravity").join("hook.js"));

            let _ = fs::create_dir_all(adapters_dst.join("claude-code"));
            let _ = fs::copy(adapters_src.join("claude-code").join("hook.js"), adapters_dst.join("claude-code").join("hook.js"));

            let _ = fs::create_dir_all(adapters_dst.join("cursor"));
            let _ = fs::copy(adapters_src.join("cursor").join("hook.js"), adapters_dst.join("cursor").join("hook.js"));

            let laya_run_src = adapters_src.join("generic-cli").join("laya-run");
            let laya_run_dst = target_bin_dir.join("laya-run");
            if laya_run_src.exists() {
                let _ = fs::copy(&laya_run_src, &laya_run_dst);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&laya_run_dst, fs::Permissions::from_mode(0o755));
                }
                println!("  [✓] Installed CLI wrapper: {}", laya_run_dst.display());
            }

            println!("  [✓] Provisioned universal adapters: {}", adapters_dst.display());
        }
    }

    let ag_dir = home.join(".gemini").join("antigravity-cli");
    if ag_dir.exists() {
        let hooks_dir = ag_dir.join("hooks");
        let _ = fs::create_dir_all(&hooks_dir);
        let dst_hook = hooks_dir.join("laya-pretool-hook.js");
        let target_hook = adapters_dst.join("antigravity").join("hook.js");
        let wrapper_content = format!(
            "#!/usr/bin/env node\n// Auto-generated Laya Antigravity Hook Loader\nrequire('{}');\n",
            target_hook.display()
        );
        if !dst_hook.exists() || force {
            let _ = fs::write(&dst_hook, wrapper_content);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&dst_hook, fs::Permissions::from_mode(0o755));
            }
            println!("  [✓] Configured Antigravity hook adapter at {}", dst_hook.display());
        }
    }

    println!("\n================================================================================");
    println!("🎉 LAYA INSTALLATION COMPLETE!");
    println!("Make sure '{}' is in your system PATH (e.g. export PATH=\"$HOME/.local/bin:$PATH\").", target_bin_dir.display());
    println!("Run 'laya doctor' to verify runtime status.");
    println!("================================================================================");
    Ok(())
}
