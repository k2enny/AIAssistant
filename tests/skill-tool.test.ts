/**
 * Tests for SkillTool
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTool } from '../src/tools/builtin/skill';
import { SkillManager } from '../src/core/skill-manager';
import { EventBus } from '../src/core/event-bus';
import { ToolContext } from '../src/core/interfaces';

describe('SkillTool', () => {
  let tool: SkillTool;
  let manager: SkillManager;
  let eventBus: EventBus;
  let skillsDir: string;
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  beforeEach(() => {
    eventBus = new EventBus();
    skillsDir = path.join('/tmp', `aiassistant-test-skill-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new SkillManager(eventBus, skillsDir);
    tool = new SkillTool(manager);
  });

  afterEach(() => {
    if (fs.existsSync(skillsDir)) {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  const sampleCode = `module.exports = async function(params) { return { sum: (params.a || 0) + (params.b || 0) }; };`;

  test('should have correct schema', () => {
    expect(tool.schema.name).toBe('skill');
    expect(tool.schema.category).toBe('system');
  });

  test('should validate create requires name and code', () => {
    const result = tool.validate!({ action: 'create' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('name is required for create action');
    expect(result.errors).toContain('code is required for create action');
  });

  test('should validate execute requires skill_id', () => {
    const result = tool.validate!({ action: 'execute' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('skill_id is required for this action');
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

  test('create should create a skill', async () => {
    const result = await tool.execute({
      action: 'create',
      name: 'adder',
      description: 'Adds two numbers',
      code: sampleCode,
    }, context);

    expect(result.success).toBe(true);
    expect(result.output.skill.name).toBe('adder');
  });

  test('list should return created skills', async () => {
    await tool.execute({ action: 'create', name: 's1', code: sampleCode }, context);

    const result = await tool.execute({ action: 'list' }, context);
    expect(result.success).toBe(true);
    expect(result.output.count).toBe(1);
    expect(result.output.skills[0].name).toBe('s1');
  });

  test('execute should run a skill and return result', async () => {
    const createResult = await tool.execute({
      action: 'create',
      name: 'calc',
      code: sampleCode,
    }, context);

    const skillId = createResult.output.skill.id;
    const result = await tool.execute({
      action: 'execute',
      skill_id: skillId,
      params: { a: 5, b: 3 },
    }, context);

    expect(result.success).toBe(true);
    expect(result.output.result).toEqual({ sum: 8 });
  });

  test('execute should resolve by name', async () => {
    await tool.execute({
      action: 'create',
      name: 'by-name-exec',
      code: sampleCode,
    }, context);

    const result = await tool.execute({
      action: 'execute',
      skill_id: 'by-name-exec',
      params: { a: 2, b: 3 },
    }, context);

    expect(result.success).toBe(true);
    expect(result.output.result).toEqual({ sum: 5 });
  });

  test('get should return skill details', async () => {
    const createResult = await tool.execute({
      action: 'create',
      name: 'gettable',
      code: sampleCode,
    }, context);

    const skillId = createResult.output.skill.id;
    const result = await tool.execute({ action: 'get', skill_id: skillId }, context);
    expect(result.success).toBe(true);
    expect(result.output.name).toBe('gettable');
  });

  test('get should fail for unknown skill', async () => {
    const result = await tool.execute({ action: 'get', skill_id: 'no-such-id' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('delete should remove a skill', async () => {
    const createResult = await tool.execute({
      action: 'create',
      name: 'deletable',
      code: sampleCode,
    }, context);

    const skillId = createResult.output.skill.id;
    const result = await tool.execute({ action: 'delete', skill_id: skillId }, context);
    expect(result.success).toBe(true);
    expect(result.output.message).toContain('deleted');

    const listResult = await tool.execute({ action: 'list' }, context);
    expect(listResult.output.count).toBe(0);
  });
});
