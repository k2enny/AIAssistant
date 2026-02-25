/**
 * Tests for SubAgentManager
 */
import { SubAgentManager, SubAgentTask } from '../src/core/subagent-manager';
import { EventBus } from '../src/core/event-bus';

describe('SubAgentManager', () => {
  let manager: SubAgentManager;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new SubAgentManager(eventBus);
  });

  afterEach(() => {
    manager.stopAll();
  });

  function createMockTask(opts?: Partial<SubAgentTask>): SubAgentTask {
    return {
      description: opts?.description || 'Test task',
      intervalMs: opts?.intervalMs ?? 0, // run once by default
      execute: opts?.execute || jest.fn().mockResolvedValue(undefined),
    };
  }

  test('should spawn a sub-agent and assign an id', () => {
    const task = createMockTask();
    const info = manager.spawn('test-agent', task);

    expect(info.id).toBeDefined();
    expect(info.name).toBe('test-agent');
    expect(info.status).toBe('running');
    expect(info.description).toBe('Test task');
  });

  test('should list spawned sub-agents', () => {
    manager.spawn('a1', createMockTask());
    manager.spawn('a2', createMockTask());

    const list = manager.list();
    expect(list.length).toBe(2);
    expect(list.map(a => a.name).sort()).toEqual(['a1', 'a2']);
  });

  test('should get a specific sub-agent by id', () => {
    const info = manager.spawn('agent-x', createMockTask());
    const retrieved = manager.get(info.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('agent-x');
  });

  test('should return undefined for unknown id', () => {
    expect(manager.get('no-such-id')).toBeUndefined();
  });

  test('should pause a running sub-agent', () => {
    const info = manager.spawn('pausable', createMockTask({ intervalMs: 60000 }));
    const paused = manager.pause(info.id);

    expect(paused.status).toBe('paused');
  });

  test('should throw when pausing a non-running agent', () => {
    const info = manager.spawn('pausable', createMockTask({ intervalMs: 60000 }));
    manager.pause(info.id);

    expect(() => manager.pause(info.id)).toThrow('not running');
  });

  test('should resume a paused sub-agent', () => {
    const info = manager.spawn('resumable', createMockTask({ intervalMs: 60000 }));
    manager.pause(info.id);
    const resumed = manager.resume(info.id);

    expect(resumed.status).toBe('running');
  });

  test('should throw when resuming a non-paused agent', () => {
    const info = manager.spawn('running', createMockTask({ intervalMs: 60000 }));

    expect(() => manager.resume(info.id)).toThrow('not paused');
  });

  test('should delete a sub-agent', () => {
    const info = manager.spawn('deletable', createMockTask({ intervalMs: 60000 }));
    manager.delete(info.id);

    expect(manager.list().length).toBe(0);
    expect(manager.get(info.id)).toBeUndefined();
  });

  test('should throw when deleting unknown agent', () => {
    expect(() => manager.delete('no-such-id')).toThrow('not found');
  });

  test('should emit SUBAGENT_SPAWNED event', () => {
    const handler = jest.fn();
    eventBus.on('subagent:spawned', handler);

    manager.spawn('emitter', createMockTask());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].name).toBe('emitter');
  });

  test('should emit SUBAGENT_PAUSED event', () => {
    const handler = jest.fn();
    eventBus.on('subagent:paused', handler);

    const info = manager.spawn('pauser', createMockTask({ intervalMs: 60000 }));
    manager.pause(info.id);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should emit SUBAGENT_RESUMED event', () => {
    const handler = jest.fn();
    eventBus.on('subagent:resumed', handler);

    const info = manager.spawn('resumer', createMockTask({ intervalMs: 60000 }));
    manager.pause(info.id);
    manager.resume(info.id);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should emit SUBAGENT_STOPPED event on delete', () => {
    const handler = jest.fn();
    eventBus.on('subagent:stopped', handler);

    const info = manager.spawn('stopper', createMockTask({ intervalMs: 60000 }));
    manager.delete(info.id);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should execute task on spawn', async () => {
    const executeFn = jest.fn().mockResolvedValue(undefined);
    manager.spawn('executor', createMockTask({ execute: executeFn }));

    // Wait for async execution
    await new Promise(r => setTimeout(r, 50));

    expect(executeFn).toHaveBeenCalled();
  });

  test('stopAll should clear all agents', () => {
    manager.spawn('a1', createMockTask({ intervalMs: 60000 }));
    manager.spawn('a2', createMockTask({ intervalMs: 60000 }));

    manager.stopAll();

    expect(manager.list().length).toBe(0);
  });

  test('should track run count after task execution', async () => {
    const executeFn = jest.fn().mockResolvedValue(undefined);
    const info = manager.spawn('counter', createMockTask({ execute: executeFn }));

    await new Promise(r => setTimeout(r, 50));

    const updated = manager.get(info.id);
    expect(updated?.runCount).toBeGreaterThanOrEqual(1);
  });

  test('should record lastError on task failure', async () => {
    const executeFn = jest.fn().mockRejectedValue(new Error('task boom'));
    const info = manager.spawn('errorer', createMockTask({ execute: executeFn }));

    await new Promise(r => setTimeout(r, 50));

    const updated = manager.get(info.id);
    expect(updated?.lastError).toBe('task boom');
  });

  test('should spawn sub-agent with parentId', () => {
    const parent = manager.spawn('parent', createMockTask({ intervalMs: 60000 }));
    const child = manager.spawn('child', createMockTask({ intervalMs: 60000 }), undefined, undefined, parent.id);

    expect(child.parentId).toBe(parent.id);
  });

  test('should cascade delete to child agents', () => {
    const parent = manager.spawn('parent', createMockTask({ intervalMs: 60000 }));
    const child1 = manager.spawn('child1', createMockTask({ intervalMs: 60000 }), undefined, undefined, parent.id);
    const child2 = manager.spawn('child2', createMockTask({ intervalMs: 60000 }), undefined, undefined, parent.id);
    const grandchild = manager.spawn('grandchild', createMockTask({ intervalMs: 60000 }), undefined, undefined, child1.id);

    expect(manager.list().length).toBe(4);

    manager.delete(parent.id);

    expect(manager.list().length).toBe(0);
    expect(manager.get(child1.id)).toBeUndefined();
    expect(manager.get(child2.id)).toBeUndefined();
    expect(manager.get(grandchild.id)).toBeUndefined();
  });

  test('should only delete children of the deleted agent', () => {
    const agent1 = manager.spawn('agent1', createMockTask({ intervalMs: 60000 }));
    const agent2 = manager.spawn('agent2', createMockTask({ intervalMs: 60000 }));
    const child = manager.spawn('child-of-1', createMockTask({ intervalMs: 60000 }), undefined, undefined, agent1.id);

    manager.delete(agent1.id);

    expect(manager.list().length).toBe(1);
    expect(manager.get(agent2.id)).toBeDefined();
    expect(manager.get(child.id)).toBeUndefined();
  });
});
