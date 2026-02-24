/**
 * Date/time and scheduling tool
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';

export class DateTimeTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'datetime',
    description: 'Get current date/time, calculate time differences, or format dates',
    parameters: [
      { name: 'action', type: 'string', description: 'Action: "now", "format", "diff", "parse"', required: true },
      { name: 'date', type: 'string', description: 'Date string to process', required: false },
      { name: 'format', type: 'string', description: 'Output format', required: false },
      { name: 'timezone', type: 'string', description: 'Timezone (e.g., "America/New_York")', required: false },
    ],
    returns: 'Formatted date/time string',
    category: 'utility',
    permissions: [],
  };

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      switch (params.action) {
        case 'now': {
          const now = new Date();
          return {
            success: true,
            output: {
              iso: now.toISOString(),
              unix: Math.floor(now.getTime() / 1000),
              local: now.toLocaleString(),
              utc: now.toUTCString(),
            },
          };
        }
        case 'parse': {
          if (!params.date) return { success: false, output: null, error: 'date parameter required' };
          const parsed = new Date(params.date);
          if (isNaN(parsed.getTime())) {
            return { success: false, output: null, error: 'Invalid date string' };
          }
          return {
            success: true,
            output: {
              iso: parsed.toISOString(),
              unix: Math.floor(parsed.getTime() / 1000),
            },
          };
        }
        case 'diff': {
          if (!params.date) return { success: false, output: null, error: 'date parameter required for diff' };
          const target = new Date(params.date);
          const now = new Date();
          const diffMs = target.getTime() - now.getTime();
          const diffSec = Math.abs(Math.floor(diffMs / 1000));
          const days = Math.floor(diffSec / 86400);
          const hours = Math.floor((diffSec % 86400) / 3600);
          const minutes = Math.floor((diffSec % 3600) / 60);
          return {
            success: true,
            output: {
              milliseconds: diffMs,
              human: `${diffMs < 0 ? '-' : ''}${days}d ${hours}h ${minutes}m`,
              past: diffMs < 0,
            },
          };
        }
        default:
          return { success: false, output: null, error: `Unknown action: ${params.action}` };
      }
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }
}
