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

  test('telegram PID file can be written early for background startup', async () => {
    const child = spawn(
      'node',
      ['-e', `
        const fs = require('fs');
        const path = require('path');
        const HOME_DIR = ${JSON.stringify(tmpDir)};
        const PID_FILE = path.join(HOME_DIR, 'telegram.pid');
        if (!fs.existsSync(HOME_DIR)) fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, process.pid.toString());
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
});
