/**
 * Tests for TaskManager
 */
import * as fs from 'fs';
import * as path from 'path';
import { TaskManager } from '../src/core/task-manager';
import { EventBus } from '../src/core/event-bus';

describe('TaskManager', () => {
  let manager: TaskManager;
  let eventBus: EventBus;
  let tasksDir: string;

  beforeEach(() => {
    eventBus = new EventBus();
    tasksDir = path.join('/tmp', `aiassistant-test-tasks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new TaskManager(eventBus, tasksDir);
  });

  afterEach(() => {
    manager.stopAll();
    if (fs.existsSync(tasksDir)) {
      fs.rmSync(tasksDir, { recursive: true, force: true });
    }
  });

  const sampleCode = `module.exports = async function() { return true; };`;

  test('should create a task and assign an id', () => {
    const info = manager.create('check-mails', 'Check emails', sampleCode, 30000);

    expect(info.id).toBeDefined();
    expect(info.name).toBe('check-mails');
    expect(info.description).toBe('Check emails');
    expect(info.status).toBe('running');
    expect(info.intervalMs).toBe(30000);
    expect(info.runCount).toBe(0);
  });

  test('should persist task code to disk', () => {
    const info = manager.create('disk-test', 'Disk test', sampleCode, 60000);
    expect(fs.existsSync(info.filePath)).toBe(true);

    const metaPath = path.join(path.dirname(info.filePath), 'meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);
  });

  test('should list created tasks', () => {
    manager.create('t1', 'Task 1', sampleCode, 60000);
    manager.create('t2', 'Task 2', sampleCode, 60000);

    const list = manager.list();
    expect(list.length).toBe(2);
    expect(list.map(t => t.name).sort()).toEqual(['t1', 't2']);
  });

  test('should get a task by id', () => {
    const info = manager.create('get-test', 'Get test', sampleCode, 60000);
    const retrieved = manager.get(info.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('get-test');
  });

  test('should return undefined for unknown id', () => {
    expect(manager.get('no-such-id')).toBeUndefined();
  });

  test('should pause a running task', () => {
    const info = manager.create('pausable', 'Pausable', sampleCode, 60000);
    const paused = manager.pause(info.id);
    expect(paused.status).toBe('paused');
  });

  test('should throw when pausing a non-running task', () => {
    const info = manager.create('not-running', 'Not running', sampleCode, 60000);
    manager.pause(info.id);
    expect(() => manager.pause(info.id)).toThrow('not running');
  });

  test('should resume a paused task', () => {
    const info = manager.create('resumable', 'Resumable', sampleCode, 60000);
    manager.pause(info.id);
    const resumed = manager.resume(info.id);
    expect(resumed.status).toBe('running');
  });

  test('should throw when resuming a non-paused task', () => {
    const info = manager.create('running', 'Running', sampleCode, 60000);
    expect(() => manager.resume(info.id)).toThrow('not paused');
  });

  test('should delete a task and remove files', () => {
    const info = manager.create('deletable', 'Deletable', sampleCode, 60000);
    const dir = path.dirname(info.filePath);
    expect(fs.existsSync(dir)).toBe(true);

    manager.delete(info.id);
    expect(manager.list().length).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('should throw when deleting unknown task', () => {
    expect(() => manager.delete('no-such-id')).toThrow('not found');
  });

  test('should prevent duplicate task names', () => {
    manager.create('unique', 'Unique task', sampleCode, 60000);
    expect(() => manager.create('unique', 'Duplicate', sampleCode, 60000)).toThrow('already exists');
  });

  test('should emit TASK_CREATED event', () => {
    const handler = jest.fn();
    eventBus.on('task:created', handler);
    manager.create('event-test', 'Event test', sampleCode, 60000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].name).toBe('event-test');
  });

  test('should emit TASK_PAUSED event', () => {
    const handler = jest.fn();
    eventBus.on('task:paused', handler);
    const info = manager.create('pause-event', 'Pause event', sampleCode, 60000);
    manager.pause(info.id);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should emit TASK_RESUMED event', () => {
    const handler = jest.fn();
    eventBus.on('task:resumed', handler);
    const info = manager.create('resume-event', 'Resume event', sampleCode, 60000);
    manager.pause(info.id);
    manager.resume(info.id);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should emit TASK_DELETED event', () => {
    const handler = jest.fn();
    eventBus.on('task:deleted', handler);
    const info = manager.create('del-event', 'Delete event', sampleCode, 60000);
    manager.delete(info.id);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should execute task code after interval', async () => {
    // Use a very short interval
    const code = `let count = 0; module.exports = async function() { count++; };`;
    const info = manager.create('fast-task', 'Fast', code, 50);

    // Wait for at least one execution
    await new Promise(r => setTimeout(r, 200));

    const updated = manager.get(info.id);
    expect(updated!.runCount).toBeGreaterThanOrEqual(1);
  });

  test('stopAll should stop all tasks', () => {
    manager.create('t1', 'Task 1', sampleCode, 60000);
    manager.create('t2', 'Task 2', sampleCode, 60000);

    manager.stopAll();

    const list = manager.list();
    expect(list.every(t => t.status === 'stopped')).toBe(true);
  });

  test('should start a stopped task', () => {
    const info = manager.create('startable', 'Startable', sampleCode, 60000);
    manager.pause(info.id);
    const task = manager.get(info.id)!;
    // Manually set to stopped to test start
    manager.stopAll();
    const started = manager.start(info.id);
    expect(started.status).toBe('running');
  });

  test('should load tasks from disk', () => {
    manager.create('persist1', 'Persistent 1', sampleCode, 60000);
    manager.create('persist2', 'Persistent 2', sampleCode, 60000);
    manager.stopAll();

    const manager2 = new TaskManager(eventBus, tasksDir);
    manager2.loadFromDisk();

    const list = manager2.list();
    expect(list.length).toBe(2);
    expect(list.map(t => t.name).sort()).toEqual(['persist1', 'persist2']);
    // Tasks loaded from disk should be stopped (not auto-started)
    expect(list.every(t => t.status === 'stopped')).toBe(true);
  });

  test('should pass tools context to task function when toolRegistry is provided', async () => {
    const { ToolRegistry } = require('../src/tools/registry');
    const { DateTimeTool } = require('../src/tools/builtin/datetime');

    const registry = new ToolRegistry(eventBus);
    registry.register(new DateTimeTool());

    const managerWithTools = new TaskManager(eventBus, tasksDir, registry);

    const code = `module.exports = async function(ctx) {
      if (!ctx || !ctx.tools || typeof ctx.tools.datetime !== 'function') {
        throw new Error('tools not provided');
      }
      const result = await ctx.tools.datetime({ action: 'now' });
      if (!result.success) throw new Error('datetime tool failed');
      return result;
    };`;

    const info = managerWithTools.create('tools-test', 'Test tools context', code, 50);
    await new Promise(r => setTimeout(r, 200));

    const updated = managerWithTools.get(info.id);
    expect(updated!.runCount).toBeGreaterThanOrEqual(1);
    expect(updated!.lastError).toBeUndefined();
    managerWithTools.stopAll();
  });
});
