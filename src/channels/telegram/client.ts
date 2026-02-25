/**
 * Telegram Channel Client - connects to daemon via IPC
 * 
 * Runs as a separate process (peer of TUI), bridging Telegram Bot API
 * with the daemon through IPC. This keeps channel implementations
 * independent of the daemon process.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Telegraf, Context } from 'telegraf';

export class TelegramClient {
  private bot: Telegraf;
  private socket: net.Socket | null = null;
  private socketPath: string;
  private authToken: string;
  private authenticated = false;
  private pendingRequests: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }> = new Map();
  private eventHandlers: Map<string, Array<(data: any) => void>> = new Map();
  private buffer = '';
  private requestCounter = 0;
  private chatMap: Map<string, number> = new Map();
  private launchPromise: Promise<void> | null = null;
  private running = false;

  constructor(botToken: string) {
    this.bot = new Telegraf(botToken);
    const homeDir = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant');
    this.socketPath = path.join(homeDir, 'daemon.sock');

    const tokenPath = path.join(homeDir, '.auth-token');
    this.authToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf-8').trim() : '';
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(this.socketPath)) {
      throw new Error('Daemon is not running. Start it with: aiassistant start');
    }

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath, () => {
        this.sendRaw({
          id: 'auth-0',
          method: 'auth',
          params: { token: this.authToken },
        });
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleMessage(msg);

            if (msg.id === 'auth-0' && msg.result?.status === 'authenticated') {
              this.authenticated = true;
              resolve();
            } else if (msg.id === 'auth-0' && msg.error) {
              reject(new Error(msg.error.message));
            }
          } catch {
            // Ignore parse errors
          }
        }
      });

      this.socket.on('error', (err) => {
        if (!this.authenticated) {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.authenticated = false;
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.authenticated = false;
  }

  async request(method: string, params?: any): Promise<any> {
    if (!this.authenticated) {
      throw new Error('Not connected to daemon');
    }

    const id = `req-${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.sendRaw({ id, method, params });
    });
  }

  onEvent(event: string, handler: (data: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  async testConnection(): Promise<{ token: boolean; bot?: { id: number; username: string; firstName: string }; daemon: boolean; error?: string }> {
    const result: { token: boolean; bot?: { id: number; username: string; firstName: string }; daemon: boolean; error?: string } = {
      token: false,
      daemon: false,
    };

    // Test Telegram API token
    try {
      const me = await this.bot.telegram.getMe();
      result.token = true;
      result.bot = {
        id: me.id,
        username: me.username || '',
        firstName: me.first_name,
      };
    } catch (err: any) {
      result.error = `Telegram API error: ${err.message}`;
      return result;
    }

    // Test daemon connectivity
    try {
      await this.connect();
      result.daemon = true;
      await this.disconnect();
    } catch (err: any) {
      result.error = `Daemon connection error: ${err.message}`;
    }

    return result;
  }

  async start(): Promise<void> {
    await this.connect();
    this.setupEventHandlers();
    this.setupBot();

    // Validate the token with a quick API call before launching polling.
    // getMe() is a lightweight request that fails fast on bad tokens.
    await this.bot.telegram.getMe();

    // Start long-polling in the background.  Do NOT await – launch()
    // resolves only after the first successful getUpdates round-trip
    // which can hang for 30+ seconds or forever on 409 conflicts.
    this.launchPromise = this.bot.launch();
    this.launchPromise.catch((err) => {
      console.error(`Telegram polling error: ${err.message}`);
    });
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    try { this.bot.stop('Telegram client shutdown'); } catch { /* already stopped */ }
    await this.disconnect();
  }

  isRunning(): boolean {
    return this.running;
  }

  private setupBot(): void {
    // Catch unhandled errors in handlers so they don't crash the polling
    // loop.  Telegraf's default error handler re-throws, which terminates
    // the long-polling loop and makes the bot completely unresponsive.
    this.bot.catch((err: any) => {
      // Swallow the error so polling continues for subsequent updates.
      console.error(`Telegram bot handler error: ${err.message}`);
    });

    // Register command handlers BEFORE the general text handler.
    // In Telegraf v4 middleware runs in registration order; if bot.on('text')
    // is registered first it matches ALL text messages (including commands)
    // and swallows them before command handlers can run.
    this.bot.command('start', async (ctx) => {
      try {
        await ctx.reply('👋 AIAssistant is ready! Send me a message to get started.\n\nCommands:\n/status - Check status\n/tools - List tools\n/help - Show help');
      } catch {
        // Ignore send failures
      }
    });

    this.bot.command('status', async (ctx) => {
      try {
        const status = await this.request('status');
        await ctx.reply(
          `🟢 AIAssistant Status\n` +
          `  Uptime: ${Math.floor(status.uptime)}s\n` +
          `  Tools: ${status.tools.join(', ')}\n` +
          `  Active Workflows: ${status.activeWorkflows}`
        );
      } catch {
        try { await ctx.reply('🟢 AIAssistant is running.'); } catch { /* ignore */ }
      }
    });

    this.bot.command('tools', async (ctx) => {
      try {
        const tools = await this.request('list_tools');
        const list = tools.map((t: any) => `• ${t.name}: ${t.description}`).join('\n');
        await ctx.reply(`🔧 Available Tools:\n${list}`);
      } catch {
        try { await ctx.reply('❌ Could not retrieve tools list.'); } catch { /* ignore */ }
      }
    });

    this.bot.command('help', async (ctx) => {
      try {
        await ctx.reply('🤖 AIAssistant Help\n\nSend any message to interact with the AI.\n\nCommands:\n/start - Initialize\n/status - Check status\n/tools - List available tools\n/new - Start new conversation\n/help - This message');
      } catch {
        // Ignore send failures
      }
    });

    this.bot.command('new', async (ctx) => {
      try {
        await this.request('memory_clear');
        await ctx.reply('🆕 New conversation started. Previous context has been cleared.');
      } catch {
        try { await ctx.reply('🆕 New conversation started.'); } catch { /* ignore */ }
      }
    });

    // General text handler registered AFTER commands so commands are matched first.
    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !('text' in ctx.message)) return;

      const userId = ctx.message.from?.id?.toString() || 'unknown';
      const chatId = ctx.message.chat.id;

      this.chatMap.set(userId, chatId);

      try {
        // Send typing indicator so the user knows the bot received the message
        await ctx.sendChatAction('typing');

        // Fire-and-forget: rely on the agent:response event for final output.
        // This avoids duplicate replies and avoids surfacing request timeouts
        // during long-running workflows.
        this.request('send_message', {
          content: ctx.message.text,
          userId,
          channelId: 'telegram',
        }).catch(async (err: any) => {
          try {
            await this.bot.telegram.sendMessage(chatId, `❌ Error: ${err.message}`);
          } catch {
            // Ignore send failures
          }
        });
      } catch (err: any) {
        try {
          await this.bot.telegram.sendMessage(chatId, `❌ Error: ${err.message}`);
        } catch {
          // Ignore send failures
        }
      }
    });
  }

  private setupEventHandlers(): void {
    this.onEvent('agent:response', (data) => {
      if (data.channelId === 'telegram' && data.userId) {
        const chatId = this.chatMap.get(data.userId);
        if (chatId) {
          this.sendTelegramMessage(chatId, data.content);
        }
      }
    });

    this.onEvent('agent:error', (data) => {
      if (data.channelId === 'telegram' && data.userId) {
        const chatId = this.chatMap.get(data.userId);
        if (chatId) {
          this.sendTelegramMessage(chatId, `❌ Error: ${data.error}`);
        }
      }
    });
  }

  private async sendTelegramMessage(chatId: number, content: string): Promise<void> {
    try {
      if (content.length > 4000) {
        const chunks = this.splitMessage(content, 4000);
        for (const chunk of chunks) {
          await this.bot.telegram.sendMessage(chatId, chunk);
        }
      } else {
        await this.bot.telegram.sendMessage(chatId, content);
      }
    } catch {
      // Ignore send failures
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = maxLength;
      }
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }
    return chunks;
  }

  private handleMessage(msg: any): void {
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result);
      }
      return;
    }

    if (msg.event) {
      const handlers = this.eventHandlers.get(msg.event) || [];
      for (const handler of handlers) {
        handler(msg.data);
      }
    }
  }

  private sendRaw(data: any): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(data) + '\n');
    }
  }
}
