/**
 * Shell execution tool - sandboxed command execution
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';
import { execSync } from 'child_process';

export class ShellTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'shell_exec',
    description: 'Execute a shell command on the local system. Requires policy approval.',
    parameters: [
      { name: 'command', type: 'string', description: 'The shell command to execute', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout in milliseconds (default: 30000)', required: false, default: 30000 },
      { name: 'cwd', type: 'string', description: 'Working directory', required: false },
    ],
    returns: 'Command output as string',
    category: 'system',
    permissions: ['shell.execute'],
  };

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    if (!params.command || typeof params.command !== 'string') {
      errors.push('command is required and must be a string');
    }
    // Block obviously dangerous commands
    const dangerous = ['rm -rf /', 'mkfs', ':(){:|:&};:', 'dd if=/dev/'];
    if (params.command && dangerous.some(d => params.command.includes(d))) {
      errors.push('Command contains potentially destructive patterns');
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (context.dryRun) {
      return { success: true, output: `[DRY RUN] Would execute: ${params.command}` };
    }

    try {
      const output = execSync(params.command, {
        timeout: params.timeout || 30000,
        cwd: params.cwd || process.cwd(),
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        env: { ...process.env, TERM: 'dumb' },
      });
      return { success: true, output: output.trim() };
    } catch (err: any) {
      return {
        success: false,
        output: err.stdout?.toString() || '',
        error: err.stderr?.toString() || err.message,
      };
    }
  }
}
