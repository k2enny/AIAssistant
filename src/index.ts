/**
 * AIAssistant - Main CLI entrypoint
 * 
 * Commands:
 *   setup    - First-time setup wizard + start daemon + launch TUI
 *   start    - Start the background daemon
 *   stop     - Stop the daemon
 *   restart  - Restart the daemon
 *   status   - Show daemon status
 *   tui      - Attach to daemon with interactive TUI
 *   logs     - Tail/follow daemon logs
 *   reset    - Clear session/context
 *   policy   - Policy management (list/add/remove)
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';

const HOME_DIR = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant');
const PID_FILE = path.join(HOME_DIR, 'daemon.pid');

const program = new Command();

program
  .name('aiassistant')
  .description('AI operator tool - extensible agent platform')
  .version('1.0.0');

// ============ setup ============
program
  .command('setup')
  .description('Run setup wizard, start daemon, and launch TUI')
  .action(async () => {
    try {
      const { SetupWizard } = require('./setup/wizard');
      const wizard = new SetupWizard();
      await wizard.run();

      // Start daemon if not running
      if (!isDaemonRunning()) {
        console.log('\n🚀 Starting daemon...');
        await startDaemon();
        // Wait for daemon to be ready
        await sleep(2000);
      }

      // Launch TUI
      console.log('📺 Launching TUI...\n');
      const { TUIClient } = require('./channels/tui/client');
      const tui = new TUIClient();
      await tui.connect();
      await tui.startInteractive();
      await tui.disconnect();
    } catch (err: any) {
      console.error(`❌ Setup failed: ${err.message}`);
      process.exit(1);
    }
  });

// ============ start ============
program
  .command('start')
  .description('Start the background daemon')
  .option('-f, --foreground', 'Run in foreground (do not daemonize)')
  .action(async (opts) => {
    if (isDaemonRunning()) {
      console.log('✅ Daemon is already running (PID: ' + readPid() + ')');
      return;
    }

    if (opts.foreground) {
      console.log('🚀 Starting daemon in foreground...');
      process.env.AIASSISTANT_FOREGROUND = '1';
      const { Daemon } = require('./daemon/daemon');
      const daemon = new Daemon();
      
      const shutdown = async () => {
        await daemon.stop();
        process.exit(0);
      };
      
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      
      await daemon.start();
    } else {
      await startDaemon();
      console.log('✅ Daemon started');
    }
  });

// ============ stop ============
program
  .command('stop')
  .description('Stop the background daemon')
  .action(async () => {
    const pid = readPid();
    if (!pid) {
      console.log('ℹ️  Daemon is not running');
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`🛑 Stopping daemon (PID: ${pid})...`);
      
      // Wait for process to exit
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        try {
          process.kill(pid, 0); // Check if still alive
        } catch {
          console.log('✅ Daemon stopped');
          return;
        }
      }
      
      // Force kill
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }
      console.log('✅ Daemon stopped (forced)');
    } catch (err: any) {
      console.log('ℹ️  Daemon is not running (stale PID file)');
      // Clean up stale PID file
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
      }
    }
  });

// ============ restart ============
program
  .command('restart')
  .description('Restart the daemon')
  .action(async () => {
    const pid = readPid();
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log('🔄 Stopping current daemon...');
        await sleep(2000);
      } catch {
        // Already dead
      }
    }
    await startDaemon();
    console.log('✅ Daemon restarted');
  });

// ============ status ============
program
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('🔴 Daemon is not running');
      return;
    }

    try {
      const { TUIClient } = require('./channels/tui/client');
      const client = new TUIClient();
      await client.connect();
      const status = await client.request('status');
      await client.disconnect();

      console.log('🟢 Daemon Status:');
      console.log(`  PID: ${status.pid}`);
      console.log(`  Uptime: ${Math.floor(status.uptime)}s`);
      console.log(`  Channels: ${status.channels.join(', ') || 'none'}`);
      console.log(`  Plugins: ${status.plugins.join(', ') || 'none'}`);
      console.log(`  Tools: ${status.tools.join(', ')}`);
      console.log(`  Active Workflows: ${status.activeWorkflows}`);
    } catch (err: any) {
      console.log(`🔴 Daemon is running but unreachable: ${err.message}`);
    }
  });

// ============ tui ============
program
  .command('tui')
  .description('Attach interactive TUI to running daemon')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('🔴 Daemon is not running. Start it with: ./aiassistant start');
      process.exit(1);
    }

    try {
      const { TUIClient } = require('./channels/tui/client');
      const tui = new TUIClient();
      await tui.connect();
      await tui.startInteractive();
      await tui.disconnect();
    } catch (err: any) {
      console.error(`❌ Failed to connect to daemon: ${err.message}`);
      process.exit(1);
    }
  });

// ============ logs ============
program
  .command('logs')
  .description('Tail/follow daemon logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .action((opts) => {
    const logFile = path.join(HOME_DIR, 'logs', 'daemon.log');
    if (!fs.existsSync(logFile)) {
      console.log('ℹ️  No log file found');
      return;
    }

    try {
      const args = opts.follow ? ['-f', '-n', opts.lines, logFile] : ['-n', opts.lines, logFile];
      const child = spawn('tail', args, { stdio: 'inherit' });
      child.on('error', (err) => {
        console.error(`❌ Error: ${err.message}`);
      });
    } catch (err: any) {
      console.error(`❌ Error reading logs: ${err.message}`);
    }
  });

// ============ reset ============
program
  .command('reset')
  .description('Clear session/context data')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (opts) => {
    if (!opts.yes) {
      const inquirer = require('inquirer');
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'This will clear all conversation history and workflow data. Continue?',
        default: false,
      }]);
      if (!confirm) {
        console.log('Cancelled');
        return;
      }
    }

    if (isDaemonRunning()) {
      try {
        const { TUIClient } = require('./channels/tui/client');
        const client = new TUIClient();
        await client.connect();
        await client.request('memory_clear');
        await client.disconnect();
        console.log('✅ Session data cleared');
      } catch (err: any) {
        console.error(`❌ Error: ${err.message}`);
      }
    } else {
      // Clear data files directly
      const dataDir = path.join(HOME_DIR, 'data');
      if (fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir);
        for (const file of files) {
          fs.unlinkSync(path.join(dataDir, file));
        }
      }
      console.log('✅ Session data cleared');
    }
  });

// ============ policy ============
const policyCmd = program
  .command('policy')
  .description('Policy management');

policyCmd
  .command('list')
  .description('List all policy rules')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('🔴 Daemon is not running');
      return;
    }
    try {
      const { TUIClient } = require('./channels/tui/client');
      const client = new TUIClient();
      await client.connect();
      const rules = await client.request('policy_list');
      await client.disconnect();

      console.log('\n🛡️  Policy Rules:\n');
      for (const rule of rules) {
        const status = rule.enabled ? '✅' : '❌';
        console.log(`  ${status} [${rule.action}] ${rule.name}`);
        console.log(`     ${rule.description}`);
        console.log(`     Priority: ${rule.priority} | ID: ${rule.id.substring(0, 8)}`);
        console.log('');
      }
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
    }
  });

policyCmd
  .command('add')
  .description('Add a new policy rule')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log('🔴 Daemon is not running');
      return;
    }

    const inquirer = require('inquirer');
    const answers = await inquirer.prompt([
      { type: 'input', name: 'name', message: 'Rule name:' },
      { type: 'input', name: 'description', message: 'Description:' },
      { type: 'list', name: 'action', message: 'Action:', choices: ['allow', 'deny', 'require-confirmation'] },
      { type: 'number', name: 'priority', message: 'Priority (higher = more important):', default: 50 },
      { type: 'input', name: 'tools', message: 'Tool names (comma-separated, * for all):' },
    ]);

    const rule = {
      name: answers.name,
      description: answers.description,
      action: answers.action,
      priority: answers.priority,
      enabled: true,
      scope: {
        global: answers.tools === '*',
        tools: answers.tools !== '*' ? answers.tools.split(',').map((t: string) => t.trim()) : undefined,
      },
      target: {
        commands: answers.tools !== '*' ? answers.tools.split(',').map((t: string) => t.trim()) : undefined,
      },
    };

    try {
      const { TUIClient } = require('./channels/tui/client');
      const client = new TUIClient();
      await client.connect();
      const result = await client.request('policy_add', rule);
      await client.disconnect();
      console.log(`✅ Policy rule added: ${result.name} (${result.id.substring(0, 8)})`);
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
    }
  });

policyCmd
  .command('remove <id>')
  .description('Remove a policy rule by ID')
  .action(async (id: string) => {
    if (!isDaemonRunning()) {
      console.log('🔴 Daemon is not running');
      return;
    }

    try {
      const { TUIClient } = require('./channels/tui/client');
      const client = new TUIClient();
      await client.connect();
      await client.request('policy_remove', { id });
      await client.disconnect();
      console.log(`✅ Policy rule removed: ${id}`);
    } catch (err: any) {
      console.error(`❌ Error: ${err.message}`);
    }
  });

// ============ Helper functions ============

function isDaemonRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    if (fs.existsSync(PID_FILE)) {
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
    return false;
  }
}

function readPid(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  try {
    return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

async function startDaemon(): Promise<void> {
  const entryScript = path.join(__dirname, 'daemon', 'start.js');
  
  // Ensure logs directory exists
  const logsDir = path.join(HOME_DIR, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const out = fs.openSync(path.join(logsDir, 'daemon-stdout.log'), 'a');
  const err = fs.openSync(path.join(logsDir, 'daemon-stderr.log'), 'a');

  const child = spawn(process.execPath, [entryScript], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, AIASSISTANT_HOME: HOME_DIR },
  });

  child.unref();
  
  // Wait for PID file to appear
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (fs.existsSync(PID_FILE)) return;
  }
  
  throw new Error('Daemon failed to start (timeout waiting for PID file)');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run
program.parse(process.argv);

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
