#!/bin/bash
# start_local.sh
# Starts the complete Laya System locally with loopback binding and token authentication.

# 1. Start the Python Policy Engine on port 8000 (loopback only)
echo "Starting Laya Policy Engine on 127.0.0.1:8000..."
source .venv/bin/activate
cd laya_runtime
python main.py > server.log 2>&1 &
PYTHON_PID=$!
cd ..

echo "Waiting for Python ONNX inference model to load (can take ~15-20 seconds)..."
sleep 15

# 2. Start the TypeScript MCP Server via SSE on port 3000
echo "Starting Laya MCP Server on authenticated SSE (port 3000)..."
cd laya-mcp
export PORT=3000
export HOST="${HOST:-127.0.0.1}"
export LAYA_API_TOKEN="${LAYA_API_TOKEN:-$(openssl rand -hex 24)}"
npm start &
MCP_PID=$!
cd ..

echo ""
echo "=========================================================="
echo "🔒 Laya System is RUNNING with Authentication!"
echo "Host Binding:     $HOST"
echo "Python Engine:    http://127.0.0.1:8000"
echo "MCP SSE Endpoint: http://$HOST:3000/sse"
echo "API Token:        $LAYA_API_TOKEN"
echo "Header:           Authorization: Bearer $LAYA_API_TOKEN"
echo "=========================================================="
echo "Press CTRL+C to safely shut down the system."

# Keep script running and clean up on exit
trap "echo 'Shutting down...'; kill $PYTHON_PID $MCP_PID; exit" SIGINT SIGTERM
wait
