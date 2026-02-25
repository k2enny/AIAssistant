/**
 * Tests for SkillManager
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillManager } from '../src/core/skill-manager';
import { EventBus } from '../src/core/event-bus';

describe('SkillManager', () => {
  let manager: SkillManager;
  let eventBus: EventBus;
  let skillsDir: string;

  beforeEach(() => {
    eventBus = new EventBus();
    skillsDir = path.join('/tmp', `aiassistant-test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new SkillManager(eventBus, skillsDir);
  });

  afterEach(() => {
    if (fs.existsSync(skillsDir)) {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  const sampleCode = `module.exports = async function(params) { return { result: (params.a || 0) + (params.b || 0) }; };`;

  test('should create a skill and assign an id', () => {
    const info = manager.create('add-numbers', 'Adds two numbers', sampleCode, [
      { name: 'a', type: 'number', description: 'First number', required: true },
      { name: 'b', type: 'number', description: 'Second number', required: true },
    ]);

    expect(info.id).toBeDefined();
    expect(info.name).toBe('add-numbers');
    expect(info.description).toBe('Adds two numbers');
    expect(info.useCount).toBe(0);
  });

  test('should persist skill code to disk', () => {
    const info = manager.create('disk-test', 'Test persistence', sampleCode);
    expect(fs.existsSync(info.filePath)).toBe(true);

    const metaPath = path.join(path.dirname(info.filePath), 'meta.json');
    expect(fs.existsSync(metaPath)).toBe(true);
  });

  test('should list created skills', () => {
    manager.create('s1', 'Skill 1', sampleCode);
    manager.create('s2', 'Skill 2', sampleCode);

    const list = manager.list();
    expect(list.length).toBe(2);
    expect(list.map(s => s.name).sort()).toEqual(['s1', 's2']);
  });

  test('should get a skill by id', () => {
    const info = manager.create('get-test', 'Get test', sampleCode);
    const retrieved = manager.get(info.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('get-test');
  });

  test('should get a skill by name', () => {
    manager.create('by-name', 'By name test', sampleCode);
    const retrieved = manager.getByName('by-name');
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('by-name');
  });

  test('should return undefined for unknown id', () => {
    expect(manager.get('no-such-id')).toBeUndefined();
  });

  test('should execute a skill and return result', async () => {
    const info = manager.create('exec-test', 'Execute test', sampleCode);
    const result = await manager.execute(info.id, { a: 3, b: 7 });
    expect(result).toEqual({ result: 10 });
  });

  test('should increment useCount after execution', async () => {
    const info = manager.create('count-test', 'Count test', sampleCode);
    await manager.execute(info.id, { a: 1, b: 2 });
    await manager.execute(info.id, { a: 3, b: 4 });

    const updated = manager.get(info.id);
    expect(updated!.useCount).toBe(2);
  });

  test('should throw when executing unknown skill', async () => {
    await expect(manager.execute('no-such-id')).rejects.toThrow('not found');
  });

  test('should delete a skill and remove files', () => {
    const info = manager.create('deletable', 'Delete test', sampleCode);
    const dir = path.dirname(info.filePath);
    expect(fs.existsSync(dir)).toBe(true);

    manager.delete(info.id);
    expect(manager.list().length).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('should throw when deleting unknown skill', () => {
    expect(() => manager.delete('no-such-id')).toThrow('not found');
  });

  test('should prevent duplicate skill names', () => {
    manager.create('unique', 'Unique skill', sampleCode);
    expect(() => manager.create('unique', 'Duplicate', sampleCode)).toThrow('already exists');
  });

  test('should emit SKILL_CREATED event', () => {
    const handler = jest.fn();
    eventBus.on('skill:created', handler);
    manager.create('event-test', 'Event test', sampleCode);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].name).toBe('event-test');
  });

  test('should emit SKILL_EXECUTED event', async () => {
    const handler = jest.fn();
    eventBus.on('skill:executed', handler);
    const info = manager.create('exec-event', 'Exec event', sampleCode);
    await manager.execute(info.id, { a: 1, b: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should emit SKILL_DELETED event', () => {
    const handler = jest.fn();
    eventBus.on('skill:deleted', handler);
    const info = manager.create('del-event', 'Delete event', sampleCode);
    manager.delete(info.id);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should load skills from disk', () => {
    // Create skills in first manager
    manager.create('persist1', 'Persistent 1', sampleCode);
    manager.create('persist2', 'Persistent 2', sampleCode);

    // Create a new manager pointing at same dir
    const manager2 = new SkillManager(eventBus, skillsDir);
    manager2.loadFromDisk();

    const list = manager2.list();
    expect(list.length).toBe(2);
    expect(list.map(s => s.name).sort()).toEqual(['persist1', 'persist2']);
  });

  test('should pass tools context to skill function when toolRegistry is provided', async () => {
    const { ToolRegistry } = require('../src/tools/registry');
    const { DateTimeTool } = require('../src/tools/builtin/datetime');

    const registry = new ToolRegistry(eventBus);
    registry.register(new DateTimeTool());

    const managerWithTools = new SkillManager(eventBus, skillsDir, registry);

    const code = `module.exports = async function(params, ctx) {
      if (!ctx || !ctx.tools || typeof ctx.tools.datetime !== 'function') {
        throw new Error('tools not provided');
      }
      const result = await ctx.tools.datetime({ action: 'now' });
      if (!result.success) throw new Error('datetime tool failed');
      return { time: result.output.iso, input: params.msg };
    };`;

    const info = managerWithTools.create('tools-test', 'Test tools context', code);
    const result = await managerWithTools.execute(info.id, { msg: 'hello' });
    expect(result.time).toBeDefined();
    expect(result.input).toBe('hello');
  });
});
