use anyhow::Result;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use crate::paths::{get_laya_config_dir, get_laya_models_dir, get_laya_socket_path, get_laya_state_dir, resolve_default_paths};
use crate::policy_cmd::is_project_trusted;

pub async fn run_doctor() -> Result<()> {
    println!("================================================================================");
    println!("🩺 LAYA POLICY ENGINE & ENVIRONMENT DOCTOR");
    println!("================================================================================");

    // 1. CLI Binary
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("laya"));
    println!("\n[1] Laya Binary & Execution Context");
    println!("    Executable: {}", exe.display());
    println!("    Version:    v{}", env!("CARGO_PKG_VERSION"));
    println!("    Platform:   {} ({})", std::env::consts::OS, std::env::consts::ARCH);

    // 2. Paths Resolution
    let (model_path, tokenizer_path, config_path, rules_path) = resolve_default_paths(None, None, None, None);
    println!("\n[2] Model & Artifacts Status");
    check_artifact_file("Resolved Model", &model_path);
    check_artifact_file("Tokenizer", &tokenizer_path);
    if let Some(ref cp) = config_path {
        check_artifact_file("Engine Config", cp);
    } else {
        println!("    [!] Engine Config: None detected (using built-in defaults)");
    }
    if let Some(ref rp) = rules_path {
        check_artifact_file("Active Policy", rp);
    } else {
        println!("    [!] Active Policy: None detected (Tier 0 invariants always active)");
    }

    // Check manifest
    let manifest_path = if Path::new("model_manifest.json").exists() {
        PathBuf::from("model_manifest.json")
    } else {
        get_laya_config_dir().join("trusted-manifests").join("model_manifest.json")
    };
    if manifest_path.exists() {
        if let Ok(content) = fs::read_to_string(&manifest_path) {
            let digest = hex::encode(Sha256::digest(content.as_bytes()));
            println!("    [✓] Artifact Manifest: {} (SHA-256: {}...)", manifest_path.display(), &digest[..16]);
        }
    } else {
        println!("    [!] Artifact Manifest: Missing at {}", manifest_path.display());
    }

    // 3. Global Configuration Directory
    println!("\n[3] Global User Configuration (~/.config/laya/)");
    let global_config = get_laya_config_dir();
    let global_models = get_laya_models_dir();
    let global_state = get_laya_state_dir();

    println!("    Config Dir:  {} ({})", global_config.display(), if global_config.exists() { "Created" } else { "Missing - run 'laya install'" });
    println!("    Models Dir:  {} ({})", global_models.display(), if global_models.exists() { "Created" } else { "Missing - run 'laya install'" });
    println!("    State Dir:   {} ({})", global_state.display(), if global_state.exists() { "Created" } else { "Missing" });

    // 4. Current Workspace Context
    println!("\n[4] Project Workspace & Policy Overrides");
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    println!("    Working Dir: {}", cwd.display());
    let prj_policy = cwd.join(".laya").join("policy.toml");
    if prj_policy.exists() {
        println!("    [✓] Project Policy: Detected at {}", prj_policy.display());
        // Check trust status
        let trust_file = global_config.join("trusted-manifests").join("trusted_projects.json");
        let is_trusted = is_project_trusted(&cwd, &trust_file);
        if is_trusted {
            println!("    [✓] Trust Status:   TRUSTED (Permitted to declare custom allow rules)");
        } else {
            println!("    [!] Trust Status:   UNTRUSTED (Monotonic mode: ALLOW rules rejected; run 'laya policy trust')");
        }
    } else {
        println!("    [-] Project Policy: None in current workspace (run 'laya init' to create .laya/policy.toml)");
    }

    // 5. Runtime Daemon & IPC Connectivity
    println!("\n[5] Runtime Service & IPC Sockets");
    let sock_path = get_laya_socket_path();
    if sock_path.exists() {
        println!("    [✓] Unix Socket:    {} (Active)", sock_path.display());
    } else {
        println!("    [-] Unix Socket:    {} (Offline / Not running)", sock_path.display());
    }

    // TCP Health Probe
    let tcp_healthy = probe_tcp_health("127.0.0.1", 8000).await;
    if tcp_healthy {
        println!("    [✓] HTTP Daemon:    http://127.0.0.1:8000/health (Healthy)");
    } else {
        println!("    [-] HTTP Daemon:    http://127.0.0.1:8000 (Offline - hybrid auto-spawn active)");
    }

    // 6. Host Integrations Discovery
    println!("\n[6] Host Coding Tool Integrations");
    check_host_antigravity();
    check_host_claude_code();
    check_host_cursor();

    println!("\n================================================================================");
    println!("Doctor diagnosis complete. To provision global paths: 'laya install'.");
    println!("================================================================================");
    Ok(())
}

fn check_artifact_file(label: &str, path: &Path) {
    if path.exists() {
        if let Ok(meta) = fs::metadata(path) {
            let size_mb = meta.len() as f64 / (1024.0 * 1024.0);
            println!("    [✓] {:<16} {} ({:.2} MB)", label, path.display(), size_mb);
            return;
        }
    }
    println!("    [✗] {:<16} Missing at {}", label, path.display());
}

async fn probe_tcp_health(host: &str, port: u16) -> bool {
    tokio::time::timeout(std::time::Duration::from_millis(800), async {
        let addr = format!("{}:{}", host, port);
        if let Ok(mut stream) = tokio::net::TcpStream::connect(&addr).await {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let req = format!("GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", addr);
            if stream.write_all(req.as_bytes()).await.is_ok() {
                let mut buf = [0u8; 256];
                if let Ok(n) = stream.read(&mut buf).await {
                    let res = String::from_utf8_lossy(&buf[..n]);
                    return res.contains("200 OK");
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

fn check_host_antigravity() {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let ag_dir = PathBuf::from(&home).join(".gemini").join("antigravity-cli");
    if ag_dir.exists() {
        let hook_path = ag_dir.join("hooks").join("laya-pretool-hook.js");
        if hook_path.exists() {
            println!("    [✓] Antigravity CLI: Detected at {} (Hook Active)", ag_dir.display());
        } else {
            println!("    [✓] Antigravity CLI: Detected at {} (Hook not yet installed)", ag_dir.display());
        }
    } else {
        println!("    [-] Antigravity CLI: Not detected at ~/.gemini/antigravity-cli");
    }
}

fn check_host_claude_code() {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let claude_dir = PathBuf::from(&home).join(".claude");
    if claude_dir.exists() {
        let settings = claude_dir.join("settings.json");
        let has_hook = if settings.exists() {
            fs::read_to_string(&settings).map(|s| s.contains("laya")).unwrap_or(false)
        } else {
            false
        };
        if has_hook {
            println!("    [✓] Claude Code:     Detected at {} (PreToolUse Hook Configured)", claude_dir.display());
        } else {
            println!("    [✓] Claude Code:     Detected at {} (Ready for hook installation)", claude_dir.display());
        }
    } else {
        println!("    [-] Claude Code:     Not detected at ~/.claude");
    }
}

fn check_host_cursor() {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let cursor_dir = PathBuf::from(&home).join(".cursor");
    if cursor_dir.exists() {
        println!("    [✓] Cursor:          Detected at {}", cursor_dir.display());
    } else {
        println!("    [-] Cursor:          Not detected at ~/.cursor");
    }
}
