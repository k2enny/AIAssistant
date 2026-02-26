import { SendMessageTool } from '../src/tools/builtin/send-message';
import { EventBus, Events } from '../src/core/event-bus';
import { ToolContext } from '../src/core/interfaces';

describe('SendMessageTool', () => {
  let tool: SendMessageTool;
  let eventBus: EventBus;
  const context: ToolContext = {
    workflowId: 'wf-1',
    userId: 'user1',
    channelId: 'tui',
    dryRun: false,
  };

  beforeEach(() => {
    eventBus = new EventBus();
    tool = new SendMessageTool(eventBus);
  });

  test('schema should have correct name and category', () => {
    expect(tool.schema.name).toBe('send_message');
    expect(tool.schema.category).toBe('communication');
  });

  test('should validate that message is required', () => {
    expect(tool.validate({}).valid).toBe(false);
    expect(tool.validate({ message: '' }).valid).toBe(false);
    expect(tool.validate({ message: '   ' }).valid).toBe(false);
    expect(tool.validate({ message: 'hello' }).valid).toBe(true);
  });

  test('should emit AGENT_RESPONSE event with message', async () => {
    const emitted: any[] = [];
    eventBus.on(Events.AGENT_RESPONSE, (data) => emitted.push(data));

    const result = await tool.execute({ message: 'Hello world' }, context);

    expect(result.success).toBe(true);
    expect(result.output.delivered).toBe(true);
    expect(result.output.channel).toBe('tui');
    expect(result.output.userId).toBe('user1');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].content).toBe('Hello world');
    expect(emitted[0].channelId).toBe('tui');
    expect(emitted[0].userId).toBe('user1');
  });

  test('should use explicit channel and user_id when provided', async () => {
    const emitted: any[] = [];
    eventBus.on(Events.AGENT_RESPONSE, (data) => emitted.push(data));

    const result = await tool.execute(
      { message: 'Telegram msg', channel: 'telegram', user_id: '12345' },
      context
    );

    expect(result.success).toBe(true);
    expect(result.output.channel).toBe('telegram');
    expect(result.output.userId).toBe('12345');
    expect(emitted[0].channelId).toBe('telegram');
    expect(emitted[0].userId).toBe('12345');
  });

  test('should default channel and userId from context', async () => {
    const emitted: any[] = [];
    eventBus.on(Events.AGENT_RESPONSE, (data) => emitted.push(data));

    await tool.execute({ message: 'test' }, context);

    expect(emitted[0].channelId).toBe('tui');
    expect(emitted[0].userId).toBe('user1');
  });

  test('should emit proactive flag in AGENT_RESPONSE event', async () => {
    const emitted: any[] = [];
    eventBus.on(Events.AGENT_RESPONSE, (data) => emitted.push(data));

    await tool.execute({ message: 'proactive msg' }, context);

    expect(emitted[0].proactive).toBe(true);
  });

  test('should emit proactive flag when targeting telegram channel', async () => {
    const emitted: any[] = [];
    eventBus.on(Events.AGENT_RESPONSE, (data) => emitted.push(data));

    await tool.execute(
      { message: 'telegram msg', channel: 'telegram', user_id: '555' },
      context,
    );

    expect(emitted[0].proactive).toBe(true);
    expect(emitted[0].channelId).toBe('telegram');
  });
});
