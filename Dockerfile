FROM node:20-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built application, client files, and templates
COPY dist/ ./dist/
COPY src/client/ ./src/client/
COPY templates/ ./templates/

# Create workspace directory (will be overwritten by volume mount)
RUN mkdir -p /app/workspace

# Expose port
EXPOSE 8000

# Set environment defaults
ENV PORT=8000
ENV WORKSPACE_PATH=/app/workspace

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/api/board', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run the server
CMD ["node", "dist/server/index.js"]
