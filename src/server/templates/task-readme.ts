/**
 * Generate README.md content for a task documentation folder
 */
export function generateTaskReadme(title: string, context: string): string {
  return `# ${title}

## Overview

${context}

## Goals

- [ ] Define specific goals here

## Key Capabilities

- Describe what this task will accomplish

## Non-Goals

- What is explicitly out of scope

## Requirements

- List technical and functional requirements
`;
}
