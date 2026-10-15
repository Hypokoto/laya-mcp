#!/usr/bin/env bash
# ==============================================================================
# Laya ONNX MCP — Rootless Sandboxed Runner
# ==============================================================================
# Runs the Laya MCP Server inside an isolated rootless container (Podman or Docker)
# with all capabilities dropped, no new privileges, and scoped directory mounting.
# ==============================================================================

set -e

# Detect container engine: prefer podman (rootless by design) over docker
if command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE="podman"
elif command -v docker >/dev/null 2>&1; then
    CONTAINER_ENGINE="docker"
else
    echo "❌ Error: Neither podman nor docker was found on your system."
    echo "Please install podman (e.g., sudo pacman -S podman or sudo apt install podman)."
    exit 1
fi

IMAGE_NAME="laya-mcp:latest"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORKSPACE_DIR="$(pwd)"
if [ "$#" -gt 0 ] && [ "$1" != "--" ] && [[ "$1" != -* ]]; then
    WORKSPACE_DIR="$(cd "$1" 2>/dev/null && pwd || echo "$1")"
    shift
fi

echo "🔒 Running Laya MCP in rootless sandbox using $CONTAINER_ENGINE..."
echo "   Target Workspace: $WORKSPACE_DIR"
echo "   Script Root:      $SCRIPT_DIR"

# Build image if missing
if ! $CONTAINER_ENGINE image exists "$IMAGE_NAME" 2>/dev/null && ! $CONTAINER_ENGINE images -q "$IMAGE_NAME" 2>/dev/null | grep -q .; then
    echo "📦 Building $IMAGE_NAME container image..."
    $CONTAINER_ENGINE build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Containerfile" "$SCRIPT_DIR"
fi

# Execute with maximum security isolation:
# - --cap-drop all: Drop all Linux capabilities
# - --security-opt no-new-privileges: Prevent privilege escalation
# - --read-only: Read-only root filesystem
# - --tmpfs /tmp: Temporary writable directory for runtime sockets/buffers
# - --userns=keep-id: Map current user UID to container UID 1000 so :rw workspace works cleanly under rootless Podman
# - -v <workspace>:/workspace:rw: Scope file access to target workspace only
# - -v <weights>:/app/laya.onnx:ro: Mount ONNX model weights read-only from SCRIPT_DIR
MOUNT_ARGS=(
    "-v" "$WORKSPACE_DIR:/workspace:rw"
)

if [ -f "$SCRIPT_DIR/laya.onnx" ]; then
    MOUNT_ARGS+=("-v" "$SCRIPT_DIR/laya.onnx:/app/laya.onnx:ro")
fi
if [ -f "$SCRIPT_DIR/laya.onnx.data" ]; then
    MOUNT_ARGS+=("-v" "$SCRIPT_DIR/laya.onnx.data:/app/laya.onnx.data:ro")
fi
if [ -d "$SCRIPT_DIR/tokenizer" ]; then
    MOUNT_ARGS+=("-v" "$SCRIPT_DIR/tokenizer:/app/tokenizer:ro")
fi

EXTRA_FLAGS=()
if [ "$CONTAINER_ENGINE" = "podman" ]; then
    EXTRA_FLAGS+=("--userns=keep-id")
fi

exec $CONTAINER_ENGINE run --rm -i \
    --cap-drop all \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=512m \
    --pids-limit 100 \
    --memory 2g \
    "${EXTRA_FLAGS[@]}" \
    "${MOUNT_ARGS[@]}" \
    "$IMAGE_NAME" "$@"
