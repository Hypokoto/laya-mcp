use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use clap::{Parser, Subcommand};
use laya_core::types::{DecisionRequest, DecisionResponse};
use laya_onnx::LayaEngine;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Read};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tower_http::cors::CorsLayer;
use tracing::Level;
use tracing_subscriber::FmtSubscriber;

#[derive(Parser, Debug)]
#[command(name = "laya", author, version, about = "High-Performance Native Laya ONNX Inference Engine & Policy Runtime", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Path to model ONNX file
    #[arg(long, global = true, env = "LAYA_MODEL_PATH")]
    model: Option<PathBuf>,

    /// Path to tokenizer directory or tokenizer.json
    #[arg(long, global = true, env = "LAYA_TOKENIZER_PATH")]
    tokenizer: Option<PathBuf>,

    /// Path to laya_config.json
    #[arg(long, global = true, env = "LAYA_CONFIG_PATH")]
    config: Option<PathBuf>,

    /// Path to laya_rules.json
    #[arg(long, global = true, env = "LAYA_RULES_PATH")]
    rules: Option<PathBuf>,

    /// Intra-op execution threads
    #[arg(long, global = true, default_value = "4")]
    threads: usize,

    /// Enable verbose diagnostic logs
    #[arg(short, long, global = true)]
    verbose: bool,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Inspect ONNX model graph structure, inputs, and outputs
    Inspect {
        /// Path to ONNX model
        #[arg(short, long)]
        model: Option<PathBuf>,
    },

    /// Run single decision query via CLI arguments or stdin JSON
    Decide {
        /// Tool name (e.g. run_command, write_file)
        #[arg(short, long)]
        tool: Option<String>,

        /// Arguments JSON string
        #[arg(short, long)]
        args: Option<String>,

        /// Context / instruction text
        #[arg(short, long)]
        context: Option<String>,

        /// Read request from stdin
        #[arg(long)]
        stdin: bool,
    },

    /// Run latency, memory, and throughput benchmarks
    Bench {
        /// Number of iterations
        #[arg(short, long, default_value = "100")]
        iterations: usize,

        /// Path to test cases JSON file (e.g. laya_100_audit_report.json)
        #[arg(long)]
        test_file: Option<PathBuf>,
    },

    /// Run high-speed native Axum HTTP daemon (drop-in replacement for FastAPI :8000)
    Serve {
        /// Port to bind HTTP daemon
        #[arg(short, long, default_value = "8000")]
        port: u16,

        /// Host address to bind HTTP daemon
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
    },

    /// Verify cryptographic artifact hashes against supplied model_manifest.json
    VerifyManifest {
        /// Path to model_manifest.json
        #[arg(short, long)]
        manifest: Option<PathBuf>,

        /// Expected SHA-256 digest of the manifest itself for cryptographic provenance authentication
        #[arg(long, env = "LAYA_MANIFEST_DIGEST")]
        trusted_digest: Option<String>,
    },
}

fn resolve_default_paths(
    cli_model: Option<PathBuf>,
    cli_tokenizer: Option<PathBuf>,
    cli_config: Option<PathBuf>,
    cli_rules: Option<PathBuf>,
) -> (PathBuf, PathBuf, Option<PathBuf>, Option<PathBuf>) {
    let repo_root = PathBuf::from(std::env::var("LAYA_HOME").unwrap_or_else(|_| ".".to_string()));

    let model_path = cli_model.unwrap_or_else(|| {
        let int8 = repo_root.join("laya_int8.onnx");
        if int8.exists() {
            int8
        } else {
            repo_root.join("laya.onnx")
        }
    });

    let tokenizer_path = cli_tokenizer.unwrap_or_else(|| {
        let candidate = repo_root.join("tokenizer").join("tokenizer.json");
        if candidate.exists() {
            candidate
        } else {
            repo_root.join("tokenizer.json")
        }
    });

    let config_path = cli_config.or_else(|| {
        let candidate = repo_root.join("laya_config.json");
        if candidate.exists() {
            Some(candidate)
        } else {
            None
        }
    });

    let rules_path = cli_rules.or_else(|| {
        let candidate = repo_root.join("laya_rules.json");
        if candidate.exists() {
            Some(candidate)
        } else {
            let alt = repo_root.join(".laya").join("rules.json");
            if alt.exists() {
                Some(alt)
            } else {
                None
            }
        }
    });

    (model_path, tokenizer_path, config_path, rules_path)
}

struct AppState {
    engine: Arc<LayaEngine>,
    start_time: Instant,
    model_name: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let max_level = if cli.verbose { Level::INFO } else { Level::WARN };
    let subscriber = FmtSubscriber::builder()
        .with_max_level(max_level)
        .with_target(false)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    let (model_path, tokenizer_path, config_path, rules_path) =
        resolve_default_paths(cli.model, cli.tokenizer, cli.config, cli.rules);

    match cli.command {
        Commands::Inspect { model } => {
            let target_model = model.unwrap_or(model_path);
            println!("================================================================================");
            println!("🔍 LAYA ONNX MODEL GRAPH INSPECTION");
            println!("================================================================================");
            println!("File: {}", target_model.display());

            if !target_model.exists() {
                eprintln!("Error: Model file not found at {}", target_model.display());
                std::process::exit(1);
            }

            let metadata = fs::metadata(&target_model)?;
            println!("Size: {} bytes ({:.2} MB)", metadata.len(), metadata.len() as f64 / (1024.0 * 1024.0));

            let env = ort::init().with_name("laya-inspect").build()?;
            let session = ort::session::Session::builder(&env)?
                .commit_from_file(&target_model)?;

            println!("\nGraph Inputs:");
            for (i, input) in session.inputs().iter().enumerate() {
                println!("  [{}] Name: '{}'", i, input.name());
            }

            println!("\nGraph Outputs:");
            for (i, output) in session.outputs().iter().enumerate() {
                println!("  [{}] Name: '{}'", i, output.name());
            }
            println!("================================================================================");
        }

        Commands::Decide {
            tool,
            args,
            context,
            stdin,
        } => {
            let engine = LayaEngine::load(
                &model_path,
                &tokenizer_path,
                config_path.as_deref(),
                rules_path.as_deref(),
                cli.threads,
            )?;

            let req: DecisionRequest = if stdin {
                let mut buffer = String::new();
                io::stdin().read_to_string(&mut buffer)?;
                serde_json::from_str(&buffer).context("Failed to parse DecisionRequest from stdin")?
            } else {
                let tool_name = tool.unwrap_or_else(|| "laya_run_command".to_string());
                let args_val: Value = match args {
                    Some(a) => serde_json::from_str(&a).context("Failed to parse --args JSON")?,
                    None => json!({ "command": "git status" }),
                };

                DecisionRequest {
                    tool: tool_name,
                    args: args_val,
                    context,
                    criteria: None,
                }
            };

            let res = engine.decide(&req)?;
            println!("{}", serde_json::to_string_pretty(&res)?);
        }

        Commands::Bench {
            iterations,
            test_file,
        } => {
            println!("================================================================================");
            println!("⚡ LAYA NATIVE RUST INFERENCE BENCHMARK");
            println!("================================================================================");
            println!("Model:     {}", model_path.display());
            println!("Tokenizer: {}", tokenizer_path.display());
            println!("Threads:   {}", cli.threads);

            let t0 = Instant::now();
            let engine = LayaEngine::load(
                &model_path,
                &tokenizer_path,
                config_path.as_deref(),
                rules_path.as_deref(),
                cli.threads,
            )?;
            println!("✓ Model loaded in {:.2}ms", t0.elapsed().as_secs_f64() * 1000.0);

            if let Some(tf) = test_file {
                println!("\nEvaluating task suite from: {}", tf.display());
                let content = fs::read_to_string(&tf)?;
                let data: Value = serde_json::from_str(&content)?;
                let tasks = data.get("tasks").and_then(|t| t.as_array()).context("Missing 'tasks' array in benchmark file")?;

                println!("Running {} tasks...", tasks.len());
                let mut latencies = Vec::with_capacity(tasks.len());
                let mut decisions_count = std::collections::HashMap::new();

                let suite_start = Instant::now();
                for (i, task) in tasks.iter().enumerate() {
                    let tool = task.get("tool").and_then(|v| v.as_str()).unwrap_or("run_command");
                    let args = task.get("args").cloned().unwrap_or(json!({}));
                    let context = task.get("context").and_then(|v| v.as_str()).map(|s| s.to_string());

                    let req = DecisionRequest {
                        tool: tool.to_string(),
                        args,
                        context,
                        criteria: None,
                    };

                    let task_start = Instant::now();
                    let res = engine.decide(&req)?;
                    let elapsed_ms = task_start.elapsed().as_secs_f64() * 1000.0;
                    latencies.push(elapsed_ms);

                    *decisions_count.entry(res.decision.clone()).or_insert(0) += 1;
                    if (i + 1) % 10 == 0 || i + 1 == tasks.len() {
                        print!(".");
                        use std::io::Write;
                        let _ = io::stdout().flush();
                    }
                }
                println!("\n");

                if latencies.is_empty() {
                    println!("Suite Results: No tasks evaluated.");
                } else {
                    latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let len = latencies.len();
                    let total_time = suite_start.elapsed().as_secs_f64();
                    let avg = latencies.iter().sum::<f64>() / len as f64;
                    let p50 = latencies[len / 2];
                    let p95 = latencies[((len as f64 * 0.95) as usize).min(len - 1)];

                    println!("Suite Results:");
                    println!("  Total Time:    {:.2}s", total_time);
                    println!("  Avg Latency:   {:.2}ms / query", avg);
                    println!("  p50 Latency:   {:.2}ms", p50);
                    println!("  p95 Latency:   {:.2}ms", p95);
                    println!("  Throughput:    {:.1} req/sec", tasks.len() as f64 / total_time.max(1e-4));
                    println!("  Decisions:     {:?}", decisions_count);
                }
            } else {
                println!("\n[1/2] Benchmarking Tier 1 Declarative Policy Fast-Path (N={})...", iterations);
                let fast_req = DecisionRequest {
                    tool: "laya_run_command".to_string(),
                    args: json!({ "command": "git status" }),
                    context: Some("Check repository status for working tree modifications".to_string()),
                    criteria: None,
                };
                let _ = engine.decide(&fast_req)?;

                let mut fast_latencies = Vec::with_capacity(iterations);
                for _ in 0..iterations {
                    let start = Instant::now();
                    let _ = engine.decide(&fast_req)?;
                    fast_latencies.push(start.elapsed().as_secs_f64() * 1000.0);
                }

                if fast_latencies.is_empty() {
                    println!("  Declarative Fast-Path: No iterations performed.");
                } else {
                    fast_latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let len = fast_latencies.len();
                    let fast_avg: f64 = fast_latencies.iter().sum::<f64>() / len as f64;
                    let fast_p50 = fast_latencies[len / 2];
                    let fast_p95 = fast_latencies[((len as f64 * 0.95) as usize).min(len - 1)];

                    println!("  Declarative Fast-Path:");
                    println!("    Avg Latency:   {:.3}ms", fast_avg);
                    println!("    p50 (Median):  {:.3}ms", fast_p50);
                    println!("    p95 Latency:   {:.3}ms", fast_p95);
                    println!("    Throughput:    {:.1} ops/sec", 1000.0 / fast_avg.max(1e-6));
                }

                // Neural ONNX inference test
                let neural_iterations = iterations.min(100);
                println!("\n[2/2] Benchmarking Tier 2 Neural ONNX Inference (N={})...", neural_iterations);
                let neural_req = DecisionRequest {
                    tool: "laya_run_command".to_string(),
                    args: json!({ "command": "custom_build_binary --target wasm32" }),
                    context: Some("Compile application for experimental WebAssembly target".to_string()),
                    criteria: None,
                };
                let _ = engine.decide(&neural_req)?;

                let mut neural_latencies = Vec::with_capacity(neural_iterations);
                for _ in 0..neural_iterations {
                    let start = Instant::now();
                    let _ = engine.decide(&neural_req)?;
                    neural_latencies.push(start.elapsed().as_secs_f64() * 1000.0);
                }

                if neural_latencies.is_empty() {
                    println!("  Neural ONNX Inference: No iterations performed.");
                } else {
                    neural_latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let len = neural_latencies.len();
                    let neural_avg: f64 = neural_latencies.iter().sum::<f64>() / len as f64;
                    let neural_p50 = neural_latencies[len / 2];
                    let neural_p95 = neural_latencies[((len as f64 * 0.95) as usize).min(len - 1)];

                    println!("  Neural ONNX Inference:");
                    println!("    Avg Latency:   {:.2}ms", neural_avg);
                    println!("    p50 (Median):  {:.2}ms", neural_p50);
                    println!("    p95 Latency:   {:.2}ms", neural_p95);
                    println!("    Throughput:    {:.1} inferences/sec", 1000.0 / neural_avg.max(1e-6));
                }
            }
            println!("================================================================================");
        }

        Commands::Serve { port, host } => {
            println!("================================================================================");
            println!("⚡ LAYA NATIVE RUST DAEMON (Axum Engine)");
            println!("================================================================================");
            println!("Initializing ONNX Runtime engine (threads: {})...", cli.threads);

            let t0 = Instant::now();
            let engine = LayaEngine::load(
                &model_path,
                &tokenizer_path,
                config_path.as_deref(),
                rules_path.as_deref(),
                cli.threads,
            )?;
            println!("✓ Model loaded in {:.2}ms ({})", t0.elapsed().as_secs_f64() * 1000.0, model_path.display());

            let app_state = Arc::new(AppState {
                engine: Arc::new(engine),
                start_time: Instant::now(),
                model_name: model_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            });

            let cors = CorsLayer::new()
                .allow_origin([
                    "http://localhost:3000".parse().unwrap(),
                    "http://127.0.0.1:3000".parse().unwrap(),
                    "http://localhost:8000".parse().unwrap(),
                    "http://127.0.0.1:8000".parse().unwrap(),
                ])
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                .allow_headers([axum::http::header::CONTENT_TYPE, axum::http::header::AUTHORIZATION]);

            let app = Router::new()
                .route("/health", get(health_handler))
                .route("/openapi.json", get(openapi_handler))
                .route("/decide", post(decide_handler))
                .layer(cors)
                .with_state(app_state);

            let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
            println!("\n🚀 Laya Native Daemon listening on http://{}", addr);
            println!("   - Health Check: http://{}/health", addr);
            println!("   - Decisions:    POST http://{}/decide", addr);
            println!("   - Status:       Drop-in replacement for Python FastAPI on :{}", port);
            println!("================================================================================");

            let listener = tokio::net::TcpListener::bind(addr).await?;
            axum::serve(listener, app).await?;
        }

        Commands::VerifyManifest { manifest, trusted_digest } => {
            let manifest_path = manifest.unwrap_or_else(|| {
                let repo_root = PathBuf::from(std::env::var("LAYA_HOME").unwrap_or_else(|_| ".".to_string()));
                repo_root.join("model_manifest.json")
            });

            println!("================================================================================");
            println!("🔒 LAYA ARTIFACT CHECKSUM VERIFICATION");
            println!("================================================================================");
            println!("Manifest: {}", manifest_path.display());

            if !manifest_path.exists() {
                eprintln!("Error: Manifest file not found at {}", manifest_path.display());
                std::process::exit(1);
            }

            let manifest_content = fs::read_to_string(&manifest_path)?;
            use sha2::{Digest, Sha256};
            let computed_manifest_digest = hex::encode(Sha256::digest(manifest_content.as_bytes()));
            println!("Manifest SHA-256: {}", computed_manifest_digest);

            let mut manifest_authenticated = false;
            if let Some(ref expected) = trusted_digest {
                if computed_manifest_digest.eq_ignore_ascii_case(expected) {
                    manifest_authenticated = true;
                    println!("Manifest Auth:    Authenticated against trusted digest ({})", &expected[..16]);
                } else {
                    eprintln!("❌ MANIFEST AUTHENTICATION FAILED: Digest does not match trusted reference!");
                    eprintln!("   Expected: {}", expected);
                    eprintln!("   Computed: {}", computed_manifest_digest);
                    std::process::exit(1);
                }
            } else {
                println!("Manifest Auth:    No external digest supplied (verifying relative checksums only)");
            }

            let manifest_json: Value = serde_json::from_str(&manifest_content)?;

            let model_name = manifest_json["model_identity"]["name"].as_str().unwrap_or("unknown");
            let commit = manifest_json["model_identity"]["pinned_revision"].as_str().unwrap_or("unknown");

            println!("Declared Model:  {}", model_name);
            println!("Declared Commit: {}", commit);
            println!("--------------------------------------------------------------------------------");

            let artifacts = manifest_json["artifacts"]
                .as_object()
                .context("Malformed manifest: missing 'artifacts' object")?;

            if artifacts.is_empty() {
                eprintln!("Error: Manifest contains no artifacts to verify.");
                std::process::exit(1);
            }

            let repo_root = manifest_path.parent().unwrap_or_else(|| std::path::Path::new("."));
            let mut all_valid = true;

            for (key, val) in artifacts {
                let rel_path = val["path"].as_str().unwrap_or("");
                let expected_hash = val["sha256"].as_str().unwrap_or("");
                let full_path = repo_root.join(rel_path);

                if !full_path.exists() {
                    println!("  [✗] {:<18} Missing file: {}", key, full_path.display());
                    all_valid = false;
                    continue;
                }

                let mut file = fs::File::open(&full_path)?;
                let mut hasher = Sha256::new();
                let mut buffer = [0u8; 65536];
                loop {
                    let n = file.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buffer[..n]);
                }
                let actual_hash = hex::encode(hasher.finalize());

                if actual_hash.eq_ignore_ascii_case(expected_hash) {
                    println!("  [✓] {:<18} Match: {} ({})", key, rel_path, &actual_hash[..16]);
                } else {
                    println!("  [✗] {:<18} CHECKSUM MISMATCH: {}", key, rel_path);
                    println!("       Expected: {}", expected_hash);
                    println!("       Actual:   {}", actual_hash);
                    all_valid = false;
                }
            }

            println!("================================================================================");
            if all_valid {
                if manifest_authenticated {
                    println!("🎉 ALL ARTIFACTS VERIFIED: Checksums match and manifest authenticated against trusted digest!");
                } else {
                    println!("✓ ARTIFACT CHECKSUMS VERIFIED: All artifact checksums match the supplied manifest.");
                }
            } else {
                eprintln!("❌ VERIFICATION FAILED: One or more artifacts failed checksum verification.");
                std::process::exit(1);
            }
        }
    }

    Ok(())
}

async fn health_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let uptime = state.start_time.elapsed().as_secs();
    Json(json!({
        "status": "healthy",
        "engine": "laya-native-rust",
        "model": state.model_name,
        "uptime_seconds": uptime,
        "runtime": "ONNX Runtime CPU Native",
    }))
}

async fn openapi_handler() -> impl IntoResponse {
    Json(json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Laya Native Rust Policy Engine",
            "version": "0.1.0"
        },
        "paths": {
            "/decide": {
                "post": {
                    "summary": "Make policy and security decision"
                }
            },
            "/health": {
                "get": {
                    "summary": "Health status"
                }
            }
        }
    }))
}

async fn decide_handler(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DecisionRequest>,
) -> Result<Json<DecisionResponse>, (StatusCode, String)> {
    let engine = state.engine.clone();
    tokio::task::spawn_blocking(move || engine.decide(&payload))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Task join error: {}", e)))?
        .map(Json)
        .map_err(|err| (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Laya Engine Error: {}", err),
        ))
}
