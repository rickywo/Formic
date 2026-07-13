# ==============================================================================
# Formic — Hardened Headless Runtime Image
# ==============================================================================
# This image is for production/CI deployment. It runs as non-root, defaults to
# loopback-only binding, and contains only the prod dependencies needed to
# execute the Formic server and its agent CLIs.
#
# To update the base image digest, run:
#   docker pull node:22-slim
#   docker inspect node:22-slim --format='{{index .RepoDigests 0}}'
# ==============================================================================

FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

# ---------------------------------------------------------------------------
# Build arguments (NOT persisted as env — only used during build)
# ---------------------------------------------------------------------------
ARG DEBIAN_FRONTEND=noninteractive

# Agent CLI versions — pinned for reproducible builds.
# Bump these with a PR when new releases are validated.
ARG CLAUDE_CODE_VERSION=2.1.207
ARG OPENCODE_AI_VERSION=1.17.18
ARG FORMIC_VERSION=0.9.1

# ---------------------------------------------------------------------------
# OCI labels
# ---------------------------------------------------------------------------
LABEL org.opencontainers.image.source="https://github.com/rickywo/Formic" \
      org.opencontainers.image.version="${FORMIC_VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Formic — AI-powered task manager and agent orchestration platform (headless runtime)"

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
# git is required at runtime for auto-save commits during task execution.
# hadolint ignore=DL3008
# (pinned base image digest provides reproducibility; apt package version
# pinning would break on Debian point-release mirror churn.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Agent CLIs (globally installed, pinned by exact version)
# ---------------------------------------------------------------------------
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm install -g opencode-ai@${OPENCODE_AI_VERSION}

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the built application and the allowlisted runtime assets
COPY dist/ ./dist/
COPY src/client/ ./src/client/
COPY templates/ ./templates/
COPY skills/ ./skills/

# Create workspace directory
RUN mkdir -p /app/workspace

# ---------------------------------------------------------------------------
# Drop privileges — run as the existing 'node' user
# ---------------------------------------------------------------------------
RUN chown -R node:node /app
USER node

# ---------------------------------------------------------------------------
# Runtime configuration
# ---------------------------------------------------------------------------
EXPOSE 8000

# Default to loopback-only binding. A bare `docker run` without an explicit
# HOST=0.0.0.0 cannot expose an unauthenticated API — the server refuses to
# bind 0.0.0.0 unless FORMIC_AUTH_TOKEN is also set (enforced at startup).
ENV PORT=8000
ENV WORKSPACE_PATH=/app/workspace

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]

# ---------------------------------------------------------------------------
# Secrets are RUNTIME-ONLY. Never set these at build time:
#   ANTHROPIC_API_KEY     — required for Claude Code agent
#   FORMIC_AUTH_TOKEN     — required when binding HOST=0.0.0.0
#   TELEGRAM_BOT_TOKEN    — optional, for Telegram messaging
#   TELEGRAM_WEBHOOK_SECRET — optional, authenticates Telegram webhooks
#   LINE_CHANNEL_ACCESS_TOKEN — optional, for LINE messaging
#   LINE_CHANNEL_SECRET   — optional, for LINE messaging
#   OPENAI_API_KEY        — optional, for OpenCode with OpenAI provider
#   DEEPSEEK_API_KEY      — optional, for OpenCode with DeepSeek provider
# ---------------------------------------------------------------------------
