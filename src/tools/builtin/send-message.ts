/**
 * Send message tool - lets the AI proactively send messages to connected channels
 *
 * This tool enables the AI to push messages to any connected I/O channel
 * (Telegram, TUI, etc.) via the event bus, rather than only replying inline.
 */
import { Tool, ToolSchema, ToolResult, ToolContext, EventBusInterface } from '../../core/interfaces';
import { Events } from '../../core/event-bus';

export class SendMessageTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'send_message',
    description:
      'Send a message to a connected channel (e.g. telegram, tui). Use this to proactively push information to the user on a specific channel.',
    parameters: [
      {
        name: 'channel',
        type: 'string',
        description: 'Target channel ID, e.g. "telegram" or "tui". If omitted, the message is sent to the channel the current conversation is on.',
        required: false,
      },
      {
        name: 'user_id',
        type: 'string',
        description: 'Target user ID. If omitted, defaults to the current user.',
        required: false,
      },
      {
        name: 'message',
        type: 'string',
        description: 'The message content to send.',
        required: true,
      },
    ],
    returns: 'Confirmation of message delivery',
    category: 'communication',
    permissions: [],
  };

  private eventBus: EventBusInterface;

  constructor(eventBus: EventBusInterface) {
    this.eventBus = eventBus;
  }

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    if (!params.message || typeof params.message !== 'string' || params.message.trim() === '') {
      return { valid: false, errors: ['message parameter is required and must be a non-empty string'] };
    }
    return { valid: true };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const channel = params.channel || context.channelId;
      const userId = params.user_id || context.userId;
      const message = params.message;

      this.eventBus.emit(Events.AGENT_RESPONSE, {
        workflowId: context.workflowId,
        userId,
        channelId: channel,
        content: message,
      });

      return {
        success: true,
        output: {
          delivered: true,
          channel,
          userId,
          messageLength: message.length,
        },
      };
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }
}
