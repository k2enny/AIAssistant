/**
 * Telegram start script - runs Telegram bot as a background service
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Vault } from '../../security/vault';
import { TelegramClient } from './client';

const HOME_DIR = process.env.AIASSISTANT_HOME || path.join(os.homedir(), '.aiassistant');
const PID_FILE = path.join(HOME_DIR, 'telegram.pid');

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
  writePidFile();

  const vault = new Vault(HOME_DIR);
  await vault.initialize();
  const token = await vault.getSecret('telegram_bot_token');
  if (!token) {
    throw new Error('Telegram bot token not configured. Run setup first: ./aiassistant setup');
  }

  const client = new TelegramClient(token);

  const shutdown = async () => {
    try {
      await client.stop();
    } catch {
      // Ignore shutdown errors
    }
    removePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', () => {
    removePidFile();
    process.exit(1);
  });

  process.on('unhandledRejection', () => {
    removePidFile();
    process.exit(1);
  });

  try {
    await client.start();
  } catch (err) {
    removePidFile();
    process.exit(1);
  }
}

main();
