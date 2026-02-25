/**
 * Daemon - main background service
 */
import * as fs from 'fs';
import * as path from 'path';
import winston from 'winston';
import * as crypto from 'crypto';
import { EventBus, Events, getEventBus } from '../core/event-bus';
import { SQLiteStorage } from '../storage/sqlite';
import { Vault } from '../security/vault';
import { AuditLogger } from '../security/audit';
import { PolicyEngineImpl } from '../policy/engine';
import { MemoryManager } from '../memory/manager';
import { ToolRegistry } from '../tools/registry';
import { PluginLoader } from '../plugins/loader';
import { Orchestrator } from '../core/orchestrator';
import { OpenRouterClient } from '../llm/openrouter';
import { IPCServer } from './ipc-server';
import { SubAgentManager } from '../core/subagent-manager';
import { ShellTool } from '../tools/builtin/shell';
import { DateTimeTool } from '../tools/builtin/datetime';
import { PlaywrightTool } from '../tools/builtin/playwright';
import { GmailTool } from '../tools/builtin/gmail';
import { SelfAwarenessTool } from '../tools/builtin/self-awareness';
import { SubAgentTool } from '../tools/builtin/subagent';
import { ConfigTool } from '../tools/builtin/config';
import { Message, Logger as ILogger } from '../core/interfaces';

export class Daemon {
  private eventBus: EventBus;
  private storage: SQLiteStorage;
  private vault: Vault;
  private auditLogger: AuditLogger;
  private policyEngine: PolicyEngineImpl;
  private memoryManager: MemoryManager;
  private toolRegistry: ToolRegistry;
  private pluginLoader: PluginLoader;
  private orchestrator: Orchestrator;
  private subAgentManager: SubAgentManager;
  private ipcServer: IPCServer;
  private logger: winston.Logger;
  private homeDir: string;
  private channels: Map<string, any> = new Map();
  private connectedChannels: Set<string> = new Set();
  private running = false;

  constructor() {
    this.homeDir = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant');

    // Ensure directories exist
    for (const dir of ['logs', 'data', 'plugins', 'config']) {
      const p = path.join(this.homeDir, dir);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
      }
    }

    // Initialize logger
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({
          filename: path.join(this.homeDir, 'logs', 'daemon.log'),
          maxsize: 10 * 1024 * 1024,
          maxFiles: 5,
        }),
        new winston.transports.File({
          filename: path.join(this.homeDir, 'logs', 'error.log'),
          level: 'error',
        }),
      ],
    });

    // Add console transport if not running as daemon
    if (process.env.AIASSISTANT_FOREGROUND === '1') {
      this.logger.add(new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
      }));
    }

    // Initialize components
    this.eventBus = getEventBus();
    this.storage = new SQLiteStorage();
    this.vault = new Vault(this.homeDir);
    this.auditLogger = new AuditLogger(this.homeDir);
    this.policyEngine = new PolicyEngineImpl(this.storage, this.eventBus);
    this.memoryManager = new MemoryManager(this.storage);
    this.toolRegistry = new ToolRegistry(this.eventBus);
    this.subAgentManager = new SubAgentManager(this.eventBus);

    const loggerAdapter: ILogger = {
      info: (msg, meta) => this.logger.info(msg, meta),
      warn: (msg, meta) => this.logger.warn(msg, meta),
      error: (msg, meta) => this.logger.error(msg, meta),
      debug: (msg, meta) => this.logger.debug(msg, meta),
    };

    this.pluginLoader = new PluginLoader(
      this.storage,
      this.eventBus,
      this.toolRegistry,
      loggerAdapter
    );

    this.orchestrator = new Orchestrator(
      this.eventBus,
      this.storage,
      this.toolRegistry,
      this.memoryManager,
      this.policyEngine,
      this.auditLogger
    );

    this.ipcServer = new IPCServer(this.eventBus);
  }

  async start(): Promise<void> {
    this.logger.info('Starting AIAssistant daemon...');

    try {
      // Initialize storage
      await this.storage.initialize();
      this.logger.info('Storage initialized');

      // Initialize vault
      await this.vault.initialize();
      this.logger.info('Vault initialized');

      // Initialize audit logger
      await this.auditLogger.initialize();

      // Initialize policy engine
      await this.policyEngine.initialize();
      this.logger.info('Policy engine initialized');

      // Initialize memory manager
      await this.memoryManager.initialize();
      this.logger.info('Memory manager initialized');

      // Register built-in tools
      this.registerBuiltinTools();
      this.logger.info('Built-in tools registered');

      // Initialize plugin loader
      await this.pluginLoader.initialize();

      // Load any discovered plugins
      const plugins = await this.pluginLoader.discoverPlugins();
      for (const plugin of plugins) {
        try {
          await this.pluginLoader.loadPlugin(plugin.name);
        } catch (err: any) {
          this.logger.warn(`Failed to load plugin: ${plugin.name}`, { error: err.message });
        }
      }
      this.logger.info(`Plugins loaded: ${plugins.length}`);

      // Configure LLM if API key available
      await this.configureLLM();

      // Setup IPC handlers
      this.setupIPCHandlers();

      // Start IPC server
      await this.ipcServer.start();
      this.logger.info(`IPC server started at ${this.ipcServer.getSocketPath()}`);

      this.running = true;
      this.eventBus.emit(Events.DAEMON_STARTED, { pid: process.pid });
      this.logger.info(`AIAssistant daemon started (PID: ${process.pid})`);

      // Forward events to IPC clients
      this.setupEventForwarding();

    } catch (err: any) {
      this.logger.error('Failed to start daemon', { error: err.message, stack: err.stack });
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping AIAssistant daemon...');
    this.eventBus.emit(Events.DAEMON_STOPPING, {});
    this.running = false;

    // Stop all sub-agents
    this.subAgentManager.stopAll();

    // Stop channels
    for (const [name, channel] of this.channels) {
      try {
        await channel.shutdown();
        this.logger.info(`Channel stopped: ${name}`);
      } catch (err: any) {
        this.logger.error(`Error stopping channel ${name}`, { error: err.message });
      }
    }

    // Unload plugins
    for (const plugin of this.pluginLoader.getLoadedPlugins()) {
      try {
        await this.pluginLoader.unloadPlugin(plugin.metadata.name);
      } catch (err: any) {
        this.logger.error(`Error unloading plugin ${plugin.metadata.name}`, { error: err.message });
      }
    }

    // Stop IPC server
    await this.ipcServer.stop();

    // Close storage
    await this.storage.close();

    // Close audit logger
    await this.auditLogger.close();

    // Remove PID file
    const pidFile = path.join(this.homeDir, 'daemon.pid');
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }

    this.logger.info('AIAssistant daemon stopped');
  }

  private registerBuiltinTools(): void {
    this.toolRegistry.register(new ShellTool());
    this.toolRegistry.register(new DateTimeTool());
    this.toolRegistry.register(new PlaywrightTool());
    this.toolRegistry.register(new GmailTool());
    this.toolRegistry.register(new ConfigTool(this.vault));

    const selfAwareness = new SelfAwarenessTool();
    selfAwareness.setContext({
      getTools: () => this.toolRegistry.getSchemas().map(t => ({ name: t.name, description: t.description, category: t.category })),
      getPlugins: () => this.pluginLoader.getLoadedPlugins().map(p => ({ name: p.metadata.name, version: p.metadata.version, description: p.metadata.description })),
      getChannels: () => [...Array.from(this.channels.keys()), ...Array.from(this.connectedChannels)],
      getActiveWorkflows: () => this.orchestrator.getActiveWorkflows().length,
      getUptime: () => process.uptime(),
      getSubAgents: () => this.subAgentManager.list().map(a => ({ id: a.id, name: a.name, description: a.description, status: a.status })),
    });
    this.toolRegistry.register(selfAwareness);

    this.toolRegistry.register(new SubAgentTool(this.subAgentManager));
  }

  private async configureLLM(): Promise<void> {
    const apiKey = await this.vault.getSecret('openrouter_api_key');
    if (apiKey) {
      const configPath = path.join(this.homeDir, 'config', 'config.json');
      let llmConfig: { model?: string; maxTokens?: number; temperature?: number } = {};
      try {
        if (fs.existsSync(configPath)) {
          const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (raw.llm) {
            llmConfig = raw.llm;
          }
        }
      } catch (err: any) {
        this.logger.warn('Failed to read config.json for LLM settings', { error: err.message });
      }
      const client = new OpenRouterClient({
        apiKey,
        ...(llmConfig.model !== undefined && { model: llmConfig.model }),
        ...(llmConfig.maxTokens !== undefined && { maxTokens: llmConfig.maxTokens }),
        ...(llmConfig.temperature !== undefined && { temperature: llmConfig.temperature }),
      });
      this.orchestrator.setLLMClient(client);
      this.logger.info('LLM client configured (OpenRouter)', { model: llmConfig.model || 'openai/gpt-4o-mini' });
    } else {
      this.logger.warn('OpenRouter API key not configured. LLM features disabled.');
    }
  }

  private setupIPCHandlers(): void {
    // Send message
    this.ipcServer.registerHandler('send_message', async (params) => {
      const message: Message = {
        id: crypto.randomUUID(),
        channelId: params.channelId || 'tui',
        userId: params.userId || 'local',
        content: params.content,
        timestamp: new Date(),
        metadata: params.metadata,
      };
      this.connectedChannels.add(message.channelId);
      const response = await this.orchestrator.handleMessage(message);
      return { status: 'ok', workflowId: message.id, content: response };
    });

    // List workflows
    this.ipcServer.registerHandler('list_workflows', async () => {
      return this.orchestrator.getWorkflows().map(w => ({
        id: w.id,
        name: w.name,
        status: w.status,
        channelId: w.channelId,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      }));
    });

    // List tools
    this.ipcServer.registerHandler('list_tools', async () => {
      return this.toolRegistry.toJSON();
    });

    // Policy management
    this.ipcServer.registerHandler('policy_list', async () => {
      return this.policyEngine.listRules();
    });

    this.ipcServer.registerHandler('policy_add', async (params) => {
      return this.policyEngine.addRule(params);
    });

    this.ipcServer.registerHandler('policy_remove', async (params) => {
      await this.policyEngine.removeRule(params.id);
      return { status: 'ok' };
    });

    // Plugin management
    this.ipcServer.registerHandler('plugin_list', async () => {
      return this.pluginLoader.getLoadedPlugins().map(p => ({
        name: p.metadata.name,
        version: p.metadata.version,
        description: p.metadata.description,
        tools: p.tools,
        loadedAt: p.loadedAt.toISOString(),
      }));
    });

    this.ipcServer.registerHandler('plugin_load', async (params) => {
      const loaded = await this.pluginLoader.loadPlugin(params.name);
      return { status: 'ok', name: loaded.metadata.name };
    });

    this.ipcServer.registerHandler('plugin_unload', async (params) => {
      await this.pluginLoader.unloadPlugin(params.name);
      return { status: 'ok' };
    });

    this.ipcServer.registerHandler('plugin_reload', async (params) => {
      await this.pluginLoader.reloadPlugin(params.name);
      return { status: 'ok' };
    });

    // Memory management
    this.ipcServer.registerHandler('memory_clear', async (params) => {
      if (params?.workflowId) {
        await this.memoryManager.clearWorkflow(params.workflowId);
      } else {
        await this.memoryManager.clearAll();
      }
      return { status: 'ok' };
    });

    // Status
    this.ipcServer.registerHandler('status', async () => {
      return {
        running: this.running,
        pid: process.pid,
        uptime: process.uptime(),
        channels: [...Array.from(this.channels.keys()), ...Array.from(this.connectedChannels)],
        plugins: this.pluginLoader.getLoadedPlugins().map(p => p.metadata.name),
        tools: this.toolRegistry.getSchemas().map(t => t.name),
        activeWorkflows: this.orchestrator.getActiveWorkflows().length,
      };
    });

    // Ping
    this.ipcServer.registerHandler('ping', async () => {
      return { pong: true, timestamp: new Date().toISOString() };
    });

    // Sub-agent management
    this.ipcServer.registerHandler('subagent_list', async () => {
      return this.subAgentManager.list();
    });

    this.ipcServer.registerHandler('subagent_pause', async (params) => {
      return this.subAgentManager.pause(params.id);
    });

    this.ipcServer.registerHandler('subagent_resume', async (params) => {
      return this.subAgentManager.resume(params.id);
    });

    this.ipcServer.registerHandler('subagent_delete', async (params) => {
      this.subAgentManager.delete(params.id);
      return { status: 'ok' };
    });
  }

  private setupEventForwarding(): void {
    // Forward relevant events to IPC clients for TUI display
    const forwardEvents = [
      Events.AGENT_RESPONSE,
      Events.AGENT_ERROR,
      Events.AGENT_STREAM_CHUNK,
      Events.AGENT_STREAM_END,
      Events.TOOL_EXECUTING,
      Events.TOOL_COMPLETED,
      Events.TOOL_ERROR,
      Events.POLICY_DECISION,
      Events.CONFIRMATION_REQUIRED,
      Events.WORKFLOW_CREATED,
      Events.WORKFLOW_COMPLETED,
      Events.WORKFLOW_FAILED,
      Events.PLUGIN_LOADED,
      Events.PLUGIN_UNLOADED,
      Events.PLUGIN_RELOADED,
      Events.SUBAGENT_SPAWNED,
      Events.SUBAGENT_STOPPED,
      Events.SUBAGENT_PAUSED,
      Events.SUBAGENT_RESUMED,
      Events.SUBAGENT_ERROR,
      Events.SUBAGENT_OUTPUT,
      Events.EMAIL_RECEIVED,
      Events.EMAIL_SENT,
    ];

    for (const event of forwardEvents) {
      this.eventBus.on(event, (data) => {
        this.ipcServer.broadcast(event, data);
      });
    }
  }
}
