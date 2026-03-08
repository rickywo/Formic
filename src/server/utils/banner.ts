import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface StartupInfo {
  port: number;
  host: string;
  workspacePath: string;
  agentType: string;
  agentDisplayName: string;
  queueEnabled: boolean;
  maxConcurrent: number;
  version: string;
  messagingPlatforms?: string[];
}

const USE_COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function c(code: string, text: string): string {
  if (!USE_COLOR) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const brightGreen = (t: string) => c('92', t);
const bold = (t: string) => c('1', t);
const cyan = (t: string) => c('36', t);
const green = (t: string) => c('32', t);
const yellow = (t: string) => c('33', t);
const red = (t: string) => c('31', t);
const dim = (t: string) => c('2', t);

const ANT = [
  '             ╲  ╱                              ',
  '              ╲╱                               ',
  '            ╔═══╗                              ',
  '────────────╢◉ ◉╠──────[⬡⬡⬡]──────────◇      ',
  '            ╚═══╝                              ',
  '        ╱╲             ╱╲             ╱╲       ',
  '       ╱  ╲           ╱  ╲           ╱  ╲     ',
  '      ─    ─         ─    ─         ─    ─     ',
];

function renderAnt(): string {
  return ANT.map((line) => '  ' + brightGreen(line)).join('\n');
}

interface CheckResult {
  label: string;
  ok: boolean;
  warn?: boolean;
  hint?: string;
}

function tryExec(cmd: string): string | null {
  try {
    const output = execSync(cmd, { stdio: 'pipe' }).toString().trim();
    return output.split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

function runDependencyChecks(info: StartupInfo): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. Claude Code CLI
  const claudeVersion = tryExec('claude --version');
  if (claudeVersion !== null) {
    results.push({ label: `Claude Code CLI ${dim(claudeVersion)}`, ok: true });
  } else {
    results.push({
      label: 'Claude Code CLI not found',
      ok: false,
      hint: 'Install: npm install -g @anthropic-ai/claude-code',
    });
  }

  // 2. GitHub Copilot CLI
  const copilotVersion = tryExec('gh copilot --version') ?? tryExec('copilot --version');
  if (copilotVersion !== null) {
    const cleanVersion = copilotVersion.replace(/^GitHub Copilot CLI\s*/i, '');
    results.push({ label: `GitHub Copilot CLI ${dim(cleanVersion)}`, ok: true });
  } else {
    results.push({
      label: 'GitHub Copilot CLI not found',
      ok: false,
      hint: 'Install: gh extension install github/gh-copilot',
    });
  }

  // 3. API key / agent check
  if (info.agentType === 'copilot') {
    results.push({ label: 'GitHub Copilot OAuth (no key required)', ok: true });
  } else {
    const keySet = Boolean(process.env.ANTHROPIC_API_KEY);
    if (keySet) {
      results.push({ label: 'Anthropic API Key configured', ok: true });
    } else {
      results.push({
        label: 'Anthropic API Key not set',
        ok: false,
        hint: 'Set ANTHROPIC_API_KEY in your .env file',
      });
    }
  }

  // 4. Workspace
  const boardExists = existsSync(`${info.workspacePath}/.formic/board.json`);
  if (boardExists) {
    results.push({ label: `Workspace ${dim(info.workspacePath)} ${dim('(.formic initialized)')}`, ok: true });
  } else {
    results.push({
      label: `Workspace ${info.workspacePath} (not initialized)`,
      ok: false,
      warn: true,
      hint: 'Run: formic init',
    });
  }

  // 5. Node.js version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    results.push({ label: `Node.js v${nodeVersion}`, ok: true });
  } else {
    results.push({
      label: `Node.js v${nodeVersion} (requires >=20)`,
      ok: false,
      warn: true,
    });
  }

  return results;
}

function hr(): string {
  return dim('  ' + '─'.repeat(43));
}

function checkRow(r: CheckResult): string {
  if (r.ok) {
    return `  ${green('✓')} ${r.label}`;
  } else if (r.warn) {
    return `  ${yellow('⚠')} ${yellow(r.label)}`;
  } else {
    return `  ${red('✗')} ${red(r.label)}`;
  }
}

export async function printStartupBanner(info: StartupInfo): Promise<void> {
  const lines: string[] = [];

  lines.push('');

  // ASCII Ant
  lines.push(renderAnt());
  lines.push('');

  // Wordmark box
  const wordmark = `  F O R M I C  ${bold(`v${info.version}`)}  `;
  const subtitle = '  AI Agent Orchestration Platform  ';
  const boxWidth = 45;
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.replace(/\x1b\[[0-9;]*m/g, '').length));

  lines.push('  ' + c('1', '╔' + '═'.repeat(boxWidth) + '╗'));
  lines.push('  ' + c('1', '║') + ' ' + bold(pad(wordmark, boxWidth - 1)) + c('1', '║'));
  lines.push('  ' + c('1', '║') + ' ' + dim(pad(subtitle, boxWidth - 1)) + c('1', '║'));
  lines.push('  ' + c('1', '╚' + '═'.repeat(boxWidth) + '╝'));
  lines.push('');

  // System Checks
  lines.push(`  ${bold('System Checks')}`);
  lines.push(hr());

  const checks = runDependencyChecks(info);
  for (const check of checks) {
    lines.push(checkRow(check));
    if (check.hint) {
      lines.push(`    ${dim('→')} ${dim(check.hint)}`);
    }
  }

  lines.push('');

  // Server info
  lines.push(`  ${bold('Server')}`);
  lines.push(hr());

  const listenHost = info.host === '0.0.0.0' ? 'localhost' : info.host;
  lines.push(`  ${green('✓')} Listening on ${cyan(`http://${listenHost}:${info.port}`)}`);
  lines.push(`  ${green('✓')} Active Agent ${bold(info.agentDisplayName)}`);

  if (info.queueEnabled) {
    lines.push(`  ${green('✓')} Queue Processor ${dim(`enabled (max: ${info.maxConcurrent} concurrent)`)}`);
  } else {
    lines.push(`  ${yellow('⚠')} Queue Processor ${yellow('disabled')}`);
  }

  lines.push(`  ${green('✓')} Lease Watchdog ${dim('running')}`);

  if (info.messagingPlatforms && info.messagingPlatforms.length > 0) {
    lines.push(`  ${green('✓')} Messaging ${dim(info.messagingPlatforms.join(', '))}`);
  } else {
    lines.push(`  ${dim('–')} Messaging ${dim('disabled')}`);
  }

  lines.push('');
  lines.push(`  Open ${cyan(`http://${listenHost}:${info.port}`)} in your browser to get started.`);
  lines.push(hr());
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
}

export function printBanner(version: string): void {
  process.stdout.write(`\n  ${brightGreen('🐜')}  ${bold('FORMIC')} ${dim(`v${version}`)}\n\n`);
}
