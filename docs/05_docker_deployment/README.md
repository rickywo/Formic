# Phase 6: Docker & Deployment

## Overview

Finalize the Docker containerization and deployment configuration for AgentRunner. This phase ensures the application can be easily deployed as a self-contained Docker container with optimized build artifacts and proper production settings.

## Goals

- Provide a production-ready Docker image that runs AgentRunner with minimal configuration
- Optimize the build process for smaller image size and faster startup
- Ensure the container works correctly with volume mounts for workspace access
- Document deployment procedures for end users

## Key Capabilities

- **Production Dockerfile**: Multi-stage build that compiles TypeScript and produces optimized output
- **Docker Compose**: Simple one-command deployment with environment variable configuration
- **Volume Mounting**: Seamless workspace mounting for project access
- **Environment Configuration**: All settings configurable via environment variables
- **Health Checks**: Container health monitoring for orchestration compatibility

## Non-Goals

- Kubernetes deployment manifests (defer to v2)
- CI/CD pipeline configuration
- Cloud-specific deployment (AWS, GCP, Azure)
- SSL/TLS termination (assume reverse proxy handles this)
- Multi-container orchestration
- Database migrations (no database in v1)

## Requirements

### Functional Requirements

- Docker image builds successfully with `docker build`
- Container starts and serves the application on configured port
- Workspace volume mount works correctly (`-v /path/to/project:/app/workspace`)
- ANTHROPIC_API_KEY environment variable is passed to Claude CLI
- Container gracefully shuts down on SIGTERM
- Application logs are visible via `docker logs`

### Technical Requirements

- Multi-stage Dockerfile to minimize final image size
- Node.js 20 slim base image
- Claude Code CLI pre-installed in container
- TypeScript compiled to JavaScript (no tsx in production)
- Static files copied to dist folder
- Non-root user for security (optional for v1)

### Build Optimization Requirements

- Separate dependency installation from code copy (layer caching)
- Production-only npm install (`npm ci --only=production`)
- Remove development artifacts from final image
- Target image size under 500MB

### Documentation Requirements

- README with quick start instructions
- Docker run command examples
- Docker Compose example file
- Environment variable documentation
- Troubleshooting guide for common issues
