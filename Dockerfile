FROM node:20-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy built application and client files
COPY dist/ ./dist/
COPY src/client/ ./src/client/

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 8000

# Set environment defaults
ENV PORT=8000
ENV WORKSPACE_PATH=/app/workspace
ENV DATA_PATH=/app/data

# Run the server
CMD ["node", "dist/server/index.js"]
