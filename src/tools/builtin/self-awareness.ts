/**
 * Self-awareness tool - lets the assistant introspect its own state
 *
 * Actions:
 *   capabilities  - List all registered tools and their descriptions
 *   config        - Show current daemon/LLM/security configuration
 *   machine       - Show host machine information (OS, CPU, RAM, disk, etc.)
 *   channels      - List connected communication channels
 *   plugins       - List loaded plugins
 *   status        - Overall daemon status (uptime, active workflows, etc.)
 *   subagents     - List running sub-agents
 *   code_info     - Return summary of the assistant's own source structure
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';

export interface SelfAwarenessContext {
  getTools: () => Array<{ name: string; description: string; category: string }>;
  getPlugins: () => Array<{ name: string; version: string; description: string }>;
  getChannels: () => string[];
  getActiveWorkflows: () => number;
  getUptime: () => number;
  getSubAgents: () => Array<{ id: string; name: string; description: string; status: string }>;
  getSkills: () => Array<{ id: string; name: string; description: string; useCount: number }>;
  getTasks: () => Array<{ id: string; name: string; description: string; status: string; intervalMs: number }>;
}

export class SelfAwarenessTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'self_awareness',
    description:
      'Introspect the assistant\'s own capabilities, configuration, machine info, connected channels, loaded plugins, running sub-agents, skills, tasks, and source code structure. Use this to understand what you can and cannot do.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description:
          'What to inspect: "capabilities", "config", "machine", "channels", "plugins", "status", "subagents", "skills", "tasks", "code_info"',
        required: true,
      },
    ],
    returns: 'Introspection data',
    category: 'system',
    permissions: [],
  };

  private homeDir: string;
  private ctx: SelfAwarenessContext | null = null;

  constructor() {
    this.homeDir =
      process.env.AIASSISTANT_HOME ||
      path.join(process.env.HOME || '~', '.aiassistant');
  }

  /** Inject runtime context so the tool can introspect live state. */
  setContext(ctx: SelfAwarenessContext): void {
    this.ctx = ctx;
  }

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    const validActions = [
      'capabilities', 'config', 'machine', 'channels',
      'plugins', 'status', 'subagents', 'skills', 'tasks', 'code_info',
    ];
    if (!params.action || !validActions.includes(params.action)) {
      return { valid: false, errors: [`action must be one of: ${validActions.join(', ')}`] };
    }
    return { valid: true };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      switch (params.action) {
        case 'capabilities':
          return this.getCapabilities();
        case 'config':
          return this.getConfig();
        case 'machine':
          return this.getMachineInfo();
        case 'channels':
          return this.getChannels();
        case 'plugins':
          return this.getPlugins();
        case 'status':
          return this.getStatus();
        case 'subagents':
          return this.getSubAgents();
        case 'skills':
          return this.getSkills();
        case 'tasks':
          return this.getTasks();
        case 'code_info':
          return this.getCodeInfo();
        default:
          return { success: false, output: null, error: `Unknown action: ${params.action}` };
      }
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------

  private getCapabilities(): ToolResult {
    const tools = this.ctx?.getTools() || [];
    return {
      success: true,
      output: {
        description: 'AIAssistant is an extensible AI operator platform. Here are all currently available tools/capabilities:',
        tools,
        notes: [
          'New capabilities can be added via plugins (skill SDK).',
          'Gmail integration is available — use the "gmail" tool.',
          'Sub-agents can be spawned for background/async tasks — use the "subagent" tool.',
          'Skills are reusable coded functions — use the "skill" tool to create and execute them.',
          'Tasks are periodic coded functions that run on a schedule — use the "task" tool.',
          'Web browsing is available via the "web_browse" (Playwright) tool.',
          'Shell commands can be executed via the "shell_exec" tool.',
        ],
      },
    };
  }

  private getConfig(): ToolResult {
    const configPath = path.join(this.homeDir, 'config', 'config.json');
    let config: any = {};
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch {
      // Ignore parse errors
    }

    // Check which secrets are configured (without revealing values)
    const gmailCredsPath = path.join(this.homeDir, 'config', 'gmail-credentials.json');
    const gmailConfigured = fs.existsSync(gmailCredsPath);

    return {
      success: true,
      output: {
        homeDir: this.homeDir,
        config,
        secrets: {
          gmail: gmailConfigured ? 'configured' : 'not configured',
        },
        notes: [
          'To reconfigure, run "./aiassistant setup" or use individual tools with "configure" action.',
          'Secrets are stored encrypted in the vault.',
        ],
      },
    };
  }

  private getMachineInfo(): ToolResult {
    const cpus = os.cpus();
    return {
      success: true,
      output: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        uptime: `${Math.floor(os.uptime())}s`,
        totalMemory: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
        freeMemory: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
        cpuModel: cpus[0]?.model || 'unknown',
        cpuCores: cpus.length,
        loadAverage: os.loadavg(),
        nodeVersion: process.version,
        pid: process.pid,
        cwd: process.cwd(),
        homeDir: this.homeDir,
      },
    };
  }

  private getChannels(): ToolResult {
    const channels = this.ctx?.getChannels() || [];
    return {
      success: true,
      output: {
        connectedChannels: channels,
        availableChannels: ['tui', 'telegram'],
        notes: [
          'TUI is the terminal interface (./aiassistant tui).',
          'Telegram can be started with: ./aiassistant telegram start',
        ],
      },
    };
  }

  private getPlugins(): ToolResult {
    const plugins = this.ctx?.getPlugins() || [];
    return {
      success: true,
      output: {
        loadedPlugins: plugins,
        pluginDirs: [
          path.join(this.homeDir, 'plugins'),
        ],
        notes: [
          'Plugins can be loaded/unloaded at runtime.',
          'New plugins can be generated using the self-extension pipeline.',
        ],
      },
    };
  }

  private getStatus(): ToolResult {
    return {
      success: true,
      output: {
        processUptime: `${Math.floor(process.uptime())}s`,
        activeWorkflows: this.ctx?.getActiveWorkflows() || 0,
        tools: (this.ctx?.getTools() || []).length,
        plugins: (this.ctx?.getPlugins() || []).length,
        channels: this.ctx?.getChannels() || [],
        subagents: (this.ctx?.getSubAgents() || []).length,
        skills: (this.ctx?.getSkills() || []).length,
        tasks: (this.ctx?.getTasks() || []).length,
        memoryUsage: {
          rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
        },
      },
    };
  }

  private getSubAgents(): ToolResult {
    const agents = this.ctx?.getSubAgents() || [];
    return {
      success: true,
      output: {
        count: agents.length,
        agents,
        notes: [
          'Use the "subagent" tool to spawn, pause, resume, or delete sub-agents.',
          'Sub-agents run asynchronous background tasks (e.g. email watchers).',
          'Deleting an agent cascades to all its sub-agents.',
        ],
      },
    };
  }

  private getSkills(): ToolResult {
    const skills = this.ctx?.getSkills() || [];
    return {
      success: true,
      output: {
        count: skills.length,
        skills,
        notes: [
          'Use the "skill" tool to create, execute, or delete skills.',
          'Skills are reusable coded functions (e.g. "fetch website content", "convert currencies").',
        ],
      },
    };
  }

  private getTasks(): ToolResult {
    const tasks = this.ctx?.getTasks() || [];
    return {
      success: true,
      output: {
        count: tasks.length,
        tasks,
        notes: [
          'Use the "task" tool to create, start, pause, resume, or delete periodic tasks.',
          'Tasks run coded functions on a schedule (e.g. "check emails every 30 seconds").',
        ],
      },
    };
  }

  private getCodeInfo(): ToolResult {
    return {
      success: true,
      output: {
        project: 'AIAssistant',
        description: 'Production-grade extensible AI operator tool with daemon, TUI, and Telegram channels.',
        architecture: {
          'src/core': 'Core interfaces, orchestrator, event bus, sub-agent manager',
          'src/daemon': 'Background daemon service, IPC server',
          'src/channels': 'Communication channels (TUI, Telegram)',
          'src/tools': 'Tool registry and built-in tools (shell, datetime, playwright, gmail, self-awareness, subagent)',
          'src/llm': 'LLM client (OpenRouter)',
          'src/memory': 'Workflow-scoped conversation memory',
          'src/plugins': 'Plugin loader, SDK, self-extension pipeline',
          'src/policy': 'Policy engine for access control',
          'src/security': 'Vault (encrypted secrets) and audit logging',
          'src/setup': 'First-run setup wizard',
          'src/storage': 'SQLite storage backend',
        },
        extensibility: [
          'New tools can be added as built-in or via plugins.',
          'Plugins are loaded from ~/.aiassistant/plugins/ and ./plugins/.',
          'The self-extension pipeline can generate, test, and hot-load new skills.',
        ],
      },
    };
  }
}
