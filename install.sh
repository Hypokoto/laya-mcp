#!/usr/bin/env bash
# ==============================================================================
# Laya ONNX MCP — Universal System Installer
# ==============================================================================
# Sets up Python virtual environment, downloads model weights (~1.7GB),
# compiles TypeScript MCP server, configures AI harnesses, and verifies installation.
# ==============================================================================

set -e

# Terminal colors
BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo -e "${BOLD}${BLUE}"
echo "================================================================================"
echo "               🚀 Laya ONNX MCP — Unified Installer"
echo "================================================================================"
echo -e "${NC}"

# --- Step 1: Prerequisites Check ---
echo -e "${BOLD}[1/6] Checking system prerequisites...${NC}"

if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}❌ Error: Node.js is not installed. Please install Node.js >= 18.${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Error: Node.js version $NODE_VERSION is too old. Requires >= 18.${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v) detected."

if ! command -v python3 >/dev/null 2>&1; then
    echo -e "${RED}❌ Error: Python 3 is not installed. Please install Python >= 3.10.${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Python $(python3 --version) detected."

if command -v tree-sitter >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} tree-sitter CLI detected (code analysis enabled)."
else
    echo -e "  ${YELLOW}ℹ tree-sitter CLI not found; code analysis tools will prompt to install if used.${NC}"
fi

# --- Step 2: Python Environment Provisioning ---
echo -e "\n${BOLD}[2/6] Provisioning Python policy runtime...${NC}"

if command -v uv >/dev/null 2>&1; then
    echo -e "  ${BLUE}Found uv package manager. Running 'uv sync'...${NC}"
    uv sync
else
    echo -e "  ${YELLOW}uv not found. Falling back to standard 'python3 -m venv' and pip...${NC}"
    if [ ! -d ".venv" ]; then
        python3 -m venv .venv
    fi
    source .venv/bin/activate
    pip install --upgrade pip
    pip install fastapi uvicorn pydantic transformers onnxruntime numpy
fi
echo -e "  ${GREEN}✓${NC} Python environment ready."

# --- Step 3: Model Weights Acquisition ---
echo -e "\n${BOLD}[3/6] Checking Laya ONNX model weights (~1.7GB)...${NC}"

HF_BASE_URL="https://huggingface.co/receptron/laya-onnx/resolve/main"
mkdir -p tokenizer

download_if_missing() {
    local file="$1"
    local url="$2"
    if [ -f "$file" ] && [ -s "$file" ]; then
        echo -e "  ${GREEN}✓${NC} $file already exists."
    else
        echo -e "  ${BLUE}Downloading $file from Hugging Face...${NC}"
        curl -L -C - --retry 3 -# -o "$file" "$url"
    fi
}

if [ ! -f "laya.onnx.data" ] || [ ! -f "laya.onnx" ]; then
    if command -v hf >/dev/null 2>&1; then
        echo -e "  ${BLUE}Downloading receptron/laya-onnx via Hugging Face CLI ('hf download')...${NC}"
        hf download receptron/laya-onnx --local-dir .
    elif [ -x ".venv/bin/hf" ]; then
        echo -e "  ${BLUE}Downloading receptron/laya-onnx via Hugging Face CLI ('hf download')...${NC}"
        .venv/bin/hf download receptron/laya-onnx --local-dir .
    else
        download_if_missing "laya.onnx" "${HF_BASE_URL}/laya.onnx"
        download_if_missing "laya.onnx.data" "${HF_BASE_URL}/laya.onnx.data"
        download_if_missing "tokenizer/tokenizer.json" "${HF_BASE_URL}/tokenizer/tokenizer.json"
        download_if_missing "tokenizer/tokenizer_config.json" "${HF_BASE_URL}/tokenizer/tokenizer_config.json"
    fi
else
    echo -e "  ${GREEN}✓${NC} Model assets (laya.onnx, laya.onnx.data) already exist."
fi
echo -e "  ${GREEN}✓${NC} Model assets verified."

# --- Step 4: Build TypeScript MCP Server ---
echo -e "\n${BOLD}[4/6] Building TypeScript MCP Server...${NC}"
cd laya-mcp
npm install
npm run build
cd "$ROOT_DIR"
echo -e "  ${GREEN}✓${NC} TypeScript build complete."

# --- Step 5: Automated Smoke Test ---
echo -e "\n${BOLD}[5/6] Running automated verification smoke test...${NC}"
cd laya-mcp
npm test
cd "$ROOT_DIR"

# --- Step 6: Harness Registration & Skills Deployment ---
echo -e "\n${BOLD}[6/6] Registering AI Harnesses and Skills...${NC}"

# Run harness setup wizard
node laya-mcp/dist/index.js setup

# Register hardcoded PreToolUse decision interceptor hook
echo -e "  ${BLUE}Registering PreToolUse decision interceptor hook...${NC}"
node laya-mcp/dist/index.js hook:install

# Prompt for skills symlinks if skill directories exist
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
GEMINI_SKILLS_DIR="$HOME/.gemini/config/skills"

deploy_skills() {
    local target_dir="$1"
    local name="$2"
    if [ -d "$target_dir" ] || [ -d "$(dirname "$target_dir")" ]; then
        mkdir -p "$target_dir"
        echo -e "  ${BLUE}Linking skills to $name ($target_dir)...${NC}"
        for skill in laya-decision-model laya-security-policy laya-code-analysis; do
            if [ -d "skills/$skill" ]; then
                ln -sfn "$ROOT_DIR/skills/$skill" "$target_dir/$skill"
                echo -e "    ${GREEN}✓${NC} Linked $skill"
            fi
        done
    fi
}

deploy_skills "$GEMINI_SKILLS_DIR" "Antigravity/Gemini"
deploy_skills "$CLAUDE_SKILLS_DIR" "Claude Code"

echo -e "\n${BOLD}${GREEN}"
echo "================================================================================"
echo "🎉 Laya ONNX MCP Server successfully installed, configured, and verified!"
echo "================================================================================"
echo -e "${NC}"
echo -e "Next steps:"
echo -e "  • Open your AI harness (Cursor, Claude Desktop, Antigravity, etc.) to use Laya tools."
echo -e "  • Start local network mode:   ${BOLD}./start_local.sh${NC}   (SSE on port 3000)"
echo -e "  • Start internet remote mode:  ${BOLD}./start_remote.sh${NC}  (Localtunnel)"
echo -e "  • Run full evaluation suite:   ${BOLD}cd laya-mcp && npm run test:eval${NC}"
echo ""
