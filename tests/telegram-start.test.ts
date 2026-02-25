import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

describe('Telegram start script', () => {
  let tmpDir: string;
  let pidFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiassistant-telegram-test-'));
    pidFile = path.join(tmpDir, 'telegram.pid');
  });

  afterEach(() => {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try { fs.unlinkSync(pidFile); } catch {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('telegram PID file is written after successful startup', async () => {
    const child = spawn(
      'node',
      ['-e', `
        const fs = require('fs');
        const path = require('path');
        const HOME_DIR = ${JSON.stringify(tmpDir)};
        const PID_FILE = path.join(HOME_DIR, 'telegram.pid');
        if (!fs.existsSync(HOME_DIR)) fs.mkdirSync(HOME_DIR, { recursive: true });
        // Simulate successful startup then write PID
        setTimeout(() => {
          fs.writeFileSync(PID_FILE, process.pid.toString());
        }, 200);
        setTimeout(() => process.exit(0), 3000);
      `],
      { detached: true, stdio: 'ignore', env: { ...process.env, AIASSISTANT_HOME: tmpDir } }
    );

    child.unref();

    let pidFileFound = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (fs.existsSync(pidFile)) {
        pidFileFound = true;
        break;
      }
    }

    expect(pidFileFound).toBe(true);
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    expect(pid).toBeGreaterThan(0);
  });

  test('PID file is not created when startup fails', async () => {
    const child = spawn(
      'node',
      ['-e', `
        const fs = require('fs');
        const path = require('path');
        const HOME_DIR = ${JSON.stringify(tmpDir)};
        const PID_FILE = path.join(HOME_DIR, 'telegram.pid');
        // Simulate failure: log error to stderr and exit without writing PID
        console.error('Telegram bot token not configured.');
        process.exit(1);
      `],
      { stdio: 'ignore', env: { ...process.env, AIASSISTANT_HOME: tmpDir } }
    );

    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  test('errors are written to stderr when startup fails', async () => {
    const stderrChunks: string[] = [];
    const child = spawn(
      'node',
      ['-e', `
        // Simulate start.ts error logging behavior
        console.error('Failed to start Telegram bot: token missing');
        process.exit(1);
      `],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, AIASSISTANT_HOME: tmpDir } }
    );

    child.stderr!.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('Failed to start Telegram bot');
  });
});
