use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

pub fn run_init(workspace: Option<PathBuf>) -> Result<()> {
    let ws = workspace.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let canonical_ws = fs::canonicalize(&ws).unwrap_or(ws.clone());

    println!("================================================================================");
    println!("🌱 INITIALIZING LAYA PROJECT POLICY");
    println!("================================================================================");
    println!("Workspace: {}", canonical_ws.display());

    // 1. Detect project tooling
    println!("\n[1/3] Detecting project stack...");
    let mut detected_tools = Vec::new();
    if canonical_ws.join("Cargo.toml").exists() {
        detected_tools.push("Rust (Cargo)");
    }
    if canonical_ws.join("package.json").exists() {
        detected_tools.push("Node.js / TypeScript (npm/pnpm/yarn/bun)");
    }
    if canonical_ws.join("pyproject.toml").exists() || canonical_ws.join("requirements.txt").exists() {
        detected_tools.push("Python (pip/poetry/uv)");
    }
    if canonical_ws.join("go.mod").exists() {
        detected_tools.push("Go");
    }
    if canonical_ws.join(".git").exists() {
        detected_tools.push("Git Version Control");
    }

    if detected_tools.is_empty() {
        println!("  General / Polyglot workspace detected.");
    } else {
        println!("  Detected stacks: {}", detected_tools.join(", "));
    }

    // 2. Create .laya directory
    println!("\n[2/3] Setting up .laya/ configuration directory...");
    let laya_dir = canonical_ws.join(".laya");
    if !laya_dir.exists() {
        fs::create_dir_all(&laya_dir).with_context(|| format!("Failed to create {}", laya_dir.display()))?;
        println!("  [+] Created: {}", laya_dir.display());
    } else {
        println!("  [✓] Exists:  {}", laya_dir.display());
    }

    // 3. Generate .laya/policy.toml
    let policy_path = laya_dir.join("policy.toml");
    if !policy_path.exists() {
        let ws_name = canonical_ws.file_name().and_then(|n| n.to_str()).unwrap_or("project");
        let template = format!(r#"# Laya Project Policy Configuration
# Workspace: {}
version = "1.0"
name = "{}"

# MONOTONIC RESTRICTION GUARANTEE:
# 1. Project policy may TIGHTEN security rules (add DENY or REQUIRE_AUTHORIZATION rules).
# 2. Untrusted repositories CANNOT relax global invariants or add unverified ALLOW rules.
# 3. To permit custom ALLOW rules in this project, explicitly run:
#    laya policy trust

[[rules]]
name = "protect-production-secrets"
action = "DENY"
pathPattern = "(\\.env\\.production|secrets/|credentials\\.json)"

[[rules]]
name = "sensitive-dependency-publish"
action = "REQUIRE_AUTHORIZATION"
commandPattern = "(npm\\s+publish|cargo\\s+publish|twine\\s+upload)"
"#, canonical_ws.display(), ws_name);

        fs::write(&policy_path, template)?;
        println!("  [+] Created project policy: {}", policy_path.display());
    } else {
        println!("  [✓] Project policy already exists at: {}", policy_path.display());
    }

    println!("\n[3/3] Next steps:");
    println!("  1. Test your project policy:");
    println!("     laya policy test");
    println!("  2. (Optional) If you add custom ALLOW rules, sign and trust them:");
    println!("     laya policy trust");
    println!("================================================================================");
    Ok(())
}
