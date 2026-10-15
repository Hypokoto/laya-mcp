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
WORKSPACE_DIR="${1:-$(pwd)}"

echo "🔒 Running Laya MCP in rootless sandbox using $CONTAINER_ENGINE..."
echo "   Target Workspace: $WORKSPACE_DIR"

# Build image if missing
if ! $CONTAINER_ENGINE image exists "$IMAGE_NAME" 2>/dev/null && ! $CONTAINER_ENGINE images -q "$IMAGE_NAME" | grep -q .; then
    echo "📦 Building $IMAGE_NAME container image..."
    $CONTAINER_ENGINE build -t "$IMAGE_NAME" -f Containerfile .
fi

# Execute with maximum security isolation:
# - --cap-drop all: Drop all Linux capabilities
# - --security-opt no-new-privileges: Prevent privilege escalation
# - -v <workspace>:/workspace:ro or :rw: Scope file access to target workspace only
# - -v <weights>:/app/laya.onnx:ro: Mount ONNX model weights read-only if present locally
MOUNT_ARGS=(
    "-v" "$WORKSPACE_DIR:/workspace:rw"
)

if [ -f "laya.onnx" ]; then
    MOUNT_ARGS+=("-v" "$(pwd)/laya.onnx:/app/laya.onnx:ro")
fi
if [ -f "laya.onnx.data" ]; then
    MOUNT_ARGS+=("-v" "$(pwd)/laya.onnx.data:/app/laya.onnx.data:ro")
fi
if [ -d "tokenizer" ]; then
    MOUNT_ARGS+=("-v" "$(pwd)/tokenizer:/app/tokenizer:ro")
fi

exec $CONTAINER_ENGINE run --rm -i \
    --cap-drop all \
    --security-opt no-new-privileges \
    "${MOUNT_ARGS[@]}" \
    "$IMAGE_NAME" "$@"
