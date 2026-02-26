/**
 * Telegram bot connector
 */
import { Telegraf, Context } from 'telegraf';
import { ChannelConnector, Message, EventBusInterface } from '../../core/interfaces';
import { Events } from '../../core/event-bus';
import * as crypto from 'crypto';

export class TelegramConnector implements ChannelConnector {
  readonly id = 'telegram';
  readonly name = 'Telegram';
  private bot: Telegraf;
  private eventBus: EventBusInterface | null = null;
  private connected = false;
  private chatMap: Map<string, number> = new Map();

  constructor(token: string) {
    this.bot = new Telegraf(token);
  }

  async initialize(eventBus: EventBusInterface): Promise<void> {
    this.eventBus = eventBus;

    // Catch unhandled errors in handlers so they don't crash the polling
    // loop.  Telegraf's default error handler re-throws, which terminates
    // the long-polling loop and makes the bot completely unresponsive.
    this.bot.catch((err: any) => {
      console.error(`Telegram connector handler error: ${err.message}`);
    });

    // Register command handlers BEFORE the general text handler.
    // In Telegraf v4 middleware runs in registration order; if bot.on('text')
    // is registered first it matches ALL text messages (including commands)
    // and swallows them before command handlers can run.
    this.bot.command('start', async (ctx) => {
      try {
        await ctx.reply('👋 AIAssistant is ready! Send me a message to get started.\n\nCommands:\n/status - Check status\n/tools - List tools\n/help - Show help');
      } catch { /* ignore */ }
    });

    this.bot.command('status', async (ctx) => {
      try { await ctx.reply('🟢 AIAssistant is running.'); } catch { /* ignore */ }
    });

    this.bot.command('help', async (ctx) => {
      try {
        await ctx.reply('🤖 AIAssistant Help\n\nSend any message to interact with the AI.\n\nCommands:\n/start - Initialize\n/status - Check status\n/tools - List available tools\n/new - Start new conversation\n/help - This message');
      } catch { /* ignore */ }
    });

    this.bot.command('new', async (ctx) => {
      try { await ctx.reply('🆕 New conversation started.'); } catch { /* ignore */ }
    });

    // Handle text messages (after commands so commands are matched first)
    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !('text' in ctx.message)) return;

      const userId = ctx.message.from?.id?.toString() || 'unknown';
      const chatId = ctx.message.chat.id;
      this.chatMap.set(userId, chatId);

      const message: Message = {
        id: crypto.randomUUID(),
        channelId: 'telegram',
        userId,
        content: ctx.message.text,
        timestamp: new Date(),
        metadata: {
          chatId,
          username: ctx.message.from?.username,
          firstName: ctx.message.from?.first_name,
        },
      };

      this.eventBus?.emit(Events.MESSAGE_RECEIVED, message);
    });

    // Listen for agent responses
    eventBus.on(Events.AGENT_RESPONSE, async (data) => {
      if (data.channelId === 'telegram' && data.userId) {
        try {
          const chatId = this.chatMap.get(data.userId);
          if (chatId !== undefined) {
            await this.sendMessage(data.userId, data.content, { chatId });
          }
        } catch (err: any) {
          // Log error but don't crash
        }
      }
    });

    eventBus.on(Events.AGENT_ERROR, async (data) => {
      if (data.channelId === 'telegram' && data.userId) {
        try {
          const chatId = this.chatMap.get(data.userId);
          if (chatId !== undefined) {
            await this.sendMessage(data.userId, `❌ Error: ${data.error}`, { chatId });
          }
        } catch {
          // Ignore
        }
      }
    });

    // Start polling – launch() blocks until the polling loop ends so we
    // must not await it.  The .then/.catch handle the eventual outcome.
    this.connected = true;
    eventBus.emit(Events.CHANNEL_CONNECTED, { channel: 'telegram' });
    this.pollWithRetry();
  }

  private pollWithRetry(): void {
    if (!this.connected) return;

    this.bot.launch({ dropPendingUpdates: true }).catch((err: any) => {
      console.error(`Telegram connector polling error: ${err.message}`);
      if (this.connected) {
        try { this.bot.stop('Retrying connection'); } catch { /* ignore */ }
        console.log('Retrying Telegram connector polling in 5 seconds...');
        setTimeout(() => this.pollWithRetry(), 5000);
      }
    });
  }

  async shutdown(): Promise<void> {
    try { this.bot.stop('Daemon shutdown'); } catch { /* already stopped */ }
    this.connected = false;
    this.eventBus?.emit(Events.CHANNEL_DISCONNECTED, { channel: 'telegram' });
  }

  async sendMessage(userId: string, content: string, metadata?: Record<string, any>): Promise<void> {
    const chatId = metadata?.chatId || userId;

    // Split long messages (Telegram limit: 4096 chars)
    if (content.length > 4000) {
      const chunks = this.splitMessage(content, 4000);
      for (const chunk of chunks) {
        await this.bot.telegram.sendMessage(chatId, chunk);
      }
    } else {
      await this.bot.telegram.sendMessage(chatId, content);
    }

    this.eventBus?.emit(Events.MESSAGE_SENT, {
      channelId: 'telegram',
      userId,
      content,
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      // Find last newline before limit
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = maxLength;
      }
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }
    return chunks;
  }
}
