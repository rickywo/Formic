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

## Test Objective Feature

This project includes a mock **objective tracking API** that simulates a lightweight task/goal management system. It is used to demonstrate and test Formic's ability to manage REST API-backed workflows.

### Data Model

**`TestObjective`**

| Field         | Type                              | Description                        |
|---------------|-----------------------------------|------------------------------------|
| `id`          | `string`                          | Unique identifier (auto-generated) |
| `title`       | `string`                          | Short name for the objective       |
| `description` | `string`                          | Detailed description               |
| `status`      | `'todo' \| 'in_progress' \| 'done'` | Current status of the objective  |

**`TestObjectiveStatus` enum values:** `todo`, `in_progress`, `done`

### Endpoints

| Method   | Path                          | Description                         |
|----------|-------------------------------|-------------------------------------|
| `GET`    | `/api/test-objectives`        | List all test objectives            |
| `POST`   | `/api/test-objectives`        | Create a new test objective         |
| `DELETE` | `/api/test-objectives/:id`    | Delete a test objective by ID       |

### Example

**Request — `POST /api/test-objectives`**

```json
{
  "title": "Implement login page",
  "description": "Build the user-facing login form with JWT authentication",
  "status": "todo"
}
```

**Response — `201 Created`**

```json
{
  "id": "obj-1a2b3c",
  "title": "Implement login page",
  "description": "Build the user-facing login form with JWT authentication",
  "status": "todo"
}
```
