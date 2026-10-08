#!/bin/bash
# start_local.sh
# Starts the complete Laya System locally so ANY AI Harness (Cursor, Claude, etc.)
# can connect to it over the local network via SSE (Server-Sent Events).

# 1. Start the Python Policy Engine on port 8000
echo "Starting Laya Policy Engine..."
source .venv/bin/activate
cd laya_runtime
python main.py > server.log 2>&1 &
PYTHON_PID=$!
cd ..

echo "Waiting for Python ONNX inference model to load (can take ~20 seconds)..."
sleep 20

# 2. Start the TypeScript MCP Server via SSE on port 3000
echo "Starting Laya MCP Server on SSE (port 3000)..."
cd laya-mcp
export PORT=3000
npm start &
MCP_PID=$!
cd ..

echo ""
echo "=========================================================="
echo "✅ Laya System is RUNNING LOCALLY!"
echo "Python Engine: http://localhost:8000"
echo "MCP SSE Endpoint: http://localhost:3000/sse"
echo "=========================================================="
echo "To connect an AI harness (like Cursor or Windsurf) from ANY machine on your Wi-Fi, add this MCP server:"
echo "Transport: SSE"
echo "URL: http://<this-machine-ip>:3000/sse"
echo "=========================================================="
echo "Press CTRL+C to safely shut down the system."

# Keep script running and clean up on exit
trap "echo 'Shutting down...'; kill $PYTHON_PID $MCP_PID; exit" SIGINT SIGTERM
wait
