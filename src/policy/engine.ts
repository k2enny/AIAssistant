/**
 * Policy engine - evaluates rules before tool/action execution
 */
import * as crypto from 'crypto';
import {
  PolicyEngine as IPolicyEngine,
  PolicyRule,
  PolicyScope,
  PolicyRequest,
  PolicyDecision,
  PolicyAction,
  StorageInterface,
  EventBusInterface,
} from '../core/interfaces';
import { Events } from '../core/event-bus';

const POLICY_TABLE = 'policy_rules';

export class PolicyEngineImpl implements IPolicyEngine {
  private storage: StorageInterface;
  private eventBus: EventBusInterface;
  private rulesCache: PolicyRule[] = [];
  private initialized = false;

  constructor(storage: StorageInterface, eventBus: EventBusInterface) {
    this.storage = storage;
    this.eventBus = eventBus;
  }

  async initialize(): Promise<void> {
    await this.storage.ensureTable(POLICY_TABLE, {
      id: 'TEXT PRIMARY KEY',
      data: 'TEXT NOT NULL',
      updated_at: 'TEXT',
    });
    
    await this.loadRules();
    
    // Add default rules if none exist
    if (this.rulesCache.length === 0) {
      await this.addDefaultRules();
    }
    
    this.initialized = true;
  }

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    if (!this.initialized) await this.initialize();
    
    const applicableRules = this.getApplicableRules(request);
    
    // Sort by priority (higher = more important)
    applicableRules.sort((a, b) => b.priority - a.priority);
    
    // Evaluate rules - first matching deny/confirm wins
    for (const rule of applicableRules) {
      if (!rule.enabled) continue;
      
      if (this.matchesRule(request, rule)) {
        const decision: PolicyDecision = {
          allowed: rule.action === 'allow',
          action: rule.action,
          rule,
          reason: `${rule.action === 'deny' ? 'Blocked' : rule.action === 'require-confirmation' ? 'Confirmation required' : 'Allowed'} by rule: ${rule.name}`,
        };
        
        this.eventBus.emit(Events.POLICY_DECISION, {
          request,
          decision,
          timestamp: new Date().toISOString(),
        });
        
        return decision;
      }
    }
    
    // Default: allow if no rule matches
    const decision: PolicyDecision = {
      allowed: true,
      action: 'allow',
      reason: 'No matching policy rule - default allow',
    };
    
    this.eventBus.emit(Events.POLICY_DECISION, { request, decision });
    return decision;
  }

  async addRule(ruleData: Omit<PolicyRule, 'id'>): Promise<PolicyRule> {
    const rule: PolicyRule = { ...ruleData, id: crypto.randomUUID() };
    await this.storage.set(POLICY_TABLE, rule.id, rule);
    this.rulesCache.push(rule);
    
    this.eventBus.emit(Events.POLICY_RULE_ADDED, { rule });
    return rule;
  }

  async removeRule(id: string): Promise<void> {
    await this.storage.delete(POLICY_TABLE, id);
    this.rulesCache = this.rulesCache.filter(r => r.id !== id);
    this.eventBus.emit(Events.POLICY_RULE_REMOVED, { id });
  }

  async updateRule(id: string, updates: Partial<PolicyRule>): Promise<void> {
    const idx = this.rulesCache.findIndex(r => r.id === id);
    if (idx === -1) throw new Error(`Rule not found: ${id}`);
    
    const updated = { ...this.rulesCache[idx], ...updates, id };
    await this.storage.set(POLICY_TABLE, id, updated);
    this.rulesCache[idx] = updated;
  }

  async listRules(scope?: Partial<PolicyScope>): Promise<PolicyRule[]> {
    if (!scope) return [...this.rulesCache];
    
    return this.rulesCache.filter(rule => {
      if (scope.global !== undefined && rule.scope.global !== scope.global) return false;
      if (scope.tools && !scope.tools.some(t => rule.scope.tools?.includes(t))) return false;
      if (scope.channels && !scope.channels.some(c => rule.scope.channels?.includes(c))) return false;
      return true;
    });
  }

  async getRule(id: string): Promise<PolicyRule | null> {
    return this.rulesCache.find(r => r.id === id) || null;
  }

  private getApplicableRules(request: PolicyRequest): PolicyRule[] {
    return this.rulesCache.filter(rule => {
      if (rule.scope.global) return true;
      if (rule.scope.tools?.includes(request.tool)) return true;
      if (rule.scope.tools?.includes('*')) return true;
      if (rule.scope.channels?.includes(request.channelId)) return true;
      if (rule.scope.agents?.includes(request.agentId || '')) return true;
      if (rule.scope.workflows?.includes(request.workflowId)) return true;
      return false;
    });
  }

  private matchesRule(request: PolicyRequest, rule: PolicyRule): boolean {
    // Check target patterns
    if (rule.target.commands?.length) {
      if (!rule.target.commands.some(cmd => 
        request.action === cmd || request.tool === cmd || 
        (cmd.includes('*') && new RegExp('^' + cmd.replace(/\*/g, '.*') + '$').test(request.tool))
      )) {
        return false;
      }
    }
    
    if (rule.target.domains?.length && request.parameters.url) {
      try {
        const url = new URL(request.parameters.url);
        if (!rule.target.domains.some(d => url.hostname.includes(d))) {
          return false;
        }
      } catch {
        // Invalid URL - apply rule as precaution
      }
    }
    
    if (rule.target.users?.length && request.userId) {
      if (!rule.target.users.includes(request.userId)) {
        return false;
      }
    }
    
    return true;
  }

  private async loadRules(): Promise<void> {
    try {
      const rows = await this.storage.query(POLICY_TABLE);
      this.rulesCache = rows.map(row => {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        return data;
      });
    } catch {
      this.rulesCache = [];
    }
  }

  private async addDefaultRules(): Promise<void> {
    const defaults: Array<Omit<PolicyRule, 'id'>> = [
      {
        name: 'Confirm downloads',
        description: 'No downloads without explicit confirmation',
        scope: { global: true },
        action: 'require-confirmation',
        target: { commands: ['download', 'web_fetch', 'web_browse'] },
        priority: 100,
        enabled: true,
      },
      {
        name: 'Official repos only',
        description: 'Only install packages from official repos unless confirmed',
        scope: { global: true },
        action: 'require-confirmation',
        target: { commands: ['shell_exec', 'package_install'] },
        priority: 90,
        enabled: true,
      },
      {
        name: 'Subagent shell restriction',
        description: 'Subagents cannot execute shell commands unless granted',
        scope: { agents: ['subagent-*'] },
        action: 'deny',
        target: { commands: ['shell_exec'] },
        priority: 80,
        enabled: true,
      },
      {
        name: 'Unknown domains confirmation',
        description: 'Unknown domains require confirmation',
        scope: { global: true },
        action: 'require-confirmation',
        target: { commands: ['web_browse', 'web_fetch'] },
        priority: 70,
        enabled: true,
      },
    ];

    for (const rule of defaults) {
      await this.addRule(rule);
    }
  }
}
