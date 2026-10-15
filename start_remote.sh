#!/bin/bash
# start_remote.sh
# Safely exposes authenticated Laya MCP SSE (port 3000) via localtunnel with mandatory token.

if [ -z "$LAYA_API_TOKEN" ]; then
    export LAYA_API_TOKEN="$(openssl rand -hex 24)"
    echo "🔑 Generated secure LAYA_API_TOKEN: $LAYA_API_TOKEN"
fi

echo "Starting local services on 127.0.0.1..."
source .venv/bin/activate
cd laya_runtime
python main.py > server.log 2>&1 &
PYTHON_PID=$!
cd ..

sleep 15

cd laya-mcp
export PORT=3000
export HOST="127.0.0.1"
npm start > ../mcp_server.log 2>&1 &
MCP_PID=$!
cd ..

sleep 3

echo "Tunneling authenticated MCP server (port 3000) via localtunnel..."
echo "⚠️  Never share your LAYA_API_TOKEN with untrusted parties."
export npm_config_cache=$(pwd)/.npm_cache
npx -y localtunnel --port 3000

# Cleanup on exit
kill $PYTHON_PID $MCP_PID
