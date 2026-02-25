/**
 * Task management tool - lets the LLM create, list, start, stop, and
 * delete periodic coded tasks.
 *
 * Actions:
 *   create  - Create and start a new periodic task
 *   list    - List all tasks
 *   get     - Get details of a specific task
 *   start   - Start a stopped task
 *   pause   - Pause a running task
 *   resume  - Resume a paused task
 *   delete  - Delete a task
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';
import { TaskManager } from '../../core/task-manager';

export class TaskTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'task',
    description:
      'Manage periodic coded tasks. Tasks are coded functions that run automatically on a schedule ' +
      '(e.g. "check my emails every 30 seconds and notify me about new ones"). ' +
      'The code should be a Node.js module that exports a single async function.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: "create", "list", "get", "start", "pause", "resume", "delete"',
        required: true,
      },
      {
        name: 'task_id',
        type: 'string',
        description: 'Task ID (for "get", "start", "pause", "resume", "delete")',
        required: false,
      },
      {
        name: 'name',
        type: 'string',
        description: 'Name for the new task (for "create")',
        required: false,
      },
      {
        name: 'description',
        type: 'string',
        description: 'Description of what the task does (for "create")',
        required: false,
      },
      {
        name: 'code',
        type: 'string',
        description:
          'The Node.js code for the task (for "create"). Must export a function: module.exports = async function() { ... }',
        required: false,
      },
      {
        name: 'interval_seconds',
        type: 'number',
        description: 'How often to run the task, in seconds (for "create", default: 60)',
        required: false,
        default: 60,
      },
    ],
    returns: 'Task information or operation result',
    category: 'system',
    permissions: ['task.manage'],
  };

  private manager: TaskManager;

  constructor(manager: TaskManager) {
    this.manager = manager;
  }

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const validActions = ['create', 'list', 'get', 'start', 'pause', 'resume', 'delete'];

    if (!params.action || !validActions.includes(params.action)) {
      errors.push(`action must be one of: ${validActions.join(', ')}`);
    }

    if (params.action === 'create') {
      if (!params.name) errors.push('name is required for create action');
      if (!params.code) errors.push('code is required for create action');
    }

    if (['get', 'start', 'pause', 'resume', 'delete'].includes(params.action) && !params.task_id) {
      errors.push('task_id is required for this action');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (context.dryRun) {
      return { success: true, output: `[DRY RUN] Would perform task action: ${params.action}` };
    }

    try {
      switch (params.action) {
        case 'create':
          return this.createTask(params);
        case 'list':
          return this.listTasks();
        case 'get':
          return this.getTask(params.task_id);
        case 'start':
          return this.startTask(params.task_id);
        case 'pause':
          return this.pauseTask(params.task_id);
        case 'resume':
          return this.resumeTask(params.task_id);
        case 'delete':
          return this.deleteTask(params.task_id);
        default:
          return { success: false, output: null, error: `Unknown action: ${params.action}` };
      }
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }

  private createTask(params: Record<string, any>): ToolResult {
    const intervalMs = (params.interval_seconds || 60) * 1000;
    const info = this.manager.create(
      params.name,
      params.description || params.name,
      params.code,
      intervalMs
    );
    return {
      success: true,
      output: { message: `Task "${params.name}" created and started`, task: info },
    };
  }

  private listTasks(): ToolResult {
    const tasks = this.manager.list();
    return {
      success: true,
      output: { count: tasks.length, tasks },
    };
  }

  private getTask(taskId: string): ToolResult {
    const info = this.manager.get(taskId);
    if (!info) {
      return { success: false, output: null, error: `Task not found: ${taskId}` };
    }
    return { success: true, output: info };
  }

  private startTask(taskId: string): ToolResult {
    const info = this.manager.start(taskId);
    return {
      success: true,
      output: { message: `Task "${info.name}" started`, task: info },
    };
  }

  private pauseTask(taskId: string): ToolResult {
    const info = this.manager.pause(taskId);
    return {
      success: true,
      output: { message: `Task "${info.name}" paused`, task: info },
    };
  }

  private resumeTask(taskId: string): ToolResult {
    const info = this.manager.resume(taskId);
    return {
      success: true,
      output: { message: `Task "${info.name}" resumed`, task: info },
    };
  }

  private deleteTask(taskId: string): ToolResult {
    const info = this.manager.get(taskId);
    this.manager.delete(taskId);
    return {
      success: true,
      output: { message: `Task "${info?.name || taskId}" deleted` },
    };
  }
}
