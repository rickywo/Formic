# Phase 7: Project Bootstrap & Development Guidelines - Checklist

## Pre-Implementation
- [x] README.md specification reviewed and approved
- [x] Technical approach validated against existing codebase
- [x] Dependencies identified (no new dependencies required)
- [x] Test strategy defined (unit + integration + manual)
- [x] Template file `templates/development-guideline.md` exists and is complete

## Backend Implementation

### Bootstrap Service
- [x] `src/server/services/bootstrap.ts` created
- [x] `checkBootstrapRequired()` function implemented
- [x] `createBootstrapTask()` function implemented
- [x] `getBootstrapPrompt()` function implemented
- [x] Template reading from `templates/development-guideline.md` works

### Store Service Modifications
- [x] `getBoard()` calls bootstrap detection
- [x] Bootstrap task auto-created when needed
- [x] `bootstrapRequired` field added to board response
- [x] Bootstrap task not auto-recreated after deletion

### API Route Updates
- [x] `GET /api/board` returns `bootstrapRequired` boolean
- [x] `GET /api/board` returns `guidelinesPath` string or null

### Type Definitions
- [x] `Board` interface updated with `bootstrapRequired` field
- [x] Bootstrap task uses reserved ID `t-bootstrap`

## Frontend Implementation

### State Management
- [x] Frontend parses `bootstrapRequired` from API response
- [x] Bootstrap status stored in application state

### Visual Styling
- [x] `.task-card--bootstrap` CSS class created
- [x] Bootstrap task has distinct visual appearance
- [x] "Bootstrap" or "Setup" badge displayed on task card
- [x] Task description explains the audit process

### User Experience
- [x] Bootstrap task clearly identifiable as system task
- [x] Run button works on bootstrap task
- [x] Delete button works on bootstrap task (for re-bootstrap)

## Docker & Deployment

### Dockerfile Updates
- [x] `templates/` directory copied to container
- [x] Template file accessible at runtime
- [x] Build succeeds with new files

### Environment
- [x] Works with `WORKSPACE_PATH` environment variable
- [x] Works in both Docker and local development modes

## Testing

### Unit Tests
- [x] `checkBootstrapRequired()` returns true when guidelines missing
- [x] `checkBootstrapRequired()` returns false when guidelines exist
- [x] `createBootstrapTask()` generates valid task object
- [x] `getBootstrapPrompt()` includes template content

### Integration Tests
- [x] New workspace triggers bootstrap task creation
- [x] Existing workspace with guidelines skips bootstrap
- [x] Bootstrap task execution generates guidelines file
- [x] Re-bootstrap flow works after deleting guidelines

### Manual Verification
- [x] Fresh project shows bootstrap task
- [x] Bootstrap task visually distinct from regular tasks
- [x] Running bootstrap creates `kanban-development-guideline.md`
- [x] Restarting doesn't recreate bootstrap task
- [x] Deleting guidelines and restarting creates new bootstrap task

## Quality Gates
- [x] TypeScript compiles without errors
- [x] No runtime errors in console
- [x] API response structure matches specification
- [x] Frontend renders without JavaScript errors
- [x] Docker container starts and runs correctly

## Documentation
- [x] README.md in docs/07 is complete
- [x] PLAN.md in docs/07 is complete
- [x] CHECKLIST.md in docs/07 is complete
- [x] Main README.md updated with bootstrap feature
- [x] SPEC.md updated with bootstrap specification
- [x] API documentation includes new fields

## Final Verification
- [x] End-to-end flow tested on fresh workspace
- [x] End-to-end flow tested on existing workspace
- [x] Re-bootstrap flow tested
- [x] Docker deployment tested
- [x] Local development tested

## Post-Implementation
- [x] Code committed with meaningful message
- [x] Phase 7 marked as complete in SPEC.md
- [x] Status updated to COMPLETE in docs/07/README.md
