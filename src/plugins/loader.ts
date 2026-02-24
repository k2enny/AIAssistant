/**
 * Plugin loader with hot-reload support
 * Discovers, loads, unloads, and reloads plugins at runtime
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  Plugin,
  PluginMetadata,
  PluginContext,
  Tool,
  StorageInterface,
  EventBusInterface,
  Logger,
} from '../core/interfaces';
import { Events } from '../core/event-bus';
import { ToolRegistry } from '../tools/registry';

export interface LoadedPlugin {
  metadata: PluginMetadata;
  plugin: Plugin;
  path: string;
  loadedAt: Date;
  tools: string[];
}

export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private pluginDirs: string[];
  private storage: StorageInterface;
  private eventBus: EventBusInterface;
  private toolRegistry: ToolRegistry;
  private logger: Logger;

  constructor(
    storage: StorageInterface,
    eventBus: EventBusInterface,
    toolRegistry: ToolRegistry,
    logger: Logger,
    pluginDirs?: string[]
  ) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.toolRegistry = toolRegistry;
    this.logger = logger;
    
    const homeDir = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant');
    this.pluginDirs = pluginDirs || [
      path.join(homeDir, 'plugins'),
      path.join(process.cwd(), 'plugins'),
    ];
  }

  async initialize(): Promise<void> {
    // Ensure plugin directories exist
    for (const dir of this.pluginDirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  async discoverPlugins(): Promise<PluginMetadata[]> {
    const discovered: PluginMetadata[] = [];
    
    for (const dir of this.pluginDirs) {
      if (!fs.existsSync(dir)) continue;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const metadataPath = path.join(dir, entry.name, 'plugin.json');
        if (!fs.existsSync(metadataPath)) continue;
        
        try {
          const raw = fs.readFileSync(metadataPath, 'utf-8');
          const metadata: PluginMetadata = JSON.parse(raw);
          discovered.push(metadata);
        } catch (err: any) {
          this.logger.warn(`Failed to read plugin metadata: ${metadataPath}`, { error: err.message });
        }
      }
    }
    
    return discovered;
  }

  async loadPlugin(pluginName: string): Promise<LoadedPlugin> {
    // Validate plugin name to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(pluginName)) {
      throw new Error(`Invalid plugin name: ${pluginName}`);
    }

    // Find plugin directory
    let pluginPath: string | null = null;
    for (const dir of this.pluginDirs) {
      const candidate = path.join(dir, pluginName);
      // Ensure the resolved path is within the plugin directory
      const resolvedCandidate = path.resolve(candidate);
      const resolvedDir = path.resolve(dir);
      if (!resolvedCandidate.startsWith(resolvedDir + path.sep)) {
        continue;
      }
      if (fs.existsSync(path.join(candidate, 'plugin.json'))) {
        pluginPath = candidate;
        break;
      }
    }
    
    if (!pluginPath) {
      throw new Error(`Plugin not found: ${pluginName}`);
    }
    
    // Read metadata
    const metadataRaw = fs.readFileSync(path.join(pluginPath, 'plugin.json'), 'utf-8');
    const metadata: PluginMetadata = JSON.parse(metadataRaw);
    
    // Load the plugin module
    const entryPoint = path.join(pluginPath, 'index.js');
    if (!fs.existsSync(entryPoint)) {
      throw new Error(`Plugin entry point not found: ${entryPoint}`);
    }
    
    // Clear module cache for hot-reload
    this.clearModuleCache(pluginPath);
    
    const pluginModule = require(entryPoint);
    const PluginClass = pluginModule.default || pluginModule;
    
    if (typeof PluginClass !== 'function') {
      throw new Error(`Plugin ${pluginName} does not export a constructor`);
    }
    
    const plugin: Plugin = new PluginClass();
    
    // Create plugin context
    const registeredTools: string[] = [];
    const context: PluginContext = {
      storage: this.storage,
      eventBus: this.eventBus,
      logger: this.logger,
      registerTool: (tool: Tool) => {
        this.toolRegistry.register(tool);
        registeredTools.push(tool.schema.name);
      },
      unregisterTool: (name: string) => {
        this.toolRegistry.unregister(name);
        const idx = registeredTools.indexOf(name);
        if (idx >= 0) registeredTools.splice(idx, 1);
      },
    };
    
    // Initialize plugin
    await plugin.initialize(context);
    
    const loaded: LoadedPlugin = {
      metadata,
      plugin,
      path: pluginPath,
      loadedAt: new Date(),
      tools: registeredTools,
    };
    
    this.plugins.set(pluginName, loaded);
    
    this.eventBus.emit(Events.PLUGIN_LOADED, { name: pluginName, metadata });
    this.logger.info(`Plugin loaded: ${pluginName} v${metadata.version}`);
    
    return loaded;
  }

  async unloadPlugin(pluginName: string): Promise<void> {
    const loaded = this.plugins.get(pluginName);
    if (!loaded) {
      throw new Error(`Plugin not loaded: ${pluginName}`);
    }
    
    // Unregister tools
    for (const toolName of loaded.tools) {
      try {
        this.toolRegistry.unregister(toolName);
      } catch {
        // Tool may already be unregistered
      }
    }
    
    // Shutdown plugin
    await loaded.plugin.shutdown();
    
    // Clear module cache
    this.clearModuleCache(loaded.path);
    
    this.plugins.delete(pluginName);
    
    this.eventBus.emit(Events.PLUGIN_UNLOADED, { name: pluginName });
    this.logger.info(`Plugin unloaded: ${pluginName}`);
  }

  async reloadPlugin(pluginName: string): Promise<LoadedPlugin> {
    if (this.plugins.has(pluginName)) {
      await this.unloadPlugin(pluginName);
    }
    const loaded = await this.loadPlugin(pluginName);
    this.eventBus.emit(Events.PLUGIN_RELOADED, { name: pluginName });
    return loaded;
  }

  getLoadedPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  isLoaded(pluginName: string): boolean {
    return this.plugins.has(pluginName);
  }

  private clearModuleCache(pluginPath: string): void {
    // Try to resolve and clear the exact entry point first
    const entryPoint = path.join(pluginPath, 'index.js');
    try {
      const resolvedEntry = require.resolve(entryPoint);
      delete require.cache[resolvedEntry];
    } catch {
      // Entry point not yet cached
    }
    // Also clear any other files from this plugin directory
    const resolvedPath = path.resolve(pluginPath);
    Object.keys(require.cache).forEach(key => {
      if (key.startsWith(resolvedPath)) {
        delete require.cache[key];
      }
    });
  }
}
