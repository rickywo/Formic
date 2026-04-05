import { readFile, readdir, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Package root is 2 levels up from dist/cli or src/cli
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

const execFileAsync = promisify(execFile);

/**
 * Print plugin subcommand help
 */
function printPluginHelp(): void {
  console.log(`
Formic Plugin Management

Usage:
  formic plugin <subcommand> [options]

Subcommands:
  list              List installed plugins
  install <source>  Install a plugin from a local path or git URL
  remove <name>     Remove an installed plugin
  enable <name>     Enable a plugin
  disable <name>    Disable a plugin
  create <name>     Scaffold a new plugin from template

Examples:
  formic plugin list
  formic plugin install ./my-plugin
  formic plugin install https://github.com/user/formic-plugin.git
  formic plugin create my-plugin
  formic plugin enable my-plugin
  formic plugin disable my-plugin
  formic plugin remove my-plugin
`);
}

/**
 * Get the plugins directory path for the current workspace
 */
function getPluginsDir(): string {
  return path.join(process.cwd(), '.formic', 'plugins');
}

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
 * Read and parse a manifest.json from a plugin directory.
 * Returns null if the manifest is missing or invalid.
 */
async function readManifest(pluginDir: string): Promise<PluginManifest | null> {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const data = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(data) as PluginManifest;
    if (!parsed.name || !parsed.version) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Dynamically import configStore helpers.
 * Uses dynamic import so the CLI module doesn't eagerly load the full server.
 */
async function getConfigHelpers() {
  const configStore = await import('../server/services/configStore.js');
  return configStore;
}

// ==================== Subcommand Handlers ====================

/**
 * List installed plugins with status
 */
async function pluginList(): Promise<void> {
  const pluginsDir = getPluginsDir();

  if (!existsSync(pluginsDir)) {
    console.log("No plugins installed. Use 'formic plugin create <name>' to get started.");
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch {
    console.log("No plugins installed. Use 'formic plugin create <name>' to get started.");
    return;
  }

  // Filter to directories only
  const pluginDirs: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(pluginsDir, entry);
    const manifestPath = path.join(entryPath, 'manifest.json');
    if (existsSync(manifestPath)) {
      pluginDirs.push(entry);
    }
  }

  if (pluginDirs.length === 0) {
    console.log("No plugins installed. Use 'formic plugin create <name>' to get started.");
    return;
  }

  const { getPluginConfig } = await getConfigHelpers();

  console.log('Installed plugins:\n');
  console.log(
    'NAME'.padEnd(20) +
    'VERSION'.padEnd(12) +
    'STATUS'.padEnd(12) +
    'DESCRIPTION'
  );

  for (const dirName of pluginDirs) {
    const pluginDir = path.join(pluginsDir, dirName);
    const manifest = await readManifest(pluginDir);

    if (!manifest) {
      console.log(
        dirName.padEnd(20) +
        '?'.padEnd(12) +
        'error'.padEnd(12) +
        'Failed to load: invalid manifest'
      );
      continue;
    }

    const config = await getPluginConfig(manifest.name);
    const status = config?.enabled === false ? 'disabled' : 'enabled';
    const description = manifest.description || '';

    console.log(
      manifest.name.padEnd(20) +
      manifest.version.padEnd(12) +
      status.padEnd(12) +
      description
    );
  }
}

/**
 * Install a plugin from a local path or git URL
 */
async function pluginInstall(source: string): Promise<void> {
  const pluginsDir = getPluginsDir();
  await mkdir(pluginsDir, { recursive: true });

  const isGitUrl = source.startsWith('http://') ||
                   source.startsWith('https://') ||
                   source.startsWith('git@') ||
                   source.endsWith('.git');

  if (isGitUrl) {
    // Clone to a temp directory first, then validate and move
    const tmpDir = path.join(pluginsDir, '.tmp-clone');
    try {
      if (existsSync(tmpDir)) {
        await rm(tmpDir, { recursive: true });
      }
      console.log(`Cloning ${source}...`);
      await execFileAsync('git', ['clone', source, tmpDir]);

      const manifest = await readManifest(tmpDir);
      if (!manifest) {
        await rm(tmpDir, { recursive: true });
        console.error('Error: Cloned repository does not contain a valid manifest.json');
        process.exit(1);
      }

      const destDir = path.join(pluginsDir, manifest.name);
      if (existsSync(destDir)) {
        await rm(tmpDir, { recursive: true });
        console.error(`Error: Plugin "${manifest.name}" is already installed.`);
        process.exit(1);
      }

      await cp(tmpDir, destDir, { recursive: true });
      await rm(tmpDir, { recursive: true });

      const { setPluginConfig } = await getConfigHelpers();
      await setPluginConfig(manifest.name, { enabled: true, settings: {} });
      console.log(`Installed plugin "${manifest.name}" v${manifest.version}`);
    } catch (error) {
      if (existsSync(tmpDir)) {
        await rm(tmpDir, { recursive: true }).catch(() => {});
      }
      const err = error as Error;
      console.error(`Error installing plugin: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Local path install
    const sourcePath = path.resolve(source);
    if (!existsSync(sourcePath)) {
      console.error(`Error: Source path does not exist: ${sourcePath}`);
      process.exit(1);
    }

    const manifest = await readManifest(sourcePath);
    if (!manifest) {
      console.error('Error: Source directory does not contain a valid manifest.json');
      process.exit(1);
    }

    const destDir = path.join(pluginsDir, manifest.name);
    if (existsSync(destDir)) {
      console.error(`Error: Plugin "${manifest.name}" is already installed.`);
      process.exit(1);
    }

    await cp(sourcePath, destDir, { recursive: true });

    const { setPluginConfig } = await getConfigHelpers();
    await setPluginConfig(manifest.name, { enabled: true, settings: {} });
    console.log(`Installed plugin "${manifest.name}" v${manifest.version}`);
  }
}

/**
 * Scaffold a new plugin from templates
 */
async function pluginCreate(name: string): Promise<void> {
  if (!isValidPluginName(name)) {
    console.error('Error: Plugin name must be lowercase kebab-case (e.g., my-plugin)');
    process.exit(1);
  }

  const pluginsDir = getPluginsDir();
  const pluginDir = path.join(pluginsDir, name);

  if (existsSync(pluginDir)) {
    console.error(`Error: Plugin directory already exists: ${pluginDir}`);
    process.exit(1);
  }

  const templateDir = path.join(PACKAGE_ROOT, 'templates', 'plugin');
  if (!existsSync(templateDir)) {
    console.error('Error: Plugin templates not found. Your Formic installation may be incomplete.');
    process.exit(1);
  }

  await mkdir(pluginDir, { recursive: true });

  const pascalName = toPascalCase(name);
  const templateFiles: Array<{ template: string; output: string }> = [
    { template: 'manifest.json.template', output: 'manifest.json' },
    { template: 'server.js.template', output: 'server.js' },
    { template: 'client.js.template', output: 'client.js' },
    { template: 'README.md.template', output: 'README.md' },
  ];

  for (const { template, output } of templateFiles) {
    const templatePath = path.join(templateDir, template);
    let content = await readFile(templatePath, 'utf-8');
    content = content.replaceAll('{{name}}', name);
    content = content.replaceAll('{{Name}}', pascalName);
    await writeFile(path.join(pluginDir, output), content, 'utf-8');
  }

  const { setPluginConfig } = await getConfigHelpers();
  await setPluginConfig(name, { enabled: true, settings: {} });

  console.log(`\nPlugin "${name}" created successfully!`);
  console.log(`  Location: ${pluginDir}\n`);
  console.log('Files created:');
  console.log('  manifest.json  — Plugin metadata and permissions');
  console.log('  server.js      — Server-side Fastify plugin');
  console.log('  client.js      — Client-side UI module');
  console.log('  README.md      — Plugin documentation\n');
  console.log('Next steps:');
  console.log('  1. Edit the plugin files to add your functionality');
  console.log('  2. Restart the Formic server to load the plugin');
  console.log(`  3. Use "formic plugin disable ${name}" to disable it`);
}

/**
 * Enable a plugin
 */
async function pluginEnable(name: string): Promise<void> {
  const pluginDir = path.join(getPluginsDir(), name);
  if (!existsSync(pluginDir)) {
    console.error(`Error: Plugin "${name}" is not installed.`);
    process.exit(1);
  }

  const manifest = await readManifest(pluginDir);
  if (!manifest) {
    console.error(`Error: Plugin "${name}" has an invalid manifest.json`);
    process.exit(1);
  }

  const { getPluginConfig, setPluginConfig } = await getConfigHelpers();
  const existing = await getPluginConfig(name);
  await setPluginConfig(name, {
    enabled: true,
    settings: existing?.settings ?? {},
  });

  console.log(`Plugin "${name}" enabled. Restart the server for changes to take effect.`);
}

/**
 * Disable a plugin
 */
async function pluginDisable(name: string): Promise<void> {
  const pluginDir = path.join(getPluginsDir(), name);
  if (!existsSync(pluginDir)) {
    console.error(`Error: Plugin "${name}" is not installed.`);
    process.exit(1);
  }

  const manifest = await readManifest(pluginDir);
  if (!manifest) {
    console.error(`Error: Plugin "${name}" has an invalid manifest.json`);
    process.exit(1);
  }

  const { getPluginConfig, setPluginConfig } = await getConfigHelpers();
  const existing = await getPluginConfig(name);
  await setPluginConfig(name, {
    enabled: false,
    settings: existing?.settings ?? {},
  });

  console.log(`Plugin "${name}" disabled. Restart the server for changes to take effect.`);
}

/**
 * Remove an installed plugin
 */
async function pluginRemove(name: string): Promise<void> {
  const pluginDir = path.join(getPluginsDir(), name);
  if (!existsSync(pluginDir)) {
    console.error(`Error: Plugin "${name}" is not installed.`);
    process.exit(1);
  }

  await rm(pluginDir, { recursive: true });

  const { removePluginConfig } = await getConfigHelpers();
  await removePluginConfig(name);

  console.log(`Plugin "${name}" removed.`);
}

// ==================== Entry Point ====================

/**
 * Handle `formic plugin <subcommand>` commands
 */
export async function handlePluginCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printPluginHelp();
    return;
  }

  switch (subcommand) {
    case 'list':
      await pluginList();
      break;

    case 'install': {
      const source = args[1];
      if (!source) {
        console.error('Error: Missing source argument.');
        console.error('Usage: formic plugin install <path-or-git-url>');
        process.exit(1);
      }
      await pluginInstall(source);
      break;
    }

    case 'create': {
      const name = args[1];
      if (!name) {
        console.error('Error: Missing plugin name.');
        console.error('Usage: formic plugin create <name>');
        process.exit(1);
      }
      await pluginCreate(name);
      break;
    }

    case 'enable': {
      const name = args[1];
      if (!name) {
        console.error('Error: Missing plugin name.');
        console.error('Usage: formic plugin enable <name>');
        process.exit(1);
      }
      await pluginEnable(name);
      break;
    }

    case 'disable': {
      const name = args[1];
      if (!name) {
        console.error('Error: Missing plugin name.');
        console.error('Usage: formic plugin disable <name>');
        process.exit(1);
      }
      await pluginDisable(name);
      break;
    }

    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Error: Missing plugin name.');
        console.error('Usage: formic plugin remove <name>');
        process.exit(1);
      }
      await pluginRemove(name);
      break;
    }

    default:
      console.error(`Error: Unknown plugin subcommand "${subcommand}"`);
      printPluginHelp();
      process.exit(1);
  }
}
