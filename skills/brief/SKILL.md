---
description: Generates a feature specification (README.md) for an AgentRunner task.
---

# Brief Skill - Generate Task Specification

You are a senior Technical Project Manager. Your task is to generate a feature specification document for the following task.

**Task Title:** $TASK_TITLE

**Task Context/Description:**
$TASK_CONTEXT

**Output Location:** $TASK_DOCS_PATH/README.md

---

## Instructions

1. First, explore the project codebase to understand:
   - The tech stack and frameworks used
   - Existing architectural patterns
   - Coding conventions and standards
   - If `kanban-development-guideline.md` exists, read it for project-specific rules

2. Generate a README.md file with the following structure:

```markdown
# [Task Title]

## Overview
[A brief 2-3 sentence introduction to what this task accomplishes and why it's needed.]

## Goals
- [Primary objective 1]
- [Primary objective 2]
- [Primary objective 3]

## Key Capabilities
- [Main functionality 1]
- [Main functionality 2]
- [Main functionality 3]

## Non-Goals
- [What is explicitly out of scope 1]
- [What is explicitly out of scope 2]

## Requirements
- [Technical requirement 1]
- [Technical requirement 2]
- [Non-technical requirement if applicable]
```

3. Write the generated content to: $TASK_DOCS_PATH/README.md

---

## Guidelines

- Focus on the 'what' and 'why', NOT the 'how' (implementation details come in PLAN.md)
- Be specific to this project's context - reference actual files, patterns, or conventions you discover
- Keep it concise - each section should have 3-5 bullet points maximum
- Goals should be measurable outcomes
- Non-Goals help prevent scope creep
- Requirements should be verifiable

---

## Output

Write the README.md file to the specified path. Do not output anything else.
