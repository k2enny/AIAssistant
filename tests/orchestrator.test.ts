import { Orchestrator } from '../src/core/orchestrator';
import { EventBus, Events } from '../src/core/event-bus';
import { ToolRegistry } from '../src/tools/registry';
import { MemoryManager } from '../src/memory/manager';
import { PolicyEngineImpl } from '../src/policy/engine';
import { AuditLogger } from '../src/security/audit';
import { DateTimeTool } from '../src/tools/builtin/datetime';
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
});
