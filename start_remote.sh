#!/bin/bash
# start_remote.sh
# Starts the Laya Python runtime and exposes it to the internet via localtunnel.

echo "Starting Laya Runtime on port 8000..."
source .venv/bin/activate
cd laya_runtime
python main.py > server.log 2>&1 &
SERVER_PID=$!

echo "Waiting for the server to spin up..."
sleep 5

echo "Exposing local server via Localtunnel..."
export npm_config_cache=$(pwd)/../.npm_cache
npx -y localtunnel --port 8000

# Cleanup on exit
kill $SERVER_PID
