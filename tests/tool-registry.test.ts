import { ToolRegistry } from '../src/tools/registry';
import { EventBus } from '../src/core/event-bus';
import { Tool, ToolSchema, ToolResult, ToolContext } from '../src/core/interfaces';
import { ShellTool } from '../src/tools/builtin/shell';
import { DateTimeTool } from '../src/tools/builtin/datetime';

class MockTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'mock_tool',
    description: 'A mock tool for testing',
    parameters: [
      { name: 'input', type: 'string', description: 'Input value', required: true },
    ],
    returns: 'Mock result',
    category: 'test',
    permissions: [],
  };

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    return { success: true, output: `Mock: ${params.input}` };
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    registry = new ToolRegistry(eventBus);
  });

  test('should register and retrieve tools', () => {
    const tool = new MockTool();
    registry.register(tool);
    expect(registry.has('mock_tool')).toBe(true);
    expect(registry.get('mock_tool')).toBe(tool);
  });

  test('should throw on duplicate registration', () => {
    registry.register(new MockTool());
    expect(() => registry.register(new MockTool())).toThrow('Tool already registered');
  });

  test('should unregister tools', () => {
    registry.register(new MockTool());
    registry.unregister('mock_tool');
    expect(registry.has('mock_tool')).toBe(false);
  });

  test('should throw on unregistering non-existent tool', () => {
    expect(() => registry.unregister('nonexistent')).toThrow('Tool not found');
  });

  test('should list all tools', () => {
    registry.register(new MockTool());
    registry.register(new ShellTool());
    expect(registry.getAll().length).toBe(2);
  });

  test('should get schemas', () => {
    registry.register(new MockTool());
    const schemas = registry.getSchemas();
    expect(schemas.length).toBe(1);
    expect(schemas[0].name).toBe('mock_tool');
  });

  test('should filter by category', () => {
    registry.register(new MockTool());
    registry.register(new ShellTool());
    
    const testTools = registry.getByCategory('test');
    expect(testTools.length).toBe(1);
    
    const systemTools = registry.getByCategory('system');
    expect(systemTools.length).toBe(1);
  });

  test('should emit events on register/unregister', () => {
    let registered = false;
    let unregistered = false;
    
    eventBus.on('tool:registered', () => { registered = true; });
    eventBus.on('tool:unregistered', () => { unregistered = true; });
    
    registry.register(new MockTool());
    expect(registered).toBe(true);
    
    registry.unregister('mock_tool');
    expect(unregistered).toBe(true);
  });

  test('should serialize to JSON', () => {
    registry.register(new MockTool());
    const json = registry.toJSON();
    expect(json.length).toBe(1);
    expect(json[0].name).toBe('mock_tool');
    expect(json[0].description).toBeDefined();
  });

  test('getToolbox should return callable functions for each registered tool', async () => {
    registry.register(new MockTool());
    registry.register(new DateTimeTool());

    const toolbox = registry.getToolbox();
    expect(typeof toolbox.mock_tool).toBe('function');
    expect(typeof toolbox.datetime).toBe('function');
  });

  test('getToolbox functions should execute tools and return results', async () => {
    registry.register(new MockTool());

    const toolbox = registry.getToolbox();
    const result = await toolbox.mock_tool({ input: 'hello' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('Mock: hello');
  });

  test('getToolbox should reflect dynamically registered tools', () => {
    registry.register(new MockTool());
    const toolbox1 = registry.getToolbox();
    expect(toolbox1.mock_tool).toBeDefined();
    expect(toolbox1.datetime).toBeUndefined();

    registry.register(new DateTimeTool());
    const toolbox2 = registry.getToolbox();
    expect(toolbox2.datetime).toBeDefined();
  });
});

describe('ShellTool', () => {
  const tool = new ShellTool();
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  test('should execute simple commands', async () => {
    const result = await tool.execute({ command: 'echo hello' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
  });

  test('should handle dry run', async () => {
    const dryContext = { ...context, dryRun: true };
    const result = await tool.execute({ command: 'rm -rf /' }, dryContext);
    expect(result.success).toBe(true);
    expect(result.output).toContain('[DRY RUN]');
  });

  test('should validate parameters', () => {
    const valid = tool.validate!({ command: 'ls' });
    expect(valid.valid).toBe(true);

    const invalid = tool.validate!({});
    expect(invalid.valid).toBe(false);
  });

  test('should block dangerous commands', () => {
    const result = tool.validate!({ command: 'rm -rf /' });
    expect(result.valid).toBe(false);
  });
});

describe('DateTimeTool', () => {
  const tool = new DateTimeTool();
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  test('should return current time', async () => {
    const result = await tool.execute({ action: 'now' }, context);
    expect(result.success).toBe(true);
    expect(result.output.iso).toBeDefined();
    expect(result.output.unix).toBeDefined();
  });

  test('should parse dates', async () => {
    const result = await tool.execute({ action: 'parse', date: '2024-01-01' }, context);
    expect(result.success).toBe(true);
    expect(result.output.iso).toBeDefined();
  });

  test('should calculate date differences', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const result = await tool.execute({ action: 'diff', date: future }, context);
    expect(result.success).toBe(true);
    expect(result.output.past).toBe(false);
  });

  test('should handle invalid actions', async () => {
    const result = await tool.execute({ action: 'invalid' }, context);
    expect(result.success).toBe(false);
  });
});
