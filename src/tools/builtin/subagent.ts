/**
 * Sub-agent management tool - lets the LLM spawn, list, pause, resume,
 * and delete background sub-agents through natural language.
 *
 * Actions:
 *   spawn   - Create a new sub-agent with a periodic task
 *   list    - List all sub-agents
 *   pause   - Pause a running sub-agent
 *   resume  - Resume a paused sub-agent
 *   delete  - Delete (stop and remove) a sub-agent
 *   get     - Get details of a specific sub-agent
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';
import { SubAgentManager, SubAgentTask } from '../../core/subagent-manager';

export class SubAgentTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'subagent',
    description:
      'Manage background sub-agents that run asynchronous tasks. You can spawn watchers (e.g. email monitors), list running agents, pause, resume, or delete them.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: "spawn", "list", "pause", "resume", "delete", "get"',
        required: true,
      },
      {
        name: 'agent_id',
        type: 'string',
        description: 'Sub-agent ID (for "pause", "resume", "delete", "get")',
        required: false,
      },
      {
        name: 'name',
        type: 'string',
        description: 'Name for the new sub-agent (for "spawn")',
        required: false,
      },
      {
        name: 'description',
        type: 'string',
        description: 'Description of what this sub-agent does (for "spawn")',
        required: false,
      },
      {
        name: 'task_type',
        type: 'string',
        description:
          'Type of background task: "email_watcher" (monitors inbox for new emails). More types can be added via plugins.',
        required: false,
      },
      {
        name: 'interval_minutes',
        type: 'number',
        description: 'How often to run the task, in minutes (default: 5)',
        required: false,
        default: 5,
      },
      {
        name: 'task_config',
        type: 'object',
        description: 'Configuration for the task (e.g. search query for email_watcher)',
        required: false,
      },
    ],
    returns: 'Sub-agent information or operation result',
    category: 'system',
    permissions: ['subagent.manage'],
  };

  private manager: SubAgentManager;
  private taskFactory: Map<string, (config: any, intervalMs: number) => SubAgentTask>;

  constructor(manager: SubAgentManager) {
    this.manager = manager;
    this.taskFactory = new Map();

    // Register built-in task types
    this.taskFactory.set('email_watcher', this.createEmailWatcherTask.bind(this));
  }

  /**
   * Register a custom task type factory (for plugin extensibility).
   */
  registerTaskType(
    type: string,
    factory: (config: any, intervalMs: number) => SubAgentTask
  ): void {
    this.taskFactory.set(type, factory);
  }

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const validActions = ['spawn', 'list', 'pause', 'resume', 'delete', 'get'];

    if (!params.action || !validActions.includes(params.action)) {
      errors.push(`action must be one of: ${validActions.join(', ')}`);
    }

    if (params.action === 'spawn') {
      if (!params.name) errors.push('name is required for spawn action');
      if (!params.task_type) errors.push('task_type is required for spawn action');
    }

    if (['pause', 'resume', 'delete', 'get'].includes(params.action) && !params.agent_id) {
      errors.push('agent_id is required for this action');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (context.dryRun) {
      return { success: true, output: `[DRY RUN] Would perform subagent action: ${params.action}` };
    }

    try {
      switch (params.action) {
        case 'spawn':
          return this.spawn(params);
        case 'list':
          return this.list();
        case 'pause':
          return this.pause(params.agent_id);
        case 'resume':
          return this.resume(params.agent_id);
        case 'delete':
          return this.deleteAgent(params.agent_id);
        case 'get':
          return this.getAgent(params.agent_id);
        default:
          return { success: false, output: null, error: `Unknown action: ${params.action}` };
      }
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------

  private spawn(params: Record<string, any>): ToolResult {
    const factory = this.taskFactory.get(params.task_type);
    if (!factory) {
      const available = Array.from(this.taskFactory.keys()).join(', ');
      return {
        success: false,
        output: null,
        error: `Unknown task type: ${params.task_type}. Available types: ${available}`,
      };
    }

    const intervalMs = (params.interval_minutes || 5) * 60 * 1000;
    const task = factory(params.task_config || {}, intervalMs);
    task.description = params.description || `${params.task_type} sub-agent`;

    const info = this.manager.spawn(params.name, task);
    return {
      success: true,
      output: {
        message: `Sub-agent "${params.name}" spawned successfully`,
        agent: info,
      },
    };
  }

  private list(): ToolResult {
    const agents = this.manager.list();
    return {
      success: true,
      output: {
        count: agents.length,
        agents,
      },
    };
  }

  private pause(agentId: string): ToolResult {
    const info = this.manager.pause(agentId);
    return {
      success: true,
      output: { message: `Sub-agent "${info.name}" paused`, agent: info },
    };
  }

  private resume(agentId: string): ToolResult {
    const info = this.manager.resume(agentId);
    return {
      success: true,
      output: { message: `Sub-agent "${info.name}" resumed`, agent: info },
    };
  }

  private deleteAgent(agentId: string): ToolResult {
    const info = this.manager.get(agentId);
    this.manager.delete(agentId);
    return {
      success: true,
      output: { message: `Sub-agent "${info?.name || agentId}" deleted` },
    };
  }

  private getAgent(agentId: string): ToolResult {
    const info = this.manager.get(agentId);
    if (!info) {
      return { success: false, output: null, error: `Sub-agent not found: ${agentId}` };
    }
    return { success: true, output: info };
  }

  // ------------------------------------------------------------------
  // Built-in task types
  // ------------------------------------------------------------------

  private createEmailWatcherTask(config: any, intervalMs: number): SubAgentTask {
    const query = config.query || 'is:unread';
    const homeDir =
      process.env.AIASSISTANT_HOME ||
      require('path').join(process.env.HOME || '~', '.aiassistant');

    return {
      description: `Watches Gmail for emails matching: ${query}`,
      intervalMs,
      execute: async (_signal: AbortSignal) => {
        // This is a stub implementation.  In production this would:
        // 1. Use GmailTool to search for matching emails
        // 2. Compare against last-seen message IDs (stored in storage)
        // 3. Emit events for new emails so the orchestrator can act on them
        //
        // For now we just log that the watcher ran.  Full implementation
        // would integrate with the Gmail tool and event bus.
        const fs = require('fs');
        const path = require('path');
        const logDir = path.join(homeDir, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
          path.join(logDir, 'subagent.log'),
          `[${new Date().toISOString()}] email_watcher ran (query: ${query})\n`
        );
      },
    };
  }
}
