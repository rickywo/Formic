#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Package root is 2 levels up from dist/cli or src/cli
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Get package version from package.json
 */
async function getVersion(): Promise<string> {
  try {
    const packageJsonPath = path.join(PACKAGE_ROOT, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Load .env file from workspace directory
 */
async function loadEnvFile(workspacePath: string): Promise<void> {
  const envPath = path.join(workspacePath, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  try {
    const envContent = await readFile(envPath, 'utf-8');
    const lines = envContent.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, equalIndex).trim();
      let value = trimmed.slice(equalIndex + 1).trim();

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Only set if not already defined in environment
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    console.log('Loaded environment from .env file');
  } catch (error) {
    console.warn('Warning: Could not load .env file:', (error as Error).message);
  }
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
Formic - Local-first agent orchestration and execution environment

Usage:
  formic <command> [options]

Commands:
  init              Initialize Formic in the current directory
  start             Start the Formic server

Options:
  -p, --port <n>    Port to run the server on (default: 8000)
  -h, --help        Show this help message
  -v, --version     Show version number

Examples:
  formic init                    Initialize Formic in current directory
  formic start                   Start server on default port (8000)
  formic start --port 3000       Start server on port 3000

Environment Variables:
  PORT              Server port (default: 8000)
  HOST              Server host (default: 0.0.0.0)
  AGENT_TYPE        Agent CLI type: 'claude' or 'copilot' (default: claude)
  ANTHROPIC_API_KEY API key for Claude agent

Documentation:
  https://github.com/anthropics/formic
`);
}

/**
 * Initialize Formic in the current directory
 */
async function initCommand(): Promise<void> {
  const workspacePath = process.cwd();
  const formicDir = path.join(workspacePath, '.formic');

  if (existsSync(formicDir)) {
    console.log('Formic is already initialized in this directory.');
    console.log(`  .formic directory exists at: ${formicDir}`);
    console.log('\nRun "formic start" to launch the server.');
    return;
  }

  console.log('Initializing Formic...');

  // Create .formic directory
  await mkdir(formicDir, { recursive: true });

  // Create tasks directory
  const tasksDir = path.join(formicDir, 'tasks');
  await mkdir(tasksDir, { recursive: true });

  // Create initial board.json
  const projectName = path.basename(workspacePath);
  const board = {
    meta: {
      projectName,
      repoPath: workspacePath,
      createdAt: new Date().toISOString(),
    },
    tasks: [],
  };

  const boardPath = path.join(formicDir, 'board.json');
  await writeFile(boardPath, JSON.stringify(board, null, 2), 'utf-8');

  console.log('\nFormic initialized successfully!');
  console.log(`  Created: ${formicDir}`);
  console.log(`  Project: ${projectName}`);
  console.log('\nNext steps:');
  console.log('  1. Run "formic start" to launch the server');
  console.log('  2. Open http://localhost:8000 in your browser');
  console.log('  3. Create your first task and queue it for execution');
}

/**
 * Start the Formic server
 */
async function startCommand(port?: number): Promise<void> {
  const workspacePath = process.cwd();
  const formicDir = path.join(workspacePath, '.formic');

  // Check if Formic is initialized
  if (!existsSync(formicDir)) {
    console.error('Error: Formic is not initialized in this directory.');
    console.error('\nRun "formic init" first to set up Formic.');
    process.exit(1);
  }

  // Load .env file from workspace
  await loadEnvFile(workspacePath);

  // Dynamically import the server to avoid loading it for help/version commands
  const { startServer } = await import('../server/index.js');

  await startServer({
    port,
    workspacePath,
  });
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): { command: string; port?: number } {
  let command = '';
  let port: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      return { command: 'help' };
    }

    if (arg === '-v' || arg === '--version') {
      return { command: 'version' };
    }

    if (arg === '-p' || arg === '--port') {
      const portStr = args[i + 1];
      if (!portStr || portStr.startsWith('-')) {
        console.error('Error: --port requires a number');
        process.exit(1);
      }
      port = parseInt(portStr, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('Error: Invalid port number. Must be between 1 and 65535.');
        process.exit(1);
      }
      i++; // Skip next argument
      continue;
    }

    // First non-flag argument is the command
    if (!arg.startsWith('-') && !command) {
      command = arg;
    }
  }

  return { command, port };
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  // Skip node and script path
  const args = process.argv.slice(2);

  // Default to help if no arguments
  if (args.length === 0) {
    printHelp();
    return;
  }

  const { command, port } = parseArgs(args);

  switch (command) {
    case 'help':
      printHelp();
      break;

    case 'version': {
      const version = await getVersion();
      console.log(`formic v${version}`);
      break;
    }

    case 'init':
      await initCommand();
      break;

    case 'start':
      await startCommand(port);
      break;

    default:
      if (command) {
        console.error(`Error: Unknown command "${command}"`);
      }
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
