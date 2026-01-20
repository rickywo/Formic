# Phase 7: Project Bootstrap & Development Guidelines - Checklist

## Pre-Implementation
- [ ] README.md specification reviewed and approved
- [ ] Technical approach validated against existing codebase
- [ ] Dependencies identified (no new dependencies required)
- [ ] Test strategy defined (unit + integration + manual)
- [ ] Template file `templates/development-guideline.md` exists and is complete

## Backend Implementation

### Bootstrap Service
- [ ] `src/server/services/bootstrap.ts` created
- [ ] `checkBootstrapRequired()` function implemented
- [ ] `createBootstrapTask()` function implemented
- [ ] `getBootstrapPrompt()` function implemented
- [ ] Template reading from `templates/development-guideline.md` works

### Store Service Modifications
- [ ] `getBoard()` calls bootstrap detection
- [ ] Bootstrap task auto-created when needed
- [ ] `bootstrapRequired` field added to board response
- [ ] Bootstrap task not auto-recreated after deletion

### API Route Updates
- [ ] `GET /api/board` returns `bootstrapRequired` boolean
- [ ] `GET /api/board` returns `guidelinesPath` string or null

### Type Definitions
- [ ] `Board` interface updated with `bootstrapRequired` field
- [ ] Bootstrap task uses reserved ID `t-bootstrap`

## Frontend Implementation

### State Management
- [ ] Frontend parses `bootstrapRequired` from API response
- [ ] Bootstrap status stored in application state

### Visual Styling
- [ ] `.task-card--bootstrap` CSS class created
- [ ] Bootstrap task has distinct visual appearance
- [ ] "Bootstrap" or "Setup" badge displayed on task card
- [ ] Task description explains the audit process

### User Experience
- [ ] Bootstrap task clearly identifiable as system task
- [ ] Run button works on bootstrap task
- [ ] Delete button works on bootstrap task (for re-bootstrap)

## Docker & Deployment

### Dockerfile Updates
- [ ] `templates/` directory copied to container
- [ ] Template file accessible at runtime
- [ ] Build succeeds with new files

### Environment
- [ ] Works with `WORKSPACE_PATH` environment variable
- [ ] Works in both Docker and local development modes

## Testing

### Unit Tests
- [ ] `checkBootstrapRequired()` returns true when guidelines missing
- [ ] `checkBootstrapRequired()` returns false when guidelines exist
- [ ] `createBootstrapTask()` generates valid task object
- [ ] `getBootstrapPrompt()` includes template content

### Integration Tests
- [ ] New workspace triggers bootstrap task creation
- [ ] Existing workspace with guidelines skips bootstrap
- [ ] Bootstrap task execution generates guidelines file
- [ ] Re-bootstrap flow works after deleting guidelines

### Manual Verification
- [ ] Fresh project shows bootstrap task
- [ ] Bootstrap task visually distinct from regular tasks
- [ ] Running bootstrap creates `kanban-development-guideline.md`
- [ ] Restarting doesn't recreate bootstrap task
- [ ] Deleting guidelines and restarting creates new bootstrap task

## Quality Gates
- [ ] TypeScript compiles without errors
- [ ] No runtime errors in console
- [ ] API response structure matches specification
- [ ] Frontend renders without JavaScript errors
- [ ] Docker container starts and runs correctly

## Documentation
- [ ] README.md in docs/07 is complete
- [ ] PLAN.md in docs/07 is complete
- [ ] CHECKLIST.md in docs/07 is complete
- [ ] Main README.md updated with bootstrap feature
- [ ] SPEC.md updated with bootstrap specification
- [ ] API documentation includes new fields

## Final Verification
- [ ] End-to-end flow tested on fresh workspace
- [ ] End-to-end flow tested on existing workspace
- [ ] Re-bootstrap flow tested
- [ ] Docker deployment tested
- [ ] Local development tested

## Post-Implementation
- [ ] Code committed with meaningful message
- [ ] Phase 7 marked as complete in SPEC.md
- [ ] Status updated to COMPLETE in docs/07/README.md
