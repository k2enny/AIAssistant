/**
 * Tests for TaskTool
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskTool } from '../src/tools/builtin/task';
import { TaskManager } from '../src/core/task-manager';
import { EventBus } from '../src/core/event-bus';
import { ToolContext } from '../src/core/interfaces';

describe('TaskTool', () => {
  let tool: TaskTool;
  let manager: TaskManager;
  let eventBus: EventBus;
  let tasksDir: string;
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  beforeEach(() => {
    eventBus = new EventBus();
    tasksDir = path.join('/tmp', `aiassistant-test-task-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new TaskManager(eventBus, tasksDir);
    tool = new TaskTool(manager);
  });

  afterEach(() => {
    manager.stopAll();
    if (fs.existsSync(tasksDir)) {
      fs.rmSync(tasksDir, { recursive: true, force: true });
    }
  });

  const sampleCode = `module.exports = async function() { return true; };`;

  test('should have correct schema', () => {
    expect(tool.schema.name).toBe('task');
    expect(tool.schema.category).toBe('system');
  });

  test('should validate create requires name and code', () => {
    const result = tool.validate!({ action: 'create' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name is required for create action');
    expect(result.errors).toContain('code is required for create action');
  });

  test('should validate pause requires task_id', () => {
    const result = tool.validate!({ action: 'pause' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('task_id is required for this action');
  });

  test('should validate list action with no extra params', () => {
    const result = tool.validate!({ action: 'list' });
    expect(result.valid).toBe(true);
  });

  test('should handle dry run', async () => {
    const dryContext = { ...context, dryRun: true };
    const result = await tool.execute({ action: 'create', name: 'test', code: sampleCode }, dryContext);
    expect(result.success).toBe(true);
    expect(result.output).toContain('[DRY RUN]');
  });

  test('create should create and start a task', async () => {
    const result = await tool.execute({
      action: 'create',
      name: 'my-task',
      description: 'Check emails',
      code: sampleCode,
      interval_seconds: 30,
    }, context);

    expect(result.success).toBe(true);
    expect(result.output.task.name).toBe('my-task');
    expect(result.output.task.status).toBe('running');
    expect(result.output.task.intervalMs).toBe(30000);
  });

  test('list should return created tasks', async () => {
    await tool.execute({
      action: 'create',
      name: 't1',
      code: sampleCode,
      interval_seconds: 60,
    }, context);

    const result = await tool.execute({ action: 'list' }, context);
    expect(result.success).toBe(true);
    expect(result.output.count).toBe(1);
    expect(result.output.tasks[0].name).toBe('t1');
  });

  test('pause should pause a running task', async () => {
    const createResult = await tool.execute({
      action: 'create',
      name: 'pausable',
      code: sampleCode,
      interval_seconds: 60,
    }, context);

    const taskId = createResult.output.task.id;
    const result = await tool.execute({ action: 'pause', task_id: taskId }, context);
    expect(result.success).toBe(true);
    expect(result.output.task.status).toBe('paused');
  });

  test('resume should resume a paused task', async () => {
    const createResult = await tool.execute({
      action: 'create',
      name: 'resumable',
      code: sampleCode,
      interval_seconds: 60,
    }, context);

    const taskId = createResult.output.task.id;
    await tool.execute({ action: 'pause', task_id: taskId }, context);
    const result = await tool.execute({ action: 'resume', task_id: taskId }, context);
    expect(result.success).toBe(true);
    expect(result.output.task.status).toBe('running');
  });

  test('delete should remove a task', async () => {
    const createResult = await tool.execute({
      action: 'create',
      name: 'deletable',
      code: sampleCode,
      interval_seconds: 60,
    }, context);

    const taskId = createResult.output.task.id;
    const result = await tool.execute({ action: 'delete', task_id: taskId }, context);
    expect(result.success).toBe(true);
    expect(result.output.message).toContain('deleted');

    const listResult = await tool.execute({ action: 'list' }, context);
    expect(listResult.output.count).toBe(0);
  });

  test('get should return task details', async () => {
    const createResult = await tool.execute({
      action: 'create',
      name: 'gettable',
      code: sampleCode,
      interval_seconds: 60,
    }, context);

    const taskId = createResult.output.task.id;
    const result = await tool.execute({ action: 'get', task_id: taskId }, context);
    expect(result.success).toBe(true);
    expect(result.output.name).toBe('gettable');
  });

  test('get should fail for unknown task', async () => {
    const result = await tool.execute({ action: 'get', task_id: 'no-such-id' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
