# Phase 1: Project Foundation - Implementation Plan

## Task 1: Initialize TypeScript Project

- [x] 1.1 Create `package.json` with project metadata
- [x] 1.2 Add production dependencies: `fastify`, `@fastify/static`, `@fastify/websocket`
- [x] 1.3 Add dev dependencies: `typescript`, `tsx`, `@types/node`, `@types/ws`
- [x] 1.4 Set Node.js engine requirement to `>=20.0.0`
- [x] 1.5 Add `"type": "module"` for ES modules

## Task 2: Configure TypeScript Compiler

- [x] 2.1 Create `tsconfig.json`
- [x] 2.2 Set target to `ES2022`
- [x] 2.3 Set module system to `NodeNext`
- [x] 2.4 Enable strict mode
- [x] 2.5 Configure output directory to `dist/`
- [x] 2.6 Configure root directory to `src/`
- [x] 2.7 Enable source maps and declarations

## Task 3: Set Up Development Scripts

- [x] 3.1 Add `dev` script using `tsx watch`
- [x] 3.2 Add `build` script using `tsc`
- [x] 3.3 Add `start` script for production
- [x] 3.4 Add `clean` script to remove build artifacts

## Task 4: Create Fastify Server Entry Point

- [x] 4.1 Create `src/server/index.ts`
- [x] 4.2 Initialize Fastify instance with logger
- [x] 4.3 Register `@fastify/static` for serving client files
- [x] 4.4 Register `@fastify/websocket` (for future phases)
- [x] 4.5 Add `GET /health` endpoint returning `{ status: "ok" }`
- [x] 4.6 Configure server to listen on PORT env var (default: 8000)
- [x] 4.7 Configure server to bind to HOST env var (default: 0.0.0.0)
- [x] 4.8 Fix static file path resolution for both dev and production

## Task 5: Create Shared Type Definitions

- [x] 5.1 Create `src/types/index.ts`
- [x] 5.2 Define `TaskStatus` type: `'todo' | 'running' | 'review' | 'done'`
- [x] 5.3 Define `TaskPriority` type: `'low' | 'medium' | 'high'`
- [x] 5.4 Define `Task` interface with all fields
- [x] 5.5 Define `BoardMeta` interface
- [x] 5.6 Define `Board` interface
- [x] 5.7 Define `CreateTaskInput` interface
- [x] 5.8 Define `UpdateTaskInput` interface
- [x] 5.9 Define `LogMessage` interface

## Task 6: Create Placeholder Frontend

- [x] 6.1 Create `src/client/index.html`
- [x] 6.2 Add basic HTML structure
- [x] 6.3 Verify static file serving works

## Task 7: Verification

- [x] 7.1 Run `npm install` to install dependencies
- [x] 7.2 Run `npm run dev` and verify server starts
- [x] 7.3 Verify `GET /health` returns `{ status: "ok" }`
- [x] 7.4 Verify static file serving at `http://localhost:8000/`
- [x] 7.5 Run `npm run build` and verify compilation succeeds
- [x] 7.6 Run `npm start` and verify production server starts
