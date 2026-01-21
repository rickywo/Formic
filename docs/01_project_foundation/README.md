# Phase 1: Project Foundation

## Status
**COMPLETE** - All foundational components implemented.

## Overview

Establish the core TypeScript project structure and development environment for Formic. This phase creates the foundational server configuration and type definitions that all subsequent phases will build upon.

## Goals

- Initialize a TypeScript project with proper compilation settings
- Configure Fastify server with static file serving
- Set up development scripts (dev, build, start)
- Create shared type definitions for Board and Task models

## Key Capabilities

- TypeScript compilation targeting ES2022 with NodeNext modules
- Fastify server listening on configurable port (default: 8000)
- Static file serving from `src/client/` directory
- Shared type definitions exported from `src/types/index.ts`
- Hot-reload development mode via `tsx watch`

## Non-Goals

- Task CRUD API endpoints
- JSON file persistence logic
- Process spawning or agent execution
- WebSocket connections
- Frontend UI beyond placeholder HTML

## Requirements

- Node.js >= 20.0.0
- TypeScript 5.x with strict mode
- Fastify 4.x with `@fastify/static` plugin
- Working npm scripts: `dev`, `build`, `start`, `clean`
- Server responds to `GET /health` with `{ status: "ok" }`
- Project compiles without TypeScript errors

## Implementation Summary

### Files Created

| File | Purpose |
|------|---------|
| `package.json` | Project manifest with dependencies and scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `src/server/index.ts` | Fastify server entry point |
| `src/types/index.ts` | Shared type definitions |
| `src/client/index.html` | Placeholder frontend |

### Dependencies Installed

- `fastify` - Web framework
- `@fastify/static` - Static file serving
- `@fastify/websocket` - WebSocket support (registered for future phases)
- `typescript` - TypeScript compiler
- `tsx` - Development runner with hot-reload
- `@types/node` - Node.js type definitions

### NPM Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch src/server/index.ts` | Development with hot-reload |
| `build` | `tsc` | Compile TypeScript to JavaScript |
| `start` | `node dist/server/index.js` | Run production build |
| `clean` | `rm -rf dist` | Remove build artifacts |
