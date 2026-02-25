/**
 * Tool registry - manages tool registration and lookup
 */
import { Tool, ToolSchema, ToolResult, ToolContext, EventBusInterface } from '../core/interfaces';
import { Events } from '../core/event-bus';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private eventBus: EventBusInterface;

  constructor(eventBus: EventBusInterface) {
    this.eventBus = eventBus;
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.schema.name)) {
      throw new Error(`Tool already registered: ${tool.schema.name}`);
    }
    this.tools.set(tool.schema.name, tool);
    this.eventBus.emit(Events.TOOL_REGISTERED, { name: tool.schema.name, schema: tool.schema });
  }

  unregister(name: string): void {
    if (!this.tools.has(name)) {
      throw new Error(`Tool not found: ${name}`);
    }
    this.tools.delete(name);
    this.eventBus.emit(Events.TOOL_UNREGISTERED, { name });
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getSchemas(): ToolSchema[] {
    return this.getAll().map(t => t.schema);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getByCategory(category: string): Tool[] {
    return this.getAll().filter(t => t.schema.category === category);
  }

  getCategories(): string[] {
    return [...new Set(this.getAll().map(t => t.schema.category))];
  }

  toJSON(): any[] {
    return this.getSchemas().map(s => ({
      name: s.name,
      description: s.description,
      parameters: s.parameters,
      category: s.category,
    }));
  }

  /**
   * Create a toolbox object that task/skill code can use to call built-in
   * tools directly.  Each key is a tool name and the value is an async
   * function that accepts the tool's parameters and returns a ToolResult.
   *
   * Example usage inside generated task/skill code:
   *   const emails = await tools.gmail({ action: 'list', max_results: 5 });
   */
  getToolbox(): Record<string, (params: Record<string, any>) => Promise<ToolResult>> {
    const defaultContext: ToolContext = {
      workflowId: 'task-runtime',
      userId: 'system',
      channelId: 'system',
      dryRun: false,
    };

    const toolbox: Record<string, (params: Record<string, any>) => Promise<ToolResult>> = {};
    for (const [name, tool] of this.tools) {
      toolbox[name] = (params: Record<string, any>) => tool.execute(params, defaultContext);
    }
    return toolbox;
  }
}
