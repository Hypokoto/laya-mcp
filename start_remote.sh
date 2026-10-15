#!/bin/bash
# ==============================================================================
# start_remote.sh — Laya Remote Access & Daemon Manager
# ==============================================================================
# Recommended Remote Architecture: SSH stdio bridge (Zero-Open-Port MCP)
#
# Client configuration:
#   npx laya-mcp remote setup user@<this-machine-ip> [allowed_dir]
#
# Direct invocation by AI harnesses (Cursor, Claude Desktop, Antigravity):
#   ssh -T user@<this-machine-ip> laya serve
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================================="
echo "          Laya Universal Decision & Policy Engine          "
echo "                 Remote Connection Manager                "
echo "=========================================================="

# Check Python environment
if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

# Detect primary IP address
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
HOST_IP="${HOST_IP:-your-host-ip}"
USER_NAME=$(whoami)

echo ""
echo "🚀 1. RECOMMENDED: SSH Stdio Bridge (Zero Open Ports, End-to-End Encrypted)"
echo "----------------------------------------------------------"
echo "To connect any local AI harness (Cursor, Claude Code, Antigravity) to this machine:"
echo ""
echo "   On your local development client, run:"
echo "   👉 npx laya-mcp remote setup ${USER_NAME}@${HOST_IP}"
echo ""
echo "Or configure your harness MCP config directly:"
echo '   { "command": "ssh", "args": ["-T", "'"${USER_NAME}@${HOST_IP}"'", "laya", "serve"] }'
echo ""

# Ensure Python Laya Runtime is running in the background for local evaluations
echo "🔍 Checking Laya ONNX runtime status..."
if curl -s http://127.0.0.1:8000/openapi.json >/dev/null 2>&1; then
    echo "✅ Python ONNX runtime is already active on 127.0.0.1:8000."
else
    echo "⚙️ Starting local Python ONNX engine daemon (127.0.0.1:8000)..."
    cd laya_runtime
    python main.py > server.log 2>&1 &
    PYTHON_PID=$!
    cd ..
    echo "⏳ Waiting for ONNX model warmup (PID: $PYTHON_PID)..."
    RUNTIME_READY=0
    for i in {1..30}; do
        if curl -s http://127.0.0.1:8000/openapi.json >/dev/null 2>&1; then
            echo "✅ Python ONNX runtime ready."
            RUNTIME_READY=1
            break
        fi
        sleep 1
    done

    if [ "$RUNTIME_READY" -eq 0 ]; then
        echo "❌ Error: Python ONNX engine failed to become ready within 30 seconds."
        echo "   Inspect laya_runtime/server.log for startup error details."
        exit 1
    fi
fi

# Mode check: if user passed --http or --tunnel, run the legacy HTTP/SSE daemon
if [[ "$1" == "--http" || "$1" == "--tunnel" ]]; then
    echo ""
    echo "⚠️ Starting legacy authenticated HTTP/SSE server with token..."
    if [ -z "$LAYA_API_TOKEN" ]; then
        export LAYA_API_TOKEN="$(openssl rand -hex 24)"
        echo "🔑 Generated secure LAYA_API_TOKEN: $LAYA_API_TOKEN"
    fi

    cd laya-mcp
    export PORT="${PORT:-3000}"
    export HOST="127.0.0.1"
    npm start > ../mcp_server.log 2>&1 &
    MCP_PID=$!
    trap 'kill "$MCP_PID" 2>/dev/null || true' EXIT INT TERM
    cd ..

    echo "⏳ Waiting for MCP HTTP/SSE server readiness (PID: $MCP_PID)..."
    MCP_READY=0
    for i in {1..30}; do
        if curl -s "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
            MCP_READY=1
            break
        fi
        sleep 1
    done

    if [ "$MCP_READY" -eq 0 ]; then
        echo "❌ Error: MCP HTTP/SSE server failed to start within 30 seconds."
        echo "   Inspect mcp_server.log for error details."
        exit 1
    fi

    if [[ "$1" == "--tunnel" ]]; then
        echo "🌐 Tunneling authenticated MCP server (port ${PORT}) via localtunnel..."
        export npm_config_cache=$(pwd)/.npm_cache
        npx -y localtunnel --port "$PORT"
    else
        echo "✅ Authenticated MCP HTTP/SSE server running on http://127.0.0.1:${PORT}"
        echo "   Press Ctrl+C to terminate."
        wait $MCP_PID
    fi
else
    echo "💡 Remote SSH bridge is ready for incoming sessions via 'ssh -T ${USER_NAME}@${HOST_IP} laya serve'."
    echo "   (Pass '--http' or '--tunnel' only if you specifically require HTTP/SSE daemon mode)."
fi
