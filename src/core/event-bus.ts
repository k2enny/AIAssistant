/**
 * In-process event bus for internal communication
 */
import { EventEmitter } from 'events';
import { EventBusInterface } from './interfaces';

export class EventBus implements EventBusInterface {
  private emitter: EventEmitter;
  private history: Array<{ event: string; data: any; timestamp: Date }> = [];
  private maxHistory: number;

  constructor(maxHistory = 1000) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.maxHistory = maxHistory;
  }

  emit(event: string, data: any): void {
    this.history.push({ event, data, timestamp: new Date() });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    this.emitter.emit(event, data);
    this.emitter.emit('*', { event, data });
  }

  on(event: string, handler: (data: any) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: string, handler: (data: any) => void): void {
    this.emitter.off(event, handler);
  }

  once(event: string, handler: (data: any) => void): void {
    this.emitter.once(event, handler);
  }

  getHistory(event?: string, limit = 50): Array<{ event: string; data: any; timestamp: Date }> {
    const filtered = event ? this.history.filter(h => h.event === event) : this.history;
    return filtered.slice(-limit);
  }

  listenerCount(event: string): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }
}

// Singleton for the main daemon process
let defaultBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!defaultBus) {
    defaultBus = new EventBus();
  }
  return defaultBus;
}

// Well-known event names
export const Events = {
  // Message events
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_SENT: 'message:sent',
  
  // Agent events
  AGENT_STARTED: 'agent:started',
  AGENT_RESPONSE: 'agent:response',
  AGENT_ERROR: 'agent:error',
  AGENT_STREAM_CHUNK: 'agent:stream:chunk',
  AGENT_STREAM_END: 'agent:stream:end',
  
  // Tool events
  TOOL_EXECUTING: 'tool:executing',
  TOOL_COMPLETED: 'tool:completed',
  TOOL_ERROR: 'tool:error',
  TOOL_REGISTERED: 'tool:registered',
  TOOL_UNREGISTERED: 'tool:unregistered',
  
  // Workflow events
  WORKFLOW_CREATED: 'workflow:created',
  WORKFLOW_COMPLETED: 'workflow:completed',
  WORKFLOW_FAILED: 'workflow:failed',
  WORKFLOW_PAUSED: 'workflow:paused',
  WORKFLOW_RESUMED: 'workflow:resumed',
  
  // Policy events
  POLICY_DECISION: 'policy:decision',
  POLICY_RULE_ADDED: 'policy:rule:added',
  POLICY_RULE_REMOVED: 'policy:rule:removed',
  
  // Plugin events
  PLUGIN_LOADED: 'plugin:loaded',
  PLUGIN_UNLOADED: 'plugin:unloaded',
  PLUGIN_RELOADED: 'plugin:reloaded',
  PLUGIN_ERROR: 'plugin:error',
  
  // Channel events
  CHANNEL_CONNECTED: 'channel:connected',
  CHANNEL_DISCONNECTED: 'channel:disconnected',
  
  // Sub-agent events
  SUBAGENT_SPAWNED: 'subagent:spawned',
  SUBAGENT_STOPPED: 'subagent:stopped',
  SUBAGENT_PAUSED: 'subagent:paused',
  SUBAGENT_RESUMED: 'subagent:resumed',
  SUBAGENT_ERROR: 'subagent:error',
  SUBAGENT_OUTPUT: 'subagent:output',

  // Skill events
  SKILL_CREATED: 'skill:created',
  SKILL_EXECUTED: 'skill:executed',
  SKILL_DELETED: 'skill:deleted',

  // Task events
  TASK_CREATED: 'task:created',
  TASK_STARTED: 'task:started',
  TASK_PAUSED: 'task:paused',
  TASK_RESUMED: 'task:resumed',
  TASK_EXECUTED: 'task:executed',
  TASK_ERROR: 'task:error',
  TASK_DELETED: 'task:deleted',

  // Email events
  EMAIL_RECEIVED: 'email:received',
  EMAIL_SENT: 'email:sent',
  EMAIL_ERROR: 'email:error',

  // System events
  DAEMON_STARTED: 'daemon:started',
  DAEMON_STOPPING: 'daemon:stopping',
  CONFIRMATION_REQUIRED: 'confirmation:required',
  CONFIRMATION_RESPONSE: 'confirmation:response',
} as const;
