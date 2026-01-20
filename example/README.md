# Example Project

This is a sample project for testing AgentRunner.

## Purpose

This folder serves as a test workspace for:
- Running automated tests against AgentRunner
- Demonstrating how AgentRunner manages tasks
- CI/CD verification

## Structure

When AgentRunner runs against this workspace, it will create:

```
example/
├── README.md          # This file
├── .agentrunner/      # Created by AgentRunner
│   ├── board.json     # Kanban board state
│   └── tasks/         # Task documentation folders
└── [agent outputs]    # Files created by agent tasks
```

## Usage

```bash
# Run AgentRunner with this example workspace
WORKSPACE_PATH=./example npm run dev

# Or with Docker
docker run -p 8000:8000 -v $(pwd)/example:/app/workspace agentrunner
```
