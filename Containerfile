# ==============================================================================
# Laya ONNX MCP — Rootless Sandboxed Containerfile
# ==============================================================================
# Multi-stage secure build running as unprivileged non-root user (uid 1000).
# Designed for execution with: podman run --cap-drop all --security-opt no-new-privileges
# ==============================================================================

FROM python:3.13-slim-bookworm AS base

# Install Node.js 20 & Tree-Sitter CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g tree-sitter-cli \
    && rm -rf /var/lib/apt/lists/*

# Create unprivileged application user
RUN useradd -m -u 1000 -s /bin/bash laya

WORKDIR /app

# Install Python policy engine dependencies
COPY pyproject.toml /app/
RUN pip install --no-cache-dir \
    fastapi>=0.110.0 \
    uvicorn>=0.29.0 \
    pydantic>=2.9.0 \
    transformers>=4.40.0 \
    onnxruntime>=1.31.0 \
    numpy

# Build TypeScript MCP Server
COPY laya-mcp/package*.json /app/laya-mcp/
WORKDIR /app/laya-mcp
RUN npm ci

COPY laya-mcp/ /app/laya-mcp/
RUN npm run build

# Copy runtime, configuration, and hooks
WORKDIR /app
COPY laya_runtime/ /app/laya_runtime/
COPY laya_config.json /app/
COPY hooks/ /app/hooks/
COPY skills/ /app/skills/

# Set ownership to unprivileged user
RUN chown -R laya:laya /app

# Default workspace mount point
WORKDIR /workspace
RUN chown laya:laya /workspace

USER laya

ENV LAYA_HOME=/app
ENV ALLOWED_DIR=/workspace
ENV HOST=127.0.0.1
ENV PORT=3000

# Default: start stdio MCP server for agent harnesses
ENTRYPOINT ["node", "/app/laya-mcp/dist/index.js"]
