/**
 * Tests for SelfAwarenessTool
 */
import { SelfAwarenessTool, SelfAwarenessContext } from '../src/tools/builtin/self-awareness';
import { ToolContext } from '../src/core/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SelfAwarenessTool', () => {
  let tool: SelfAwarenessTool;
  let tmpDir: string;
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  const mockCtx: SelfAwarenessContext = {
    getTools: () => [
      { name: 'shell_exec', description: 'Execute shell commands', category: 'system' },
      { name: 'gmail', description: 'Gmail integration', category: 'communication' },
    ],
    getPlugins: () => [
      { name: 'example-plugin', version: '1.0.0', description: 'Example' },
    ],
    getChannels: () => ['tui', 'telegram'],
    getActiveWorkflows: () => 2,
    getUptime: () => 3600,
    getSubAgents: () => [
      { id: 'sa-1', name: 'email-watcher', description: 'Watches email', status: 'running' },
    ],
    getSkills: () => [
      { id: 'sk-1', name: 'fetch-url', description: 'Fetches a URL', useCount: 3 },
    ],
    getTasks: () => [
      { id: 'tk-1', name: 'check-email', description: 'Check emails', status: 'running', intervalMs: 30000 },
    ],
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiassistant-sa-test-'));
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    process.env.AIASSISTANT_HOME = tmpDir;
    tool = new SelfAwarenessTool();
    tool.setContext(mockCtx);
  });

  afterEach(() => {
    delete process.env.AIASSISTANT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should have correct schema', () => {
    expect(tool.schema.name).toBe('self_awareness');
    expect(tool.schema.category).toBe('system');
  });

  test('should validate action parameter', () => {
    expect(tool.validate!({ action: 'capabilities' }).valid).toBe(true);
    expect(tool.validate!({ action: 'machine' }).valid).toBe(true);
    expect(tool.validate!({ action: 'invalid' }).valid).toBe(false);
    expect(tool.validate!({}).valid).toBe(false);
  });

  test('capabilities should return tools list', async () => {
    const result = await tool.execute({ action: 'capabilities' }, context);
    expect(result.success).toBe(true);
    expect(result.output.tools.length).toBe(2);
    expect(result.output.tools[0].name).toBe('shell_exec');
  });

  test('config should return configuration info', async () => {
    // Write a test config
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'config.json'),
      JSON.stringify({ llm: { model: 'test-model' } })
    );

    const result = await tool.execute({ action: 'config' }, context);
    expect(result.success).toBe(true);
    expect(result.output.homeDir).toBe(tmpDir);
    expect(result.output.config.llm.model).toBe('test-model');
    expect(result.output.secrets.gmail).toBe('not configured');
  });

  test('config should detect gmail credentials', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'gmail-credentials.json'),
      JSON.stringify({ client_id: 'x', client_secret: 'y', refresh_token: 'z' })
    );

    const result = await tool.execute({ action: 'config' }, context);
    expect(result.success).toBe(true);
    expect(result.output.secrets.gmail).toBe('configured');
  });

  test('machine should return machine info', async () => {
    const result = await tool.execute({ action: 'machine' }, context);
    expect(result.success).toBe(true);
    expect(result.output.hostname).toBeDefined();
    expect(result.output.platform).toBeDefined();
    expect(result.output.cpuCores).toBeGreaterThan(0);
    expect(result.output.nodeVersion).toBeDefined();
  });

  test('channels should return connected channels', async () => {
    const result = await tool.execute({ action: 'channels' }, context);
    expect(result.success).toBe(true);
    expect(result.output.connectedChannels).toEqual(['tui', 'telegram']);
  });

  test('plugins should return loaded plugins', async () => {
    const result = await tool.execute({ action: 'plugins' }, context);
    expect(result.success).toBe(true);
    expect(result.output.loadedPlugins.length).toBe(1);
    expect(result.output.loadedPlugins[0].name).toBe('example-plugin');
  });

  test('status should return overall status', async () => {
    const result = await tool.execute({ action: 'status' }, context);
    expect(result.success).toBe(true);
    expect(result.output.activeWorkflows).toBe(2);
    expect(result.output.tools).toBe(2);
    expect(result.output.subagents).toBe(1);
  });

  test('subagents should return sub-agent list', async () => {
    const result = await tool.execute({ action: 'subagents' }, context);
    expect(result.success).toBe(true);
    expect(result.output.count).toBe(1);
    expect(result.output.agents[0].name).toBe('email-watcher');
  });

  test('code_info should return source structure', async () => {
    const result = await tool.execute({ action: 'code_info' }, context);
    expect(result.success).toBe(true);
    expect(result.output.project).toBe('AIAssistant');
    expect(result.output.architecture).toBeDefined();
    expect(Object.keys(result.output.architecture).length).toBeGreaterThan(0);
  });

  test('should work without context set (empty data)', async () => {
    const toolNoCtx = new SelfAwarenessTool();
    process.env.AIASSISTANT_HOME = tmpDir;

    const result = await toolNoCtx.execute({ action: 'capabilities' }, context);
    expect(result.success).toBe(true);
    expect(result.output.tools).toEqual([]);
  });
});
