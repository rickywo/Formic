# Formic v0.9.0 - Multi-Provider Agents & Hardened Publishing

**The Local-First Agent Orchestration Environment**

*Vibe Coding with autonomous agents. Your repo, your rules, their labor.*

---

## Highlights

This release makes Formic **provider-agnostic** and **safe to distribute**. You can
now choose between three AI coding backends — Claude Code, GitHub Copilot, and
OpenCode — directly from the Kanban header, pick a specific model per workflow
step, and deploy Formic as hardened npm and Docker artifacts.

Two big themes:

1. **Multi-provider agent selection** — switch the active AI provider from the
   UI (availability-aware), with per-step model overrides.
2. **Hardened release & publishing** — non-root digest-pinned Docker images,
   read-only container filesystem, timing-safe auth, authenticated Telegram
   webhooks, npm provenance publishing, and a scan-before-push release pipeline.

**Install / Update:**
```bash
npm install -g @rickywo/formic@0.9.0
```

**Docker (Docker Hub):**
```bash
docker pull docker.io/rickywo/formic:0.9.0
```

---

## What's New

### OpenCode Agent Integration
- Added **OpenCode** as a third supported agent backend alongside Claude Code
  and GitHub Copilot (`agentAdapter.ts`, `outputParser.ts`).
- Dedicated write-capable (`formic-executor`) and read-only (`formic-readonly`)
  agent profiles are materialized at startup so workflow execution and the
  read-only Task Manager persona stay isolated.
- Install: `npm install -g opencode-ai` — auth via `opencode auth login`.

### Selectable AI Provider from the Kanban UI
- A new **availability-aware provider switcher** in the board header lets you
  change the active agent without restarting the server. Providers whose CLI is
  not installed are shown but disabled, with an install hint.
- Precedence: **UI selection > `AGENT_TYPE` env var > `claude` default**. The
  env var remains a headless/startup fallback.
- Switching providers with active or queued tasks prompts for confirmation;
  in-flight steps finish under the provider they started with.

### Per-Step Model Selection
- Configure a specific model per workflow step (brief, plan, declare, execute,
  reflect) per provider from **Settings → Agent Models**.
- Model choices persist in `~/.formic/config.json` and are threaded through the
  workflow, runner, assistant, and messaging spawns.

### Hardened Docker Images (now on Docker Hub)
- Images moved to **Docker Hub** (`docker.io/rickywo/formic`).
- Runtime image: `node:22-slim` pinned by digest, runs as the non-root `node`
  user, agent CLIs pinned by exact version, no `curl | bash` pipelines, secrets
  are runtime-only, and it defaults to loopback binding.
- New **dev-container image** (`0.9.0-devcontainer`) for interactive use, on
  `node:22-bookworm` with **no sudoers entry**.
- `docker-compose.yml` adds a read-only root filesystem, `no-new-privileges`,
  a tmpfs `/tmp`, and a persistent `/home/node` volume for agent CLI state.

### Security Fixes
- **Timing-safe auth**: the `FORMIC_AUTH_TOKEN` bearer check now uses a
  constant-time comparison (`src/server/utils/security.ts`).
- **Authenticated Telegram webhooks**: incoming updates must carry the
  registered `X-Telegram-Bot-Api-Secret-Token` (validated constant-time);
  the secret is env-configurable or auto-generated and persisted with `0600`.
- **Unauthenticated health endpoint**: `GET /api/health` is exempt from auth so
  the Docker health check works under `HOST=0.0.0.0` without leaking data.

### Release Pipeline & Tooling
- `.github/workflows/release.yml`: tag-triggered pipeline with gitleaks secret
  scanning, an npm tarball allowlist audit (`scripts/auditNpmPack.mjs`), npm
  publish with provenance, hadolint, and **Trivy scan-before-push** to Docker
  Hub for both images.
- New **interactive release script** (`scripts/release.sh`) for maintainers who
  prefer to publish locally and enter npm 2FA / Docker Hub login interactively.

---

## Upgrade Notes

- Docker images are now published to **Docker Hub** (`docker.io/rickywo/formic`)
  instead of GitHub Container Registry. Update any pinned image references.
- If you deploy on a non-loopback host, `FORMIC_AUTH_TOKEN` is still required;
  point health checks at `/api/health`.
- Telegram webhook users should set `TELEGRAM_WEBHOOK_SECRET` (or let Formic
  generate one) and re-register the webhook so the secret token is applied.

---

## Full Changelog

See `git log v0.8.0..v0.9.0`. Headline commits: OpenCode integration,
multi-provider UI, model selection, and the Docker/npm publishing hardening.
