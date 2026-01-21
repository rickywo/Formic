# Phase 6: Docker & Deployment - Implementation Plan

## Status
**IN PROGRESS** - Basic Dockerfile exists, optimization and documentation needed.

## Implementation Summary

A basic Dockerfile exists that builds and runs the application. Remaining work includes build optimization, docker-compose setup, and deployment documentation.

---

## Phase 6.1: Dockerfile Foundation (COMPLETE)

- [x] 6.1.1 Create Dockerfile with Node.js 20 slim base
- [x] 6.1.2 Install Claude Code CLI globally
- [x] 6.1.3 Copy package files and install dependencies
- [x] 6.1.4 Copy compiled dist/ and client files
- [x] 6.1.5 Set environment variable defaults (PORT, WORKSPACE_PATH)
- [x] 6.1.6 Expose port 8000
- [x] 6.1.7 Set CMD to run production server

**Implementation:** `Dockerfile`

---

## Phase 6.2: Build Optimization

- [ ] 6.2.1 Create .dockerignore file to exclude unnecessary files
- [ ] 6.2.2 Convert to multi-stage build (build stage + production stage)
- [ ] 6.2.3 Remove DATA_PATH env (no longer used - workspace-based storage)
- [ ] 6.2.4 Add HEALTHCHECK instruction for container monitoring
- [ ] 6.2.5 Verify final image size is under 500MB
- [ ] 6.2.6 Test layer caching effectiveness

### .dockerignore contents needed:
```
node_modules
dist
*.log
.git
.gitignore
docs
test_proj
workspace
*.md
!README.md
```

### Multi-stage Dockerfile structure:
```dockerfile
# Build stage
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/client ./src/client
...
```

---

## Phase 6.3: Docker Compose Setup

- [ ] 6.3.1 Create docker-compose.yml file
- [ ] 6.3.2 Define formic service
- [ ] 6.3.3 Configure volume mount for workspace
- [ ] 6.3.4 Set up environment variables (ANTHROPIC_API_KEY)
- [ ] 6.3.5 Configure port mapping
- [ ] 6.3.6 Test docker-compose up workflow

### docker-compose.yml structure:
```yaml
version: '3.8'
services:
  formic:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - ${WORKSPACE_PATH:-./workspace}:/app/workspace
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

---

## Phase 6.4: Testing & Verification

- [ ] 6.4.1 Build Docker image successfully
- [ ] 6.4.2 Run container and verify server starts
- [ ] 6.4.3 Test workspace volume mount
- [ ] 6.4.4 Verify API endpoints work from container
- [ ] 6.4.5 Test agent execution (requires Claude CLI + API key)
- [ ] 6.4.6 Verify graceful shutdown on SIGTERM
- [ ] 6.4.7 Check docker logs output

---

## Phase 6.5: Documentation

- [x] 6.5.1 README.md with project overview
- [x] 6.5.2 SPEC.md with full technical specification
- [ ] 6.5.3 Add Docker quick start to README.md
- [ ] 6.5.4 Document all environment variables
- [ ] 6.5.5 Add troubleshooting section
- [ ] 6.5.6 Include example docker run commands

---

## Remaining Work Summary

### Required for MVP
1. Create .dockerignore
2. Create docker-compose.yml
3. Update README.md with Docker instructions
4. Test full Docker workflow

### Nice to Have (Optional)
- Multi-stage build optimization
- Health check endpoint
- Non-root user in container
- Image size optimization
