#!/usr/bin/env bash
# ==============================================================================
# Laya Sustained Field Operational Telemetry Collector
# ==============================================================================
# Continuously records operational metrics for the running Laya daemon:
# - Process PID, memory RSS (VmRSS), and CPU utilization
# - API Health (/health endpoint) and daemon uptime
# - Crash / restart event tracking
# - Appends structured JSON lines to ~/.local/state/laya/telemetry.jsonl
# ==============================================================================
set -u

STATE_DIR="${LAYA_STATE_DIR:-$HOME/.local/state/laya}"
mkdir -p "$STATE_DIR"
TELEMETRY_LOG="$STATE_DIR/telemetry.jsonl"
DAEMON_PORT="${LAYA_PORT:-8000}"

echo "[LAYA TELEMETRY] Initializing sustained field telemetry logger..."
echo "[LAYA TELEMETRY] Destination: $TELEMETRY_LOG"

collect_snapshot() {
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    local pid
    pid=$(pgrep -f "laya serve" | head -n 1 || echo "")
    
    local rss_kb=0
    local cpu_pct=0
    local is_healthy=false
    local uptime_sec=0
    local model_loaded=""
    
    if [[ -n "$pid" ]]; then
        if [[ -f "/proc/$pid/status" ]]; then
            rss_kb=$(grep -i "VmRSS" "/proc/$pid/status" 2>/dev/null | awk '{print $2}' || echo "0")
        fi
        cpu_pct=$(ps -p "$pid" -o %cpu= 2>/dev/null | tr -d ' ' || echo "0")
        
        # Check health endpoint
        local health_json
        health_json=$(curl -s -m 2 "http://127.0.0.1:$DAEMON_PORT/health" 2>/dev/null || echo "")
        if [[ -n "$health_json" && "$health_json" =~ "healthy" ]]; then
            is_healthy=true
            uptime_sec=$(echo "$health_json" | grep -o '"uptime_seconds":[0-9]*' | cut -d: -f2 || echo "0")
            model_loaded=$(echo "$health_json" | grep -o '"model":"[^"]*"' | cut -d: -f2 | tr -d '"' || echo "")
        fi
    fi

    # Append structured JSON line
    cat <<EOF >> "$TELEMETRY_LOG"
{"timestamp":"$timestamp","pid":"$pid","is_healthy":$is_healthy,"uptime_seconds":$uptime_sec,"memory_rss_kb":$rss_kb,"memory_rss_mb":$(awk "BEGIN {print $rss_kb/1024}"),"cpu_percent":"$cpu_pct","model":"$model_loaded"}
EOF
}

# If run with --once, record a single entry and exit (useful for cron/systemd)
if [[ "${1:-}" == "--once" ]]; then
    collect_snapshot
    echo "[LAYA TELEMETRY] Snapshot logged to $TELEMETRY_LOG"
    exit 0
fi

# Otherwise run continuous sampling loop (every 60s)
INTERVAL="${TELEMETRY_INTERVAL:-60}"
echo "[LAYA TELEMETRY] Continuous monitoring active (interval: ${INTERVAL}s). Press Ctrl+C to stop."
while true; do
    collect_snapshot
    sleep "$INTERVAL"
done
