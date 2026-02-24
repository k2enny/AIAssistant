import { PolicyEngineImpl } from '../src/policy/engine';
import { EventBus } from '../src/core/event-bus';
import { StorageInterface, PolicyRequest } from '../src/core/interfaces';

// In-memory storage mock
class MockStorage implements StorageInterface {
  private data: Map<string, Map<string, any>> = new Map();
  private tables: Set<string> = new Set();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async ensureTable(table: string, schema: Record<string, string>): Promise<void> {
    this.tables.add(table);
    if (!this.data.has(table)) {
      this.data.set(table, new Map());
    }
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

  async query(table: string, filter?: Record<string, any>): Promise<any[]> {
    const tableData = this.data.get(table);
    if (!tableData) return [];
    return Array.from(tableData.values());
  }
}

describe('PolicyEngine', () => {
  let engine: PolicyEngineImpl;
  let storage: MockStorage;
  let eventBus: EventBus;

  beforeEach(async () => {
    storage = new MockStorage();
    eventBus = new EventBus();
    engine = new PolicyEngineImpl(storage, eventBus);
    await engine.initialize();
  });

  test('should have default rules after initialization', async () => {
    const rules = await engine.listRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some(r => r.name === 'Confirm downloads')).toBe(true);
    expect(rules.some(r => r.name === 'Subagent shell restriction')).toBe(true);
  });

  test('should allow requests that match no deny rules', async () => {
    const request: PolicyRequest = {
      tool: 'datetime',
      action: 'execute',
      parameters: { action: 'now' },
      userId: 'user1',
      channelId: 'tui',
      workflowId: 'wf1',
    };

    const decision = await engine.evaluate(request);
    expect(decision.allowed).toBe(true);
  });

  test('should require confirmation for downloads', async () => {
    const request: PolicyRequest = {
      tool: 'web_fetch',
      action: 'execute',
      parameters: { url: 'https://example.com' },
      userId: 'user1',
      channelId: 'tui',
      workflowId: 'wf1',
    };

    const decision = await engine.evaluate(request);
    expect(decision.action).toBe('require-confirmation');
  });

  test('should add and evaluate custom rules', async () => {
    await engine.addRule({
      name: 'Block dangerous tool',
      description: 'Block a specific tool',
      scope: { global: true },
      action: 'deny',
      target: { commands: ['dangerous_tool'] },
      priority: 200,
      enabled: true,
    });

    const request: PolicyRequest = {
      tool: 'dangerous_tool',
      action: 'execute',
      parameters: {},
      userId: 'user1',
      channelId: 'tui',
      workflowId: 'wf1',
    };

    const decision = await engine.evaluate(request);
    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('deny');
  });

  test('should remove rules', async () => {
    const rules = await engine.listRules();
    const initialCount = rules.length;
    
    await engine.removeRule(rules[0].id);
    
    const updated = await engine.listRules();
    expect(updated.length).toBe(initialCount - 1);
  });

  test('should update rules', async () => {
    const rules = await engine.listRules();
    const rule = rules[0];
    
    await engine.updateRule(rule.id, { enabled: false });
    
    const updated = await engine.getRule(rule.id);
    expect(updated?.enabled).toBe(false);
  });

  test('should emit policy decision events', async () => {
    let emitted = false;
    eventBus.on('policy:decision', () => { emitted = true; });

    await engine.evaluate({
      tool: 'test',
      action: 'execute',
      parameters: {},
      userId: 'user1',
      channelId: 'tui',
      workflowId: 'wf1',
    });

    expect(emitted).toBe(true);
  });

  test('should respect priority ordering', async () => {
    // Add a high-priority allow rule for shell_exec
    await engine.addRule({
      name: 'Allow shell for admin',
      description: 'Allow shell commands for specific user',
      scope: { global: true },
      action: 'allow',
      target: { commands: ['shell_exec'], users: ['admin'] },
      priority: 999,
      enabled: true,
    });

    const request: PolicyRequest = {
      tool: 'shell_exec',
      action: 'execute',
      parameters: { command: 'ls' },
      userId: 'admin',
      channelId: 'tui',
      workflowId: 'wf1',
    };

    const decision = await engine.evaluate(request);
    // High priority allow rule should take effect
    expect(decision.allowed).toBe(true);
  });
});
