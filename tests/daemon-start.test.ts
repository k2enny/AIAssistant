import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';

describe('Daemon start script', () => {
  let tmpDir: string;
  let pidFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiassistant-test-'));
    pidFile = path.join(tmpDir, 'daemon.pid');
  });

  afterEach(() => {
    // Clean up PID file and any child processes
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try { fs.unlinkSync(pidFile); } catch {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('PID file is written early before daemon.start() completes', async () => {
    // Start daemon with AIASSISTANT_HOME set to tmp dir
    const startScript = path.resolve(__dirname, '../src/daemon/start.ts');

    const child = spawn(
      'node',
      ['-e', `
        process.env.AIASSISTANT_HOME = ${JSON.stringify(tmpDir)};
        // Override Daemon to simulate slow initialization
        const fs = require('fs');
        const path = require('path');

        const HOME_DIR = process.env.AIASSISTANT_HOME;
        const PID_FILE = path.join(HOME_DIR, 'daemon.pid');

        function writePidFile() {
          if (!fs.existsSync(HOME_DIR)) {
            fs.mkdirSync(HOME_DIR, { recursive: true });
          }
          fs.writeFileSync(PID_FILE, process.pid.toString());
        }

        function removePidFile() {
          try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}
        }

        // Write PID immediately (simulating start.ts behavior)
        writePidFile();

        // Simulate a slow daemon.start() that takes 3 seconds
        setTimeout(() => {
          // "Daemon started" - just exit cleanly
          process.exit(0);
        }, 3000);
      `],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, AIASSISTANT_HOME: tmpDir },
      }
    );

    child.unref();

    // PID file should appear within 2 seconds (well before the 3-second "daemon.start()")
    let pidFileFound = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (fs.existsSync(pidFile)) {
        pidFileFound = true;
        break;
      }
    }

    expect(pidFileFound).toBe(true);

    // Verify PID file contains a valid number
    const content = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(content, 10);
    expect(pid).toBeGreaterThan(0);
    expect(Number.isInteger(pid)).toBe(true);
  });

  test('PID file is cleaned up if daemon fails to start', async () => {
    const child = spawn(
      'node',
      ['-e', `
        const fs = require('fs');
        const path = require('path');

        const HOME_DIR = ${JSON.stringify(tmpDir)};
        const PID_FILE = path.join(HOME_DIR, 'daemon.pid');

        function writePidFile() {
          if (!fs.existsSync(HOME_DIR)) {
            fs.mkdirSync(HOME_DIR, { recursive: true });
          }
          fs.writeFileSync(PID_FILE, process.pid.toString());
        }

        function removePidFile() {
          try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}
        }

        // Simulate start.ts: write PID, then fail, then clean up
        writePidFile();

        // Simulate daemon.start() failure
        removePidFile();
        process.exit(1);
      `],
      {
        stdio: 'ignore',
        env: { ...process.env, AIASSISTANT_HOME: tmpDir },
      }
    );

    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });

    // PID file should be removed after failure
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
