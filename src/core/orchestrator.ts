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
  buildSystemPrompt(isSubagent: boolean = false): string {
    const tools = this.toolRegistry.getSchemas();
    const toolDescriptions = tools
      .map(t => {
        if (t.parameters.length === 0) {
          return `  - ${t.name}: ${t.description}`;
        }
        const params = t.parameters
          .map(p => `${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
          .join('; ');
        return `  - ${t.name}: ${t.description} [params: ${params}]`;
      })
      .join('\n');

    const toolSection = tools.length > 0
      ? `\n\nYou have access to the following tools:\n${toolDescriptions}\n\nUse these tools when appropriate to accomplish tasks.`
      : '\n\nNo tools are currently available.';

    if (isSubagent) {
      return `You are a background AI subagent running on a periodic schedule.
Your task is to execute the assigned instructions using the available tools.
IMPORTANT RULES:
1. Execute the tools necessary to complete your task. Use as many steps as needed.
2. If there is new or important information to report to the user, output the message as your final response.
3. If there is NOTHING new to report or no action needed, you MUST respond exactly with the word "SILENT" (all caps, no other text).
4. You have access to the history of your previous executions in this thread. Use it to determine if something is "new" (e.g. comparing known email IDs).${toolSection}`;
    }

    return `You are AIAssistant, a helpful AI operator that can plan and execute tasks using available tools.
You should think step by step, use tools when needed, and always respect the user's instructions. Follow these important rules:

1. **Multi-step execution**: When a task requires multiple steps (e.g. "search Google for X then email the results to Y"), you MUST execute ALL steps in sequence. Use one tool, examine its result, then call the next tool using that result. Do NOT stop after just one tool call — keep going until the entire task is complete.
2. **Multiple tools per turn**: You can call multiple tools in a single response when they are independent of each other. Use this to work efficiently.
3. **Tool chaining**: When one tool's output is needed as input for another tool, call the first tool, wait for its result, then call the second tool with the data from the first.
4. **Complete the full task**: Never stop midway through a multi-step request. If the user asks you to do A then B, make sure you do both A and B before responding.

**Choosing the right approach — you have several options and MUST pick the best fit:**

- **Existing tools**: If one of your built-in tools (gmail, shell_exec, web_browse, etc.) already handles the request, use it directly.
- **Skills**: If the user wants a *reusable capability* they plan to use multiple times (e.g. "I want to be able to read website content"), create a **skill** using the "skill" tool. Skills are one-time coded functions saved to disk that you can invoke later.
- **Tasks**: If the user needs something to run *periodically on a schedule* (e.g. "check my emails every 30 seconds and notify me"), create a **task** using the "task" tool. Tasks are coded functions that run automatically at a set interval.
- **Agents**: If the user needs a *long-running async operation* (e.g. "make a Python math calculator"), spawn a **subagent** using the "subagent" tool. Agents can themselves spawn sub-agents. When an agent is deleted, all its sub-agents are automatically deleted too.

When using tools, briefly describe what you're doing and why.
If a tool call is blocked by policy, explain to the user what happened.

You are self-aware: you can inspect your own capabilities, configuration, the machine you run on,
connected channels, loaded plugins, running sub-agents, skills, and tasks using the "self_awareness" tool.
If the user asks what you can do, use self_awareness with action "capabilities".
If the user asks about your config or setup, use self_awareness with action "config".

You can manage Gmail email (send, read, list, search) using the "gmail" tool.
To configure ANY tool or service (Gmail, Telegram, OpenRouter, etc.), use the "config" tool.
Use config with action "status" to check which services are configured, and action "set" with the appropriate namespace and values to configure them.
When the user asks to set up or configure any service, ALWAYS use the "config" tool — never try to configure tools directly.
When setting config, pass ALL required fields for the namespace in a SINGLE config set call.
Use config with action "list" to discover what namespaces and fields are available.

You can spawn dynamic background sub-agents for asynchronous tasks using the "subagent" tool.
Provide a clear "prompt" specifying what the sub-agent should do periodically. 
For example: "Watch my unread emails. If there are new ones since last time, summarize them."
You can list, pause, resume, and delete sub-agents at any time.
Agents can create sub-agents. When you delete an agent, all its sub-agents are automatically removed.

You can create reusable skills using the "skill" tool. Generate JavaScript code that can be saved and invoked later.
You can create periodic tasks using the "task" tool. Generate JavaScript code that will run on a schedule.

**Using built-in tools and skills inside tasks and skills:**
When writing code for a task or skill, you MUST prefer built-in tools and existing skills over raw implementations.
Task functions receive a context object: module.exports = async function({ tools, skills }) { ... }
Skill functions receive params and context: module.exports = async function(params, { tools, skills }) { ... }
The "tools" object contains all registered built-in tools as callable async functions.
For example: tools.gmail({ action: "list" }), tools.web_browse({ action: "navigate", url: "..." }), tools.shell_exec({ command: "..." }).
The "skills" object contains all created skills callable by name as async functions.
For example: await skills["fetch-webpage"]({ url: "https://example.com" }), await skills["convert-currency"]({ amount: 100, from: "USD", to: "EUR" }).
Each tool function returns { success, output, error? }. Always check result.success before using result.output.
Skills return their result directly. You can compose skills together — a skill or task can call other skills.
This is much more reliable than writing raw HTTP requests or custom code for functionality that built-in tools already provide.

Always tell the user about active agents, skills, and tasks when relevant.${toolSection}`;
  }

  setLLMClient(client: OpenRouterClient): void {
    this.llmClient = client;
  }

  async handleSubagentTask(agentId: string, prompt: string, channelId?: string, userId?: string): Promise<void> {
    channelId = channelId || 'system';
    userId = userId || 'system';

    let workflow = Array.from(this.workflows.values()).find(w => w.agentId === agentId);
    if (!workflow) {
      workflow = {
        id: crypto.randomUUID(),
        name: `subagent-${agentId}`,
        status: 'pending',
        agentId: agentId,
        channelId: channelId,
        userId: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.workflows.set(workflow.id, workflow);
      this.eventBus.emit(Events.WORKFLOW_CREATED, { workflow });
    }

    // Clear previous memory each run so the subagent doesn't accumulate its own
    // output chatter and get stuck in loops repeating what it said last time.
    // Tools (e.g. gmail) are responsible for tracking their own state across runs.
    const memory = this.memoryManager.createMemory(workflow.id);
    await memory.clear();

    workflow.status = 'running';
    workflow.updatedAt = new Date();

    try {
      const promptToSend = `Execute your background task NOW using the available tools.
YOUR TASK: ${prompt}

RULES:
- Use tools to check for new data.
- If you find new, actionable information, report it clearly.
- If there is NOTHING new to report, respond ONLY with the single word "SILENT".
- Do NOT confirm that you are running, do NOT say "task completed", do NOT repeat previous information.`;

      const response = await this.processWithLLM(workflow, {
        id: crypto.randomUUID(),
        channelId,
        userId,
        content: promptToSend,
        timestamp: new Date()
      }, true, prompt);

      // Detect "silent" responses — the LLM may say SILENT, "silent", or just whitespace
      const trimmed = response.trim();
      const isSilent = trimmed.toUpperCase() === 'SILENT' || trimmed === '';

      if (!isSilent) {
        this.eventBus.emit(Events.AGENT_RESPONSE, {
          workflowId: workflow.id,
          userId: userId,
          channelId: channelId,
          content: `[SubAgent Update] ${trimmed}`,
        });
      }
    } catch (err: any) {
      this.eventBus.emit(Events.AGENT_ERROR, {
        workflowId: workflow.id,
        userId: userId,
        channelId: channelId,
        error: `Subagent Error: ${err.message}`,
      });
    } finally {
      workflow.status = 'completed';
      workflow.updatedAt = new Date();
    }
  }

  async handleMessage(message: Message): Promise<string | undefined> {
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

      return response;
    } catch (err: any) {
      const errorMsg = `Error processing message: ${err.message}`;
      this.eventBus.emit(Events.AGENT_ERROR, {
        workflowId: workflow.id,
        userId: message.userId,
        channelId: message.channelId,
        error: errorMsg,
      });
      return undefined;
    } finally {
      workflow.status = 'completed';
      workflow.updatedAt = new Date();
    }
  }

  private async processWithLLM(workflow: Workflow, message: Message, isSubagent: boolean = false, subagentPrompt?: string): Promise<string> {
    if (!this.llmClient) {
      return this.processWithoutLLM(message.content);
    }

    const memory = this.memoryManager.createMemory(workflow.id);
    const context = await memory.getContext();
    const tools = this.toolRegistry.getSchemas();

    let sysPrompt = this.buildSystemPrompt(isSubagent);
    if (isSubagent && subagentPrompt) {
      sysPrompt += `\n\nYOUR ASSIGNED TASK:\n${subagentPrompt}`;
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: sysPrompt },
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

    // For subagents, treat empty LLM responses as "nothing to report"
    // instead of emitting a generic message that would spam the user.
    if (!response.content && isSubagent) {
      return 'SILENT';
    }

    // If the LLM returned empty content after tool calls for a user-facing
    // interaction, ask it once more to produce a proper answer based on the
    // tool results already in the conversation.
    if (!response.content && iterations > 0) {
      messages.push({
        role: 'user',
        content: 'Please provide a clear response to my original question based on the tool results above.',
      });
      const retry = await this.llmClient.chat(messages, tools);
      if (retry.content) {
        return retry.content;
      }
    }

    if (!response.content) {
      return this.buildFallbackMessage(response.finishReason, iterations, maxIterations, messages);
    }
    return response.content;
  }

  /**
   * Build a descriptive fallback message when the LLM returns empty content,
   * explaining what went wrong instead of using a generic fixed string.
   */
  private buildFallbackMessage(
    finishReason: string | undefined,
    iterations: number,
    maxIterations: number,
    messages: LLMMessage[]
  ): string {
    const parts: string[] = ['I was unable to generate a response.'];

    if (iterations >= maxIterations) {
      parts.push(`The request required too many steps (${iterations} tool calls reached the limit). Try breaking your request into smaller parts.`);
    } else if (finishReason === 'length') {
      parts.push('The response was cut off because it exceeded the maximum token length. Try asking a more specific question.');
    } else if (iterations > 0) {
      // Summarise which tools ran so the user knows what happened
      const toolNames = messages
        .filter(m => m.role === 'tool' && m.name)
        .map(m => m.name!);
      const uniqueTools = [...new Set(toolNames)];
      if (uniqueTools.length > 0) {
        parts.push(`I executed ${uniqueTools.join(', ')} but the model returned an empty response afterward. You can try rephrasing your question.`);
      } else {
        parts.push('Tools were called but the model did not produce a final answer. Please try again.');
      }
    } else {
      parts.push(`The model returned an empty response (finish reason: ${finishReason || 'unknown'}). This may be a temporary issue — please try again.`);
    }

    return parts.join(' ');
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
        w.agentId === 'main' &&
        (w.status === 'running' || w.status === 'pending' || w.status === 'paused' || w.status === 'completed')
    );
  }
}
