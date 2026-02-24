import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PluginLoader } from '../src/plugins/loader';
import { ToolRegistry } from '../src/tools/registry';
import { EventBus } from '../src/core/event-bus';
import { StorageInterface, Logger } from '../src/core/interfaces';

// Minimal mock storage
class MockStorage implements StorageInterface {
  private data: Map<string, Map<string, any>> = new Map();
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async ensureTable(table: string): Promise<void> {
    if (!this.data.has(table)) this.data.set(table, new Map());
  }
  async get(table: string, key: string): Promise<any> {
    return this.data.get(table)?.get(key) || null;
  }
  async set(table: string, key: string, value: any): Promise<void> {
    if (!this.data.has(table)) this.data.set(table, new Map());
    this.data.get(table)!.set(key, value);
  }
  async delete(table: string, key: string): Promise<void> {
    this.data.get(table)?.delete(key);
  }
  async query(table: string): Promise<any[]> {
    return Array.from(this.data.get(table)?.values() || []);
  }
}

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('PluginLoader', () => {
  let loader: PluginLoader;
  let storage: MockStorage;
  let eventBus: EventBus;
  let toolRegistry: ToolRegistry;
  let tmpDir: string;

  beforeEach(async () => {
    storage = new MockStorage();
    eventBus = new EventBus();
    toolRegistry = new ToolRegistry(eventBus);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiassistant-test-'));
    
    loader = new PluginLoader(storage, eventBus, toolRegistry, mockLogger, [tmpDir]);
    await loader.initialize();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should discover plugins', async () => {
    // Create a test plugin
    const pluginDir = path.join(tmpDir, 'test-plugin');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test',
      permissions: [],
      tools: ['test_tool'],
    }));

    const plugins = await loader.discoverPlugins();
    expect(plugins.length).toBe(1);
    expect(plugins[0].name).toBe('test-plugin');
  });

  test('should load and unload plugins', async () => {
    // Create a minimal plugin
    const pluginDir = path.join(tmpDir, 'loadable-plugin');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'loadable-plugin',
      version: '1.0.0',
      description: 'Loadable test',
      permissions: [],
      tools: ['load_test'],
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), `
      class LoadTestTool {
        constructor() {
          this.schema = {
            name: 'load_test',
            description: 'Test tool',
            parameters: [],
            returns: 'string',
            category: 'test',
            permissions: [],
          };
        }
        async execute() { return { success: true, output: 'loaded' }; }
      }
      
      class LoadablePlugin {
        constructor() {
          this.metadata = {
            name: 'loadable-plugin',
            version: '1.0.0',
            description: 'Test',
            permissions: [],
            tools: ['load_test'],
          };
          this.tool = new LoadTestTool();
        }
        async initialize(ctx) { ctx.registerTool(this.tool); }
        async shutdown() {}
        getTools() { return [this.tool]; }
      }
      module.exports = LoadablePlugin;
    `);

    // Load
    const loaded = await loader.loadPlugin('loadable-plugin');
    expect(loaded.metadata.name).toBe('loadable-plugin');
    expect(toolRegistry.has('load_test')).toBe(true);
    expect(loader.isLoaded('loadable-plugin')).toBe(true);

    // Unload
    await loader.unloadPlugin('loadable-plugin');
    expect(toolRegistry.has('load_test')).toBe(false);
    expect(loader.isLoaded('loadable-plugin')).toBe(false);
  });

  test('should reload plugins (hot-reload)', async () => {
    const pluginDir = path.join(tmpDir, 'reload-plugin');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'reload-plugin',
      version: '1.0.0',
      description: 'Reload test',
      permissions: [],
      tools: ['reload_test'],
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), `
      class ReloadTool {
        constructor() {
          this.schema = { name: 'reload_test', description: 'v1', parameters: [], returns: 'string', category: 'test', permissions: [] };
        }
        async execute() { return { success: true, output: 'v1' }; }
      }
      class ReloadPlugin {
        constructor() {
          this.metadata = { name: 'reload-plugin', version: '1.0.0', description: 'v1', permissions: [], tools: ['reload_test'] };
          this.tool = new ReloadTool();
        }
        async initialize(ctx) { ctx.registerTool(this.tool); }
        async shutdown() {}
        getTools() { return [this.tool]; }
      }
      module.exports = ReloadPlugin;
    `);

    await loader.loadPlugin('reload-plugin');
    let tool = toolRegistry.get('reload_test');
    expect(tool?.schema.description).toBe('v1');

    // Unload first
    await loader.unloadPlugin('reload-plugin');
    expect(toolRegistry.has('reload_test')).toBe(false);
    expect(loader.isLoaded('reload-plugin')).toBe(false);

    // Write v2 to a NEW plugin dir (avoids Jest require cache issues)
    const pluginDir2 = path.join(tmpDir, 'reload-plugin-v2');
    fs.mkdirSync(pluginDir2);
    fs.writeFileSync(path.join(pluginDir2, 'plugin.json'), JSON.stringify({
      name: 'reload-plugin-v2',
      version: '2.0.0',
      description: 'Reload test v2',
      permissions: [],
      tools: ['reload_test_v2'],
    }));
    fs.writeFileSync(path.join(pluginDir2, 'index.js'), `
      class ReloadTool {
        constructor() {
          this.schema = { name: 'reload_test_v2', description: 'v2', parameters: [], returns: 'string', category: 'test', permissions: [] };
        }
        async execute() { return { success: true, output: 'v2' }; }
      }
      class ReloadPlugin {
        constructor() {
          this.metadata = { name: 'reload-plugin-v2', version: '2.0.0', description: 'v2', permissions: [], tools: ['reload_test_v2'] };
          this.tool = new ReloadTool();
        }
        async initialize(ctx) { ctx.registerTool(this.tool); }
        async shutdown() {}
        getTools() { return [this.tool]; }
      }
      module.exports = ReloadPlugin;
    `);

    // Load v2 as new plugin
    await loader.loadPlugin('reload-plugin-v2');
    tool = toolRegistry.get('reload_test_v2');
    expect(tool?.schema.description).toBe('v2');
    expect(loader.isLoaded('reload-plugin-v2')).toBe(true);
  });

  test('should emit events on load/unload', async () => {
    const pluginDir = path.join(tmpDir, 'event-plugin');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'event-plugin',
      version: '1.0.0',
      description: 'Event test',
      permissions: [],
      tools: [],
    }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), `
      class EventPlugin {
        constructor() {
          this.metadata = { name: 'event-plugin', version: '1.0.0', description: 'Event test', permissions: [], tools: [] };
        }
        async initialize() {}
        async shutdown() {}
        getTools() { return []; }
      }
      module.exports = EventPlugin;
    `);

    let loadEvent = false;
    let unloadEvent = false;
    eventBus.on('plugin:loaded', () => { loadEvent = true; });
    eventBus.on('plugin:unloaded', () => { unloadEvent = true; });

    await loader.loadPlugin('event-plugin');
    expect(loadEvent).toBe(true);

    await loader.unloadPlugin('event-plugin');
    expect(unloadEvent).toBe(true);
  });

  test('should throw on loading non-existent plugin', async () => {
    await expect(loader.loadPlugin('nonexistent')).rejects.toThrow('Plugin not found');
  });

  test('should throw on unloading non-loaded plugin', async () => {
    await expect(loader.unloadPlugin('nonexistent')).rejects.toThrow('Plugin not loaded');
  });
});
