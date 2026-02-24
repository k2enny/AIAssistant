/**
 * Daemon start script - runs the daemon as a background service
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Daemon } from './daemon';

const HOME_DIR = process.env.AIASSISTANT_HOME || path.join(os.homedir(), '.aiassistant');
const PID_FILE = path.join(HOME_DIR, 'daemon.pid');

function writePidFile(): void {
  if (!fs.existsSync(HOME_DIR)) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, process.pid.toString());
}

function removePidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore cleanup errors
  }
}

async function main(): Promise<void> {
  // Write PID file early so the parent process knows we're alive
  writePidFile();

  const daemon = new Daemon();
  
  let restarts = 0;
  const maxRestarts = 5;
  const restartDelay = 3000;

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await daemon.stop();
    } catch (err) {
      console.error('Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    if (restarts < maxRestarts) {
      restarts++;
      console.log(`Restarting daemon (attempt ${restarts}/${maxRestarts})...`);
      setTimeout(async () => {
        try {
          await daemon.start();
        } catch (e) {
          console.error('Failed to restart:', e);
          removePidFile();
          process.exit(1);
        }
      }, restartDelay);
    } else {
      console.error('Max restarts exceeded, exiting');
      removePidFile();
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });

  try {
    await daemon.start();
  } catch (err) {
    console.error('Failed to start daemon:', err);
    removePidFile();
    process.exit(1);
  }
}

main();
