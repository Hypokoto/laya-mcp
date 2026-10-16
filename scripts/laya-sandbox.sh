#!/usr/bin/env bash
# ==============================================================================
# Laya OS-Level Sandboxing Harness (Bubblewrap / Container)
# ==============================================================================
# Provides unprivileged user-namespace kernel isolation for untrusted repositories.
#
# Threat Model:
# While Laya intercepts tool invocations before execution, untrusted projects can
# execute arbitrary code via build scripts (build.rs, package.json scripts) or
# child subshells once a tool is launched. This harness guarantees:
#
# 1. Read-only host filesystem: Host binaries and libraries are mounted read-only.
# 2. Credential masking: ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube are shadowed by empty tmpfs.
# 3. Process isolation: Isolated PID/IPC namespace prevents inspecting/signaling host tasks.
# 4. Scoped workspace: Only the current project workspace is writable.
# 5. Network containment: Optional --offline flag completely unshares the network stack.
# ==============================================================================

set -euo pipefail

OFFLINE=0
WORKSPACE="$(pwd)"
COMMAND=()

usage() {
    cat <<EOF
Usage: $0 [OPTIONS] [--] [COMMAND...]

Options:
  --workspace <DIR>    Set target workspace directory (default: current directory)
  --offline            Drop network access inside the sandbox
  --help               Display this help message

Examples:
  $0 cargo test
  $0 --offline npm test
  $0 --workspace /tmp/untrusted-repo -- make
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --offline)
            OFFLINE=1
            shift
            ;;
        --workspace)
            WORKSPACE="$(cd "$2" 2>/dev/null && pwd || echo "$2")"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        --)
            shift
            COMMAND=("$@")
            break
            ;;
        *)
            COMMAND=("$@")
            break
            ;;
    esac
done

if [[ ${#COMMAND[@]} -eq 0 ]]; then
    COMMAND=("bash")
fi

if command -v bwrap >/dev/null 2>&1; then
    # Preferred: Fast, zero-root, unprivileged Bubblewrap sandbox
    BWRAP_ARGS=(
        --ro-bind / /
        --dev /dev
        --proc /proc
        --tmpfs /tmp
        --tmpfs /run/user/"$(id -u)"
        --bind "$WORKSPACE" "$WORKSPACE"
        --chdir "$WORKSPACE"
        --unshare-user
        --unshare-ipc
        --unshare-pid
        --unshare-uts
        --unshare-cgroup
        --die-with-parent
    )

    if [[ "$OFFLINE" -eq 1 ]]; then
        BWRAP_ARGS+=(--unshare-net)
    fi

    # Mask sensitive credentials
    for cred_dir in ~/.ssh ~/.aws ~/.gnupg ~/.kube ~/.azure ~/.config/gcloud ~/.docker; do
        if [[ -e "$cred_dir" ]]; then
            BWRAP_ARGS+=(--tmpfs "$cred_dir")
        fi
    done

    exec bwrap "${BWRAP_ARGS[@]}" "${COMMAND[@]}"

elif command -v podman >/dev/null 2>&1 || command -v docker >/dev/null 2>&1; then
    ENGINE="podman"
    command -v podman >/dev/null 2>&1 || ENGINE="docker"

    NET_FLAG="--net=none"
    if [[ "$OFFLINE" -eq 0 ]]; then
        NET_FLAG="--net=bridge"
    fi

    USER_FLAG=()
    if [[ "$ENGINE" == "podman" ]]; then
        USER_FLAG=(--userns=keep-id)
    fi

    exec "$ENGINE" run --rm -it \
        --cap-drop all \
        --security-opt no-new-privileges \
        --read-only \
        --tmpfs /tmp:rw,noexec,nosuid,size=512m \
        "$NET_FLAG" \
        "${USER_FLAG[@]}" \
        -v "$WORKSPACE:$WORKSPACE:rw" \
        -w "$WORKSPACE" \
        ubuntu:latest "${COMMAND[@]}"
else
    echo "❌ Error: Neither 'bwrap' (Bubblewrap) nor 'podman'/'docker' was found on PATH." >&2
    echo "To isolate untrusted commands, install bubblewrap: sudo apt install bubblewrap (or pacman -S bubblewrap)." >&2
    exit 1
fi
