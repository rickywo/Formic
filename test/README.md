# AgentRunner Tests

Automated tests for AgentRunner using Playwright and Python.

## Prerequisites

```bash
# Install Python dependencies
pip install playwright requests

# Install Playwright browsers
python -m playwright install chromium
```

## Running Tests

### 1. Start AgentRunner

```bash
# From the project root, start with the example workspace
WORKSPACE_PATH=./example npm run dev
```

### 2. Run Tests

```bash
# Run all tests
python test/run_tests.py

# Run individual test suites
python test/test_api.py          # API tests only
python test/test_agentrunner.py  # UI tests only
```

## Test Suites

### test_api.py
Tests the REST API endpoints:
- `GET /api/board` - Retrieve board state
- `POST /api/tasks` - Create a new task
- `PUT /api/tasks/:id` - Update a task
- `DELETE /api/tasks/:id` - Delete a task

### test_agentrunner.py
Tests the web UI using Playwright:
- Page load and title
- Kanban column structure
- Task creation via modal
- Task card content display
- Task deletion with confirmation

## CI/CD Integration

For CI environments, use the example workspace:

```bash
# Build and start server
npm run build
WORKSPACE_PATH=./example node dist/server/index.js &

# Wait for server to be ready
sleep 5

# Run tests
python test/run_tests.py
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENTRUNNER_URL` | Base URL for tests | `http://localhost:8000` |
