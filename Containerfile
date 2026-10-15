# ==============================================================================
# Laya ONNX MCP — Rootless Sandboxed Multi-Stage Containerfile
# ==============================================================================
# Stage 1: Build environment for TypeScript compilation and Python virtualenv
# Stage 2: Minimal runtime image running as unprivileged user 'laya' (UID 1000)
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Builder
# ------------------------------------------------------------------------------
FROM python:3.13-slim-bookworm AS builder

# Install build dependencies and Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Build isolated Python virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY pyproject.toml /build/
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir \
    "fastapi>=0.110.0" \
    "uvicorn>=0.29.0" \
    "pydantic>=2.9.0" \
    "transformers>=4.40.0" \
    "onnxruntime>=1.20.0" \
    "numpy"

# Build TypeScript MCP Server
WORKDIR /build/laya-mcp
COPY laya-mcp/package*.json ./
RUN npm ci

COPY laya-mcp/tsconfig.json ./
COPY laya-mcp/src/ ./src/
RUN npm run build && npm prune --production

# ------------------------------------------------------------------------------
# Stage 2: Minimal Sandboxed Runtime
# ------------------------------------------------------------------------------
FROM python:3.13-slim-bookworm AS runtime

# Install Node.js runtime and tree-sitter CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g tree-sitter-cli \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Create unprivileged application user
RUN useradd -m -u 1000 -s /bin/bash laya

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Copy built MCP artifacts from builder
COPY --from=builder --chown=laya:laya /build/laya-mcp/dist /app/laya-mcp/dist
COPY --from=builder --chown=laya:laya /build/laya-mcp/node_modules /app/laya-mcp/node_modules
COPY --from=builder --chown=laya:laya /build/laya-mcp/package.json /app/laya-mcp/package.json

# Copy policy engine, config, skills, and hooks
COPY --chown=laya:laya laya_runtime/ /app/laya_runtime/
COPY --chown=laya:laya laya_config.json /app/laya_config.json
COPY --chown=laya:laya hooks/ /app/hooks/
COPY --chown=laya:laya skills/ /app/skills/

# Set up runtime directories
RUN mkdir -p /workspace /app/.cache /tmp && \
    chown -R laya:laya /workspace /app /tmp

USER laya

ENV LAYA_HOME=/app
ENV ALLOWED_DIR=/workspace
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /workspace

EXPOSE 3000

ENTRYPOINT ["node", "/app/laya-mcp/dist/index.js"]
