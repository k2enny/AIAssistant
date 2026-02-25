import { Orchestrator } from '../src/core/orchestrator';
import { EventBus, Events } from '../src/core/event-bus';
import { ToolRegistry } from '../src/tools/registry';
import { MemoryManager } from '../src/memory/manager';
import { PolicyEngineImpl } from '../src/policy/engine';
import { AuditLogger } from '../src/security/audit';
import { DateTimeTool } from '../src/tools/builtin/datetime';
import { PlaywrightTool } from '../src/tools/builtin/playwright';
import { StorageInterface, Message } from '../src/core/interfaces';

class MockStorage implements StorageInterface {
  private data: Map<string, Map<string, any>> = new Map();
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async ensureTable(table: string): Promise<void> {
    if (!this.data.has(table)) this.data.set(table, new Map());
  }
  async get(table: string, key: string): Promise<any> {
    return this.data.get(table)?.get(key) || null;
  }
  async set(table: string, key: string, value: any): Promise<void> {
    if (!this.data.has(table)) this.data.set(table, new Map());
    this.data.get(table)!.set(key, { id: key, data: JSON.stringify(value), updated_at: new Date().toISOString() });
  }
  async delete(table: string, key: string): Promise<void> {
    this.data.get(table)?.delete(key);
  }
  async query(table: string): Promise<any[]> {
    return Array.from(this.data.get(table)?.values() || []);
  }
}

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let eventBus: EventBus;
  let storage: MockStorage;
  let toolRegistry: ToolRegistry;
  let memoryManager: MemoryManager;
  let policyEngine: PolicyEngineImpl;
  let auditLogger: AuditLogger;

  beforeEach(async () => {
    eventBus = new EventBus();
    storage = new MockStorage();
    toolRegistry = new ToolRegistry(eventBus);
    memoryManager = new MemoryManager(storage);
    policyEngine = new PolicyEngineImpl(storage, eventBus);
    auditLogger = new AuditLogger('/tmp/aiassistant-test-' + Date.now());

    await memoryManager.initialize();
    await policyEngine.initialize();
    await auditLogger.initialize();

    toolRegistry.register(new DateTimeTool());

    orchestrator = new Orchestrator(
      eventBus,
      storage,
      toolRegistry,
      memoryManager,
      policyEngine,
      auditLogger
    );
  });

  afterEach(async () => {
    await auditLogger.close();
  });

  test('should create workflow on message', async () => {
    const message: Message = {
      id: 'test-1',
      channelId: 'tui',
      userId: 'user1',
      content: 'help',
      timestamp: new Date(),
    };

    let responseReceived = false;
    eventBus.on(Events.AGENT_RESPONSE, (data) => {
      responseReceived = true;
      expect(data.content).toBeDefined();
    });

    await orchestrator.handleMessage(message);
    expect(responseReceived).toBe(true);
  });

  test('should handle help command without LLM', async () => {
    const message: Message = {
      id: 'test-2',
      channelId: 'tui',
      userId: 'user1',
      content: 'help',
      timestamp: new Date(),
    };

    let response = '';
    eventBus.on(Events.AGENT_RESPONSE, (data) => {
      response = data.content;
    });

    await orchestrator.handleMessage(message);
    expect(response).toContain('Available tools');
    expect(response).toContain('datetime');
  });

  test('should build system prompt with available tools', () => {
    const prompt = orchestrator.buildSystemPrompt();
    expect(prompt).toContain('AIAssistant');
    expect(prompt).toContain('You have access to the following tools');
    expect(prompt).toContain('datetime');
  });

  test('should include web_browse tool in system prompt when registered', () => {
    toolRegistry.register(new PlaywrightTool());

    const prompt = orchestrator.buildSystemPrompt();
    expect(prompt).toContain('web_browse');
    expect(prompt).toContain('Automate web browsing');

    toolRegistry.unregister('web_browse');
  });

  test('should reflect dynamically registered tools in system prompt', () => {
    // Initially has datetime
    let prompt = orchestrator.buildSystemPrompt();
    expect(prompt).toContain('datetime');

    // Register a new tool and verify it appears
    const mockTool = {
      schema: {
        name: 'test_dynamic',
        description: 'A dynamically added tool',
        parameters: [
          { name: 'input', type: 'string' as const, description: 'Input value', required: true },
        ],
        returns: 'Test result',
        category: 'test',
        permissions: [],
      },
      async execute() { return { success: true, output: 'ok' }; },
    };
    toolRegistry.register(mockTool);

    prompt = orchestrator.buildSystemPrompt();
    expect(prompt).toContain('test_dynamic');
    expect(prompt).toContain('A dynamically added tool');

    // Unregister and verify it's gone
    toolRegistry.unregister('test_dynamic');
    prompt = orchestrator.buildSystemPrompt();
    expect(prompt).not.toContain('test_dynamic');
  });

  test('should track workflows', async () => {
    const message: Message = {
      id: 'test-3',
      channelId: 'tui',
      userId: 'user1',
      content: 'test',
      timestamp: new Date(),
    };

    await orchestrator.handleMessage(message);
    const workflows = orchestrator.getWorkflows();
    expect(workflows.length).toBeGreaterThan(0);
  });

  test('should emit workflow events', async () => {
    let workflowCreated = false;
    eventBus.on(Events.WORKFLOW_CREATED, () => { workflowCreated = true; });

    const message: Message = {
      id: 'test-4',
      channelId: 'tui',
      userId: 'user1',
      content: 'test',
      timestamp: new Date(),
    };

    await orchestrator.handleMessage(message);
    expect(workflowCreated).toBe(true);
  });

  test('should provide time response without LLM', async () => {
    const message: Message = {
      id: 'test-5',
      channelId: 'tui',
      userId: 'user1',
      content: '/time',
      timestamp: new Date(),
    };

    let response = '';
    eventBus.on(Events.AGENT_RESPONSE, (data) => {
      response = data.content;
    });

    await orchestrator.handleMessage(message);
    expect(response).toContain('Current time');
  });

  test('should reuse workflow for same user and channel across messages', async () => {
    const msg1: Message = {
      id: 'test-reuse-1',
      channelId: 'tui',
      userId: 'user1',
      content: 'help',
      timestamp: new Date(),
    };

    const msg2: Message = {
      id: 'test-reuse-2',
      channelId: 'tui',
      userId: 'user1',
      content: '/time',
      timestamp: new Date(),
    };

    await orchestrator.handleMessage(msg1);
    const workflowsAfterFirst = orchestrator.getWorkflows();
    expect(workflowsAfterFirst.length).toBe(1);
    const firstWorkflowId = workflowsAfterFirst[0].id;

    await orchestrator.handleMessage(msg2);
    const workflowsAfterSecond = orchestrator.getWorkflows();
    expect(workflowsAfterSecond.length).toBe(1);
    expect(workflowsAfterSecond[0].id).toBe(firstWorkflowId);
  });

  test('should create separate workflows for different channels', async () => {
    const msg1: Message = {
      id: 'test-chan-1',
      channelId: 'tui',
      userId: 'user1',
      content: 'help',
      timestamp: new Date(),
    };

    const msg2: Message = {
      id: 'test-chan-2',
      channelId: 'telegram',
      userId: 'user1',
      content: 'help',
      timestamp: new Date(),
    };

    await orchestrator.handleMessage(msg1);
    await orchestrator.handleMessage(msg2);
    const workflows = orchestrator.getWorkflows();
    expect(workflows.length).toBe(2);
  });

  test('should build subagent system prompt with SILENT instructions', () => {
    const prompt = orchestrator.buildSystemPrompt(true);
    expect(prompt).toContain('background AI subagent');
    expect(prompt).toContain('SILENT');
    expect(prompt).not.toContain('AIAssistant, a helpful AI operator');
  });

  test('system prompt should instruct LLM to use built-in tools in tasks and skills', () => {
    const prompt = orchestrator.buildSystemPrompt();
    expect(prompt).toContain('built-in tools');
    expect(prompt).toContain('tools.gmail');
    expect(prompt).toContain('tools.web_browse');
    expect(prompt).toContain('tools.shell_exec');
  });

  test('handleSubagentTask should not emit AGENT_RESPONSE for SILENT LLM responses', async () => {
    // Without an LLM client, processWithLLM returns the fallback.
    // For subagents, empty content should return SILENT, not "I completed the task."
    const responses: any[] = [];
    eventBus.on(Events.AGENT_RESPONSE, (data) => {
      responses.push(data);
    });

    await orchestrator.handleSubagentTask('test-agent-id', 'Check for emails');

    // Without LLM configured, processWithoutLLM returns a config message, but
    // the subagent code path uses processWithLLM which without a client falls through.
    // The key invariant: no "[SubAgent Update] I completed the task." spam.
    const spamMessages = responses.filter(r =>
      r.content && r.content.includes('I completed the task')
    );
    expect(spamMessages).toHaveLength(0);
  });
});
