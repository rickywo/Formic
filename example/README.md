# Example Project

This is a sample project for testing Formic.

## Purpose

This folder serves as a test workspace for:
- Running automated tests against Formic
- Demonstrating how Formic manages tasks
- CI/CD verification

## Structure

When Formic runs against this workspace, it will create:

```
example/
├── README.md          # This file
├── .formic/      # Created by Formic
│   ├── board.json     # Kanban board state
│   └── tasks/         # Task documentation folders
└── [agent outputs]    # Files created by agent tasks
```

## Usage

```bash
# Run Formic with this example workspace
WORKSPACE_PATH=./example npm run dev

# Or with Docker
docker run -p 8000:8000 -v $(pwd)/example:/app/workspace formic
```
