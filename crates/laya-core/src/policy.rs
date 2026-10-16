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
        Regex::new(r"(?i)(hooks/laya-pretool-hook\.js|laya_runtime/|laya_config\.json|laya_rules\.json|\.laya/|\.claude/settings\.json|\.gemini/)").unwrap()
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

pub fn check_emergency_invariants(tool: &str, args: &Value) -> Option<&'static str> {
    let cmd_str = args.get("CommandLine")
        .or_else(|| args.get("command"))
        .or_else(|| args.get("cmd"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let filepath = args.get("filepath")
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .or_else(|| args.get("TargetFile"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let combined_target = format!("{} {}", cmd_str, filepath);
    if get_protected_paths_re().is_match(&combined_target) {
        let re_read = Regex::new(r"(?i)^(read|view|search|grep)").unwrap();
        if !re_read.is_match(tool) {
            return Some("REQUIRE_AUTHORIZATION");
        }
    }

    let mut target_cmd = cmd_str.to_string();
    if target_cmd.is_empty() && get_shell_tool_re().is_match(tool) {
        target_cmd = args.to_string();
    }

    if !target_cmd.is_empty() {
        let norm = normalize_shell_command(&target_cmd);
        if is_destructive_rm(&norm) {
            return Some("DENY");
        }
        for rx in get_destructive_regexes() {
            if rx.is_match(&norm) {
                return Some("DENY");
            }
        }
        for rx in get_authorization_regexes() {
            if rx.is_match(&norm) {
                return Some("REQUIRE_AUTHORIZATION");
            }
        }
    }

    None
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawRule {
    pub id: Option<String>,
    pub name: Option<String>,
    pub action: String,
    pub tool: Option<String>,
    #[serde(rename = "toolPattern")]
    pub tool_pattern: Option<String>,
    #[serde(rename = "commandPattern")]
    pub command_pattern: Option<String>,
    #[serde(rename = "pathPattern")]
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

#[derive(Debug, Clone, Default)]
pub struct PolicyEngine {
    rules: Vec<CompiledRule>,
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self { rules: Vec::new() }
    }

    pub fn load_from_file<P: AsRef<Path>>(&mut self, path: P) -> crate::error::Result<()> {
        let content = fs::read_to_string(path)?;
        let raw_file: RawRuleFile = match serde_json::from_str(&content) {
            Ok(rf) => rf,
            Err(_) => {
                let rules: Vec<RawRule> = serde_json::from_str(&content)?;
                RawRuleFile { rules: Some(rules) }
            }
        };

        let mut compiled = Vec::new();
        if let Some(rules) = raw_file.rules {
            for r in rules {
                let action = r.action.trim().to_uppercase();
                if action != "ALLOW" && action != "DENY" && action != "REQUIRE_AUTHORIZATION" {
                    continue;
                }

                let tool_pat = r.tool.or(r.tool_pattern);
                let tool_re = tool_pat.and_then(|p| Regex::new(&format!("(?i){}", p)).ok());
                let cmd_re = r.command_pattern.and_then(|p| Regex::new(&p).ok());
                let path_re = r.path_pattern.and_then(|p| Regex::new(&p).ok());

                if action == "ALLOW" && cmd_re.is_none() && path_re.is_none() {
                    continue;
                }

                let name = r.name.or(r.id).unwrap_or_else(|| "unnamed-rule".to_string());
                compiled.push(CompiledRule {
                    name,
                    action,
                    tool_re,
                    cmd_re,
                    path_re,
                });
            }
        }

        self.rules = compiled;
        Ok(())
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

            return Some((&r.action, &r.name));
        }

        None
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
