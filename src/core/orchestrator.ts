/**
 * Main orchestrator - coordinates agents, tools, workflows
 */
import * as crypto from 'crypto';
import {
  Message,
  Workflow,
  ToolCall,
  ToolResult,
  ToolContext,
  PolicyRequest,
  AgentResponse,
  EventBusInterface,
  StorageInterface,
  PolicyEngine,
} from './interfaces';
import { Events } from './event-bus';
import { ToolRegistry } from '../tools/registry';
import { MemoryManager } from '../memory/manager';
import { OpenRouterClient, LLMMessage, LLMToolCall } from '../llm/openrouter';
import { AuditLogger } from '../security/audit';

export class Orchestrator {
  private eventBus: EventBusInterface;
  private storage: StorageInterface;
  private toolRegistry: ToolRegistry;
  private memoryManager: MemoryManager;
  private policyEngine: PolicyEngine;
  private llmClient: OpenRouterClient | null = null;
  private auditLogger: AuditLogger;
  private workflows: Map<string, Workflow> = new Map();

  constructor(
    eventBus: EventBusInterface,
    storage: StorageInterface,
    toolRegistry: ToolRegistry,
    memoryManager: MemoryManager,
    policyEngine: PolicyEngine,
    auditLogger: AuditLogger
  ) {
    this.eventBus = eventBus;
    this.storage = storage;
    this.toolRegistry = toolRegistry;
    this.memoryManager = memoryManager;
    this.policyEngine = policyEngine;
    this.auditLogger = auditLogger;
  }

  /**
   * Build the system prompt dynamically, including the current list of
   * registered tools so the LLM knows exactly what it can use.
   */
  buildSystemPrompt(): string {
    const tools = this.toolRegistry.getSchemas();
    const toolDescriptions = tools
      .map(t => {
        const params = t.parameters
          .map(p => `${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
          .join('; ');
        return `  - ${t.name}: ${t.description} [params: ${params}]`;
      })
      .join('\n');

    const toolSection = tools.length > 0
      ? `\n\nYou have access to the following tools:\n${toolDescriptions}\n\nUse these tools when appropriate to accomplish tasks.`
      : '\n\nNo tools are currently available.';

    return `You are AIAssistant, a helpful AI operator that can plan and execute tasks using available tools.
You should think step by step, use tools when needed, and always respect the user's instructions.
When using tools, describe what you're doing and why.
If a tool call is blocked by policy, explain to the user what happened.${toolSection}`;
  }

  setLLMClient(client: OpenRouterClient): void {
    this.llmClient = client;
  }

  async handleMessage(message: Message): Promise<void> {
    // Find or create workflow
    let workflow = this.findWorkflowForUser(message.userId, message.channelId);
    if (!workflow) {
      workflow = this.createWorkflow(message);
    }

    const memory = this.memoryManager.createMemory(workflow.id);
    await memory.addMessage('user', message.content, {
      channelId: message.channelId,
      userId: message.userId,
    });

    workflow.status = 'running';
    workflow.updatedAt = new Date();
    this.workflows.set(workflow.id, workflow);

    this.eventBus.emit(Events.AGENT_STARTED, {
      workflowId: workflow.id,
      userId: message.userId,
      channelId: message.channelId,
    });

    try {
      const response = await this.processWithLLM(workflow, message);

      await memory.addMessage('assistant', response);

      this.eventBus.emit(Events.AGENT_RESPONSE, {
        workflowId: workflow.id,
        userId: message.userId,
        channelId: message.channelId,
        content: response,
      });
    } catch (err: any) {
      const errorMsg = `Error processing message: ${err.message}`;
      this.eventBus.emit(Events.AGENT_ERROR, {
        workflowId: workflow.id,
        userId: message.userId,
        channelId: message.channelId,
        error: errorMsg,
      });
    } finally {
      workflow.status = 'completed';
      workflow.updatedAt = new Date();
    }
  }

  private async processWithLLM(workflow: Workflow, message: Message): Promise<string> {
    if (!this.llmClient) {
      return this.processWithoutLLM(message.content);
    }

    const memory = this.memoryManager.createMemory(workflow.id);
    const context = await memory.getContext();
    const tools = this.toolRegistry.getSchemas();

    const messages: LLMMessage[] = [
      { role: 'system', content: this.buildSystemPrompt() },
    ];

    // Add context messages
    for (const msg of context.messages.slice(-20)) {
      messages.push({ role: msg.role as any, content: msg.content });
    }

    let response = await this.llmClient.chat(messages, tools);

    // Handle tool calls
    let iterations = 0;
    const maxIterations = 10;

    while (response.toolCalls && response.toolCalls.length > 0 && iterations < maxIterations) {
      iterations++;

      if (response.content) {
        messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls });
      } else {
        messages.push({ role: 'assistant', content: '', tool_calls: response.toolCalls });
      }

      for (const toolCall of response.toolCalls) {
        const result = await this.executeToolCall(toolCall, workflow, message);
        messages.push({
          role: 'tool',
          content: JSON.stringify(result),
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
        });
        await memory.addMessage('tool', JSON.stringify(result), { toolCall: toolCall.function.name });
      }

      response = await this.llmClient.chat(messages, tools);
    }

    return response.content || 'I completed the task.';
  }

  private async executeToolCall(
    toolCall: LLMToolCall,
    workflow: Workflow,
    message: Message
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    let params: Record<string, any>;
    
    try {
      params = JSON.parse(toolCall.function.arguments);
    } catch {
      return { success: false, output: null, error: 'Invalid tool call arguments' };
    }

    const tool = this.toolRegistry.get(toolName);
    if (!tool) {
      return { success: false, output: null, error: `Unknown tool: ${toolName}` };
    }

    // Check policy
    const policyRequest: PolicyRequest = {
      tool: toolName,
      action: 'execute',
      parameters: params,
      userId: message.userId,
      channelId: message.channelId,
      workflowId: workflow.id,
    };

    const decision = await this.policyEngine.evaluate(policyRequest);

    if (!decision.allowed && decision.action === 'deny') {
      this.auditLogger.logToolCall(toolName, params, 'blocked', message.userId, workflow.id);
      return {
        success: false,
        output: null,
        error: `Blocked by policy: ${decision.reason}`,
      };
    }

    if (decision.action === 'require-confirmation') {
      // Emit confirmation request and wait
      this.eventBus.emit(Events.CONFIRMATION_REQUIRED, {
        workflowId: workflow.id,
        userId: message.userId,
        channelId: message.channelId,
        tool: toolName,
        params,
        reason: decision.reason,
      });
      
      // For now, include the confirmation note in the result
      this.auditLogger.logToolCall(toolName, params, 'confirmed', message.userId, workflow.id);
    }

    // Validate parameters
    if (tool.validate) {
      const validation = tool.validate(params);
      if (!validation.valid) {
        return {
          success: false,
          output: null,
          error: `Validation failed: ${validation.errors?.join(', ')}`,
        };
      }
    }

    this.eventBus.emit(Events.TOOL_EXECUTING, { tool: toolName, params, workflowId: workflow.id });

    try {
      const toolContext: ToolContext = {
        workflowId: workflow.id,
        userId: message.userId,
        channelId: message.channelId,
        dryRun: false,
      };

      const result = await tool.execute(params, toolContext);

      this.auditLogger.logToolCall(toolName, params, result.success ? 'success' : 'failure', message.userId, workflow.id);
      this.eventBus.emit(Events.TOOL_COMPLETED, { tool: toolName, result, workflowId: workflow.id });

      return result;
    } catch (err: any) {
      this.auditLogger.logToolCall(toolName, params, 'failure', message.userId, workflow.id);
      this.eventBus.emit(Events.TOOL_ERROR, { tool: toolName, error: err.message, workflowId: workflow.id });
      return { success: false, output: null, error: err.message };
    }
  }

  private processWithoutLLM(content: string): string {
    // Basic command processing without LLM
    const lower = content.toLowerCase().trim();

    if (lower === 'help') {
      const tools = this.toolRegistry.getSchemas();
      const toolList = tools.map(t => `  • ${t.name}: ${t.description}`).join('\n');
      return `Available tools:\n${toolList}\n\nType a message to interact with the AI, or use /tools to see available tools.`;
    }

    if (lower === '/tools' || lower === 'tools') {
      return JSON.stringify(this.toolRegistry.toJSON(), null, 2);
    }

    if (lower.startsWith('/time') || lower === 'time') {
      return `Current time: ${new Date().toISOString()}`;
    }

    return 'LLM not configured. Run `./aiassistant setup` to configure OpenRouter API key. Type "help" for available commands.';
  }

  createWorkflow(message: Message): Workflow {
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      name: `workflow-${Date.now()}`,
      status: 'pending',
      agentId: 'main',
      channelId: message.channelId,
      userId: message.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.workflows.set(workflow.id, workflow);
    this.eventBus.emit(Events.WORKFLOW_CREATED, { workflow });
    return workflow;
  }

  getWorkflows(): Workflow[] {
    return Array.from(this.workflows.values());
  }

  getActiveWorkflows(): Workflow[] {
    return this.getWorkflows().filter(w => w.status === 'running' || w.status === 'paused');
  }

  private findWorkflowForUser(userId: string, channelId: string): Workflow | undefined {
    return Array.from(this.workflows.values()).find(
      w => w.userId === userId && w.channelId === channelId &&
           (w.status === 'running' || w.status === 'pending' || w.status === 'paused')
    );
  }
}
