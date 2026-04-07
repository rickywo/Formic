#!/usr/bin/env node
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// ==================== Constants ====================

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Templates directory is 2 levels up from dist/cli/ → templates/plugin/
const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates', 'plugin');

const TEMPLATE_FILES: Array<{ template: string; output: string; subdir?: string }> = [
  { template: 'package.json.template', output: 'package.json' },
  { template: 'tsconfig.json.template', output: 'tsconfig.json' },
  { template: 'manifest.json.template', output: 'manifest.json' },
  { template: 'src-index.ts.template', output: 'index.ts', subdir: 'src' },
  { template: 'README.md.template', output: 'README.md' },
];

// ==================== Utilities ====================

/**
 * Convert a kebab-case name to PascalCase
 */
function toPascalCase(name: string): string {
  return name
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Validate a plugin name (kebab-case, no special chars)
 */
function isValidPluginName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/**
 * Check whether a directory exists at the given path.
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace template placeholders with actual values.
 */
function applyPlaceholders(
  content: string,
  vars: { name: string; Name: string; description: string; author: string },
): string {
  let result = content;
  result = result.replaceAll('{{name}}', vars.name);
  result = result.replaceAll('{{Name}}', vars.Name);
  result = result.replaceAll('{{description}}', vars.description);
  result = result.replaceAll('{{author}}', vars.author);
  return result;
}

// ==================== Interactive Prompts ====================

/**
 * Prompt the user for a single line of text via stdin/stdout.
 * Returns the trimmed response.
 */
function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? ` (${defaultValue})` : '';

  return new Promise<string>((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || '');
    });
  });
}

/**
 * Prompt for the plugin name interactively, validating kebab-case.
 */
async function promptPluginName(): Promise<string> {
  let name = '';
  while (!name) {
    const input = await prompt('Plugin name (kebab-case, e.g. my-plugin)');
    if (!input) {
      process.stdout.write('Plugin name is required.\n');
      continue;
    }
    if (!isValidPluginName(input)) {
      process.stdout.write('Invalid name. Must be lowercase kebab-case (e.g. my-plugin).\n');
      continue;
    }
    name = input;
  }
  return name;
}

// ==================== Argument Parsing ====================

interface CliArgs {
  name?: string;
  description?: string;
  author?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  const raw = argv.slice(2); // skip node + script

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--name':
        args.name = raw[++i];
        break;
      case '--description':
        args.description = raw[++i];
        break;
      case '--author':
        args.author = raw[++i];
        break;
      default:
        // If the first positional argument is provided, treat it as the name
        if (!args.name && !arg.startsWith('-')) {
          args.name = arg;
        }
        break;
    }
  }

  return args;
}

function printHelp(): void {
  process.stdout.write(`
formic-sdk create-plugin — Scaffold a new Formic plugin project

Usage:
  formic-sdk create-plugin [name] [options]
  npx @rickywo/formic-sdk create-plugin [name] [options]

Options:
  --name <name>             Plugin name in kebab-case (e.g. my-plugin)
  --description <desc>      Short description of the plugin
  --author <author>         Author name
  -h, --help                Show this help message

Examples:
  formic-sdk create-plugin my-plugin
  formic-sdk create-plugin --name my-plugin --description "A cool plugin" --author "Dev"

If flags are omitted, you will be prompted interactively.
`);
}

// ==================== Scaffold Logic ====================

async function scaffold(pluginName: string, description: string, author: string): Promise<void> {
  const outputDir = path.resolve(process.cwd(), `formic-plugin-${pluginName}`);

  // Check if output directory already exists
  if (await directoryExists(outputDir)) {
    process.stderr.write(`[CreatePlugin] Error: Directory already exists: ${outputDir}\n`);
    process.exit(1);
  }

  // Verify templates exist
  if (!(await directoryExists(TEMPLATES_DIR))) {
    process.stderr.write(
      '[CreatePlugin] Error: Template files not found. Your @rickywo/formic-sdk installation may be incomplete.\n',
    );
    process.exit(1);
  }

  const pascalName = toPascalCase(pluginName);
  const vars = {
    name: pluginName,
    Name: pascalName,
    description,
    author,
  };

  // Create output directory and src/ subdirectory
  await mkdir(path.join(outputDir, 'src'), { recursive: true });

  // Process each template
  for (const { template, output, subdir } of TEMPLATE_FILES) {
    const templatePath = path.join(TEMPLATES_DIR, template);
    let content: string;

    try {
      content = await readFile(templatePath, 'utf-8');
    } catch {
      process.stderr.write(`[CreatePlugin] Error: Failed to read template: ${template}\n`);
      process.exit(1);
    }

    content = applyPlaceholders(content, vars);

    const outputPath = subdir
      ? path.join(outputDir, subdir, output)
      : path.join(outputDir, output);

    await writeFile(outputPath, content, 'utf-8');
  }

  // Success output
  process.stdout.write(`
Plugin "${pluginName}" created successfully!
  Location: ${outputDir}

Files created:
  package.json     — Node.js package with TypeScript and formic-sdk
  tsconfig.json    — TypeScript configuration (ES2022, strict)
  manifest.json    — Plugin metadata and permissions
  src/index.ts     — Plugin class implementing FormicPlugin
  README.md        — Plugin documentation

Next steps:
  1. cd formic-plugin-${pluginName}
  2. npm install
  3. npm run build
  4. Copy to your Formic workspace:
     cp -r . /path/to/project/.formic/plugins/${pluginName}
  5. Restart the Formic server to load the plugin
`);
}

// ==================== Main ====================

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Resolve plugin name
  let pluginName = args.name;
  if (pluginName) {
    if (!isValidPluginName(pluginName)) {
      process.stderr.write(
        '[CreatePlugin] Error: Plugin name must be lowercase kebab-case (e.g. my-plugin)\n',
      );
      process.exit(1);
    }
  } else {
    pluginName = await promptPluginName();
  }

  // Resolve description
  const description = args.description ?? await prompt('Description', 'A Formic plugin');

  // Resolve author
  const author = args.author ?? await prompt('Author', 'Unknown');

  // Scaffold the plugin
  await scaffold(pluginName, description, author);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  process.stderr.write(`[CreatePlugin] Error: ${message}\n`);
  process.exit(1);
});
