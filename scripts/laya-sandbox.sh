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
# 1. Read-only host filesystem: Host root and binaries are mounted read-only.
# 2. Complete Credential Shadowing: All cloud, git, shell, and daemon credentials
#    (~/.ssh, ~/.aws, ~/.gemini, ~/.local/state/laya, ~/.netrc) are masked.
# 3. Environment Sanitization: Clears host environment (--clearenv), stripping
#    all API keys, tokens, and secrets from being read via env or /proc.
# 4. Process Isolation: Unshared PID/IPC namespaces hide all host processes.
# 5. Kernel Security Protection: Masks /sys/firmware and /sys/kernel/security.
# 6. Scoped Workspace: Only the designated workspace is mounted read-write.
# 7. Network Containment: Optional --offline flag completely unshares the network.
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
    EMPTY_MASK=$(mktemp /tmp/laya_mask.XXXXXX)
    chmod 0400 "$EMPTY_MASK"
    trap 'rm -f "$EMPTY_MASK"' EXIT

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
        --hostname "laya-sandbox"
        --die-with-parent
    )

    # Environment sanitization: clear all host secrets, pass only safe execution vars
    BWRAP_ARGS+=(
        --clearenv
        --setenv PATH "$PATH"
        --setenv HOME "$HOME"
        --setenv USER "$USER"
        --setenv LANG "${LANG:-C.UTF-8}"
        --setenv TERM "${TERM:-xterm-256color}"
        --setenv PWD "$WORKSPACE"
    )

    if [[ -n "${SHELL:-}" ]]; then
        BWRAP_ARGS+=(--setenv SHELL "$SHELL")
    fi

    # Network isolation
    if [[ "$OFFLINE" -eq 1 ]]; then
        BWRAP_ARGS+=(--unshare-net)
    fi

    # Shadow sensitive hardware & kernel state
    for sys_dir in /sys/firmware /sys/kernel/security; do
        if [[ -d "$sys_dir" ]]; then
            BWRAP_ARGS+=(--tmpfs "$sys_dir")
        fi
    done

    # Shadow sensitive credential & daemon directories with empty tmpfs
    for cred_dir in ~/.ssh ~/.aws ~/.gnupg ~/.kube ~/.azure ~/.config/gcloud ~/.config/gh ~/.config/hub ~/.docker ~/.gemini ~/.local/state/laya; do
        if [[ -e "$cred_dir" ]]; then
            BWRAP_ARGS+=(--tmpfs "$cred_dir")
        fi
    done

    # Shadow single credential files by binding the empty mask file over them
    for cred_file in ~/.netrc ~/.git-credentials ~/.npmrc ~/.pypirc ~/.bash_history ~/.zsh_history; do
        if [[ -f "$cred_file" ]]; then
            BWRAP_ARGS+=(--ro-bind "$EMPTY_MASK" "$cred_file")
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
