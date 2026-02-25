/**
 * Tests for SubAgentTool
 */
import { SubAgentTool } from '../src/tools/builtin/subagent';
import { SubAgentManager } from '../src/core/subagent-manager';
import { EventBus } from '../src/core/event-bus';
import { ToolContext } from '../src/core/interfaces';

describe('SubAgentTool', () => {
  let tool: SubAgentTool;
  let manager: SubAgentManager;
  let eventBus: EventBus;
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new SubAgentManager(eventBus);
    tool = new SubAgentTool(manager);
  });

  afterEach(() => {
    manager.stopAll();
  });

  test('should have correct schema', () => {
    expect(tool.schema.name).toBe('subagent');
    expect(tool.schema.category).toBe('system');
  });

  test('should validate spawn requires name and task_type', () => {
    const result = tool.validate!({ action: 'spawn' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name is required for spawn action');
    expect(result.errors).toContain('task_type is required for spawn action');
  });

  test('should validate pause requires agent_id', () => {
    const result = tool.validate!({ action: 'pause' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('agent_id is required for this action');
  });

  test('should validate list action with no extra params', () => {
    const result = tool.validate!({ action: 'list' });
    expect(result.valid).toBe(true);
  });

  test('should handle dry run', async () => {
    const dryContext = { ...context, dryRun: true };
    const result = await tool.execute({ action: 'spawn', name: 'test', task_type: 'email_watcher' }, dryContext);
    expect(result.success).toBe(true);
    expect(result.output).toContain('[DRY RUN]');
  });

  test('spawn should create a sub-agent', async () => {
    const result = await tool.execute({
      action: 'spawn',
      name: 'my-watcher',
      task_type: 'email_watcher',
      description: 'Watches for important emails',
      interval_minutes: 10,
    }, context);

    expect(result.success).toBe(true);
    expect(result.output.agent.name).toBe('my-watcher');
    expect(result.output.agent.status).toBe('running');
  });

  test('spawn should reject unknown task type', async () => {
    const result = await tool.execute({
      action: 'spawn',
      name: 'bad',
      task_type: 'nonexistent',
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown task type');
  });

  test('list should return spawned agents', async () => {
    await tool.execute({
      action: 'spawn',
      name: 'w1',
      task_type: 'email_watcher',
    }, context);

    const result = await tool.execute({ action: 'list' }, context);
    expect(result.success).toBe(true);
    expect(result.output.count).toBe(1);
    expect(result.output.agents[0].name).toBe('w1');
  });

  test('pause should pause a running agent', async () => {
    const spawnResult = await tool.execute({
      action: 'spawn',
      name: 'pausable',
      task_type: 'email_watcher',
      interval_minutes: 60,
    }, context);

    const agentId = spawnResult.output.agent.id;
    const result = await tool.execute({ action: 'pause', agent_id: agentId }, context);
    expect(result.success).toBe(true);
    expect(result.output.agent.status).toBe('paused');
  });

  test('resume should resume a paused agent', async () => {
    const spawnResult = await tool.execute({
      action: 'spawn',
      name: 'resumable',
      task_type: 'email_watcher',
      interval_minutes: 60,
    }, context);

    const agentId = spawnResult.output.agent.id;
    await tool.execute({ action: 'pause', agent_id: agentId }, context);
    const result = await tool.execute({ action: 'resume', agent_id: agentId }, context);
    expect(result.success).toBe(true);
    expect(result.output.agent.status).toBe('running');
  });

  test('delete should remove an agent', async () => {
    const spawnResult = await tool.execute({
      action: 'spawn',
      name: 'deletable',
      task_type: 'email_watcher',
      interval_minutes: 60,
    }, context);

    const agentId = spawnResult.output.agent.id;
    const result = await tool.execute({ action: 'delete', agent_id: agentId }, context);
    expect(result.success).toBe(true);
    expect(result.output.message).toContain('deleted');

    // Verify it's gone
    const listResult = await tool.execute({ action: 'list' }, context);
    expect(listResult.output.count).toBe(0);
  });

  test('get should return agent details', async () => {
    const spawnResult = await tool.execute({
      action: 'spawn',
      name: 'gettable',
      task_type: 'email_watcher',
    }, context);

    const agentId = spawnResult.output.agent.id;
    const result = await tool.execute({ action: 'get', agent_id: agentId }, context);
    expect(result.success).toBe(true);
    expect(result.output.name).toBe('gettable');
  });

  test('get should fail for unknown agent', async () => {
    const result = await tool.execute({ action: 'get', agent_id: 'no-such-id' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('should support custom task type registration', async () => {
    const executeFn = jest.fn().mockResolvedValue(undefined);
    tool.registerTaskType('custom_task', (config, intervalMs) => ({
      description: `Custom: ${config.label || 'default'}`,
      intervalMs,
      execute: executeFn,
    }));

    const result = await tool.execute({
      action: 'spawn',
      name: 'custom-agent',
      task_type: 'custom_task',
      task_config: { label: 'my custom task' },
    }, context);

    expect(result.success).toBe(true);
    expect(result.output.agent.name).toBe('custom-agent');

    // Wait for execution
    await new Promise(r => setTimeout(r, 50));
    expect(executeFn).toHaveBeenCalled();
  });
});
