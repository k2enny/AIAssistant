/**
 * Telegram bot connector
 */
import { Telegraf, Context } from 'telegraf';
import { ChannelConnector, Message, EventBusInterface } from '../../core/interfaces';
import { Events } from '../../core/event-bus';
import { v4 as uuidv4 } from 'uuid';

export class TelegramConnector implements ChannelConnector {
  readonly id = 'telegram';
  readonly name = 'Telegram';
  private bot: Telegraf;
  private eventBus: EventBusInterface | null = null;
  private connected = false;

  constructor(token: string) {
    this.bot = new Telegraf(token);
  }

  async initialize(eventBus: EventBusInterface): Promise<void> {
    this.eventBus = eventBus;

    // Handle text messages
    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !('text' in ctx.message)) return;
      
      const message: Message = {
        id: uuidv4(),
        channelId: 'telegram',
        userId: ctx.message.from?.id?.toString() || 'unknown',
        content: ctx.message.text,
        timestamp: new Date(),
        metadata: {
          chatId: ctx.message.chat.id,
          username: ctx.message.from?.username,
          firstName: ctx.message.from?.first_name,
        },
      };

      this.eventBus?.emit(Events.MESSAGE_RECEIVED, message);
    });

    // Handle commands
    this.bot.command('start', (ctx) => {
      ctx.reply('👋 AIAssistant is ready! Send me a message to get started.\n\nCommands:\n/status - Check status\n/tools - List tools\n/help - Show help');
    });

    this.bot.command('status', (ctx) => {
      ctx.reply('🟢 AIAssistant is running.');
    });

    this.bot.command('help', (ctx) => {
      ctx.reply('🤖 AIAssistant Help\n\nSend any message to interact with the AI.\n\nCommands:\n/start - Initialize\n/status - Check status\n/tools - List available tools\n/new - Start new conversation\n/help - This message');
    });

    // Listen for agent responses
    eventBus.on(Events.AGENT_RESPONSE, async (data) => {
      if (data.channelId === 'telegram' && data.userId) {
        try {
          await this.sendMessage(data.userId, data.content, data.metadata);
        } catch (err: any) {
          // Log error but don't crash
        }
      }
    });

    eventBus.on(Events.AGENT_ERROR, async (data) => {
      if (data.channelId === 'telegram' && data.userId) {
        try {
          await this.sendMessage(data.userId, `❌ Error: ${data.error}`);
        } catch {
          // Ignore
        }
      }
    });

    // Start polling
    this.bot.launch().then(() => {
      this.connected = true;
      eventBus.emit(Events.CHANNEL_CONNECTED, { channel: 'telegram' });
    }).catch((err: any) => {
      this.connected = false;
    });
  }

  async shutdown(): Promise<void> {
    this.bot.stop('Daemon shutdown');
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
