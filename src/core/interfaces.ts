/**
 * Core interfaces for AIAssistant - extensible agent platform
 */

import { EventEmitter } from 'events';

// ============ Storage Interface ============
export interface StorageInterface {
  initialize(): Promise<void>;
  close(): Promise<void>;
  get(table: string, key: string): Promise<any>;
  set(table: string, key: string, value: any): Promise<void>;
  delete(table: string, key: string): Promise<void>;
  query(table: string, filter?: Record<string, any>): Promise<any[]>;
  ensureTable(table: string, schema: Record<string, string>): Promise<void>;
}

// ============ Channel/Connector Interface ============
export interface Message {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface ChannelConnector {
  readonly id: string;
  readonly name: string;
  initialize(eventBus: EventBusInterface): Promise<void>;
  shutdown(): Promise<void>;
  sendMessage(userId: string, content: string, metadata?: Record<string, any>): Promise<void>;
  sendStreamChunk?(userId: string, chunk: string, streamId: string): Promise<void>;
  isConnected(): boolean;
}

// ============ Tool Interface ============
export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: any;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: string;
  category: string;
  permissions: string[];
}

export interface ToolResult {
  success: boolean;
  output: any;
  error?: string;
  metadata?: Record<string, any>;
}

export interface Tool {
  readonly schema: ToolSchema;
  execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult>;
  validate?(params: Record<string, any>): { valid: boolean; errors?: string[] };
}

export interface ToolContext {
  workflowId: string;
  userId: string;
  channelId: string;
  dryRun: boolean;
  confirmCallback?: (message: string) => Promise<boolean>;
}

// ============ Plugin/Skill Interface ============
export interface PluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: string[];
  tools: string[];
  dependencies?: string[];
}

export interface Plugin {
  readonly metadata: PluginMetadata;
  initialize(context: PluginContext): Promise<void>;
  shutdown(): Promise<void>;
  getTools(): Tool[];
}

export interface PluginContext {
  storage: StorageInterface;
  eventBus: EventBusInterface;
  logger: Logger;
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
}

// ============ Policy Interface ============
export type PolicyAction = 'allow' | 'deny' | 'require-confirmation';

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  scope: PolicyScope;
  action: PolicyAction;
  target: PolicyTarget;
  priority: number;
  enabled: boolean;
  metadata?: Record<string, any>;
}

export interface PolicyScope {
  global?: boolean;
  tools?: string[];
  channels?: string[];
  agents?: string[];
  workflows?: string[];
}

export interface PolicyTarget {
  pattern?: string;
  domains?: string[];
  commands?: string[];
  users?: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  action: PolicyAction;
  rule?: PolicyRule;
  reason: string;
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): Promise<PolicyDecision>;
  addRule(rule: Omit<PolicyRule, 'id'>): Promise<PolicyRule>;
  removeRule(id: string): Promise<void>;
  updateRule(id: string, updates: Partial<PolicyRule>): Promise<void>;
  listRules(scope?: Partial<PolicyScope>): Promise<PolicyRule[]>;
  getRule(id: string): Promise<PolicyRule | null>;
}

export interface PolicyRequest {
  tool: string;
  action: string;
  parameters: Record<string, any>;
  userId: string;
  channelId: string;
  workflowId: string;
  agentId?: string;
}

// ============ Agent Interface ============
export interface AgentConfig {
  id: string;
  name: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: string[];
  permissions?: string[];
}

export interface Agent {
  readonly config: AgentConfig;
  processMessage(message: Message, context: AgentContext): Promise<AgentResponse>;
  getStatus(): AgentStatus;
}

export interface AgentContext {
  workflowId: string;
  memory: WorkflowMemory;
  tools: Tool[];
  policy: PolicyEngine;
  eventBus: EventBusInterface;
}

export interface AgentResponse {
  content: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, any>;
}

export interface ToolCall {
  id: string;
  tool: string;
  parameters: Record<string, any>;
  result?: ToolResult;
}

export interface AgentStatus {
  id: string;
  state: 'idle' | 'processing' | 'waiting' | 'error';
  currentWorkflow?: string;
  lastActivity?: Date;
}

// ============ Memory Interface ============
export interface WorkflowMemory {
  workflowId: string;
  getContext(): Promise<MemoryContext>;
  addMessage(role: 'user' | 'assistant' | 'system' | 'tool', content: string, metadata?: Record<string, any>): Promise<void>;
  getSummary(): Promise<string>;
  clear(): Promise<void>;
  fork(newWorkflowId: string): Promise<WorkflowMemory>;
}

export interface MemoryContext {
  messages: MemoryMessage[];
  summary?: string;
  metadata?: Record<string, any>;
}

export interface MemoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

// ============ Event Bus Interface ============
export interface EventBusInterface {
  emit(event: string, data: any): void;
  on(event: string, handler: (data: any) => void): void;
  off(event: string, handler: (data: any) => void): void;
  once(event: string, handler: (data: any) => void): void;
}

// ============ Scheduler Interface ============
export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string; // cron-like or ISO date
  action: string;
  params: Record<string, any>;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
}

export interface Scheduler {
  schedule(task: Omit<ScheduledTask, 'id'>): Promise<ScheduledTask>;
  cancel(id: string): Promise<void>;
  list(): Promise<ScheduledTask[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
}

// ============ Workflow Interface ============
export interface Workflow {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  agentId: string;
  parentWorkflowId?: string;
  channelId: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

// ============ Logger Interface ============
export interface Logger {
  info(message: string, meta?: Record<string, any>): void;
  warn(message: string, meta?: Record<string, any>): void;
  error(message: string, meta?: Record<string, any>): void;
  debug(message: string, meta?: Record<string, any>): void;
}

// ============ IPC Protocol ============
export interface IPCRequest {
  id: string;
  method: string;
  params?: any;
}

export interface IPCResponse {
  id: string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface IPCStreamEvent {
  id: string;
  event: string;
  data: any;
}
