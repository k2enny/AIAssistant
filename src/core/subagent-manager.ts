/**
 * Sub-agent manager - spawns, tracks, pauses, resumes, and deletes
 * background sub-agents that run asynchronous tasks (e.g. email watchers).
 */
import * as crypto from 'crypto';
import { EventBusInterface } from './interfaces';
import { Events } from './event-bus';

export type SubAgentStatus = 'running' | 'paused' | 'stopped' | 'error';

export interface SubAgentContext {
  emitMessage: (msg: string) => void;
  channelId?: string;
  userId?: string;
}

export interface SubAgentTask {
  /** Human-readable description of what this agent does */
  description: string;
  /** The function to execute repeatedly (or once). Receives an abort signal and context. */
  execute: (signal: AbortSignal, context: SubAgentContext) => Promise<void>;
  /** Interval in ms between executions (0 = run once) */
  intervalMs: number;
}

export interface SubAgentInfo {
  id: string;
  name: string;
  description: string;
  status: SubAgentStatus;
  intervalMs: number;
  createdAt: Date;
  lastRunAt?: Date;
  runCount: number;
  lastError?: string;
  channelId?: string;
  userId?: string;
}

interface SubAgentEntry {
  info: SubAgentInfo;
  task: SubAgentTask;
  timer: ReturnType<typeof setTimeout> | null;
  abortController: AbortController | null;
}

export class SubAgentManager {
  private agents: Map<string, SubAgentEntry> = new Map();
  private eventBus: EventBusInterface;

  constructor(eventBus: EventBusInterface) {
    this.eventBus = eventBus;
  }

  spawn(name: string, task: SubAgentTask, channelId?: string, userId?: string): SubAgentInfo {
    const id = crypto.randomUUID();
    const info: SubAgentInfo = {
      id,
      name,
      description: task.description,
      status: 'running',
      intervalMs: task.intervalMs,
      createdAt: new Date(),
      runCount: 0,
      channelId,
      userId,
    };

    const entry: SubAgentEntry = {
      info,
      task,
      timer: null,
      abortController: null,
    };

    this.agents.set(id, entry);
    this.eventBus.emit(Events.SUBAGENT_SPAWNED, { id, name, description: task.description });

    // Start execution
    this.scheduleRun(entry);

    return { ...info };
  }

  /**
   * List all sub-agents.
   */
  list(): SubAgentInfo[] {
    return Array.from(this.agents.values()).map(e => ({ ...e.info }));
  }

  /**
   * Get a single sub-agent's info.
   */
  get(id: string): SubAgentInfo | undefined {
    const entry = this.agents.get(id);
    return entry ? { ...entry.info } : undefined;
  }

  /**
   * Pause a running sub-agent.
   */
  pause(id: string): SubAgentInfo {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Sub-agent not found: ${id}`);
    if (entry.info.status !== 'running') throw new Error(`Sub-agent is not running (status: ${entry.info.status})`);

    entry.info.status = 'paused';
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.abortController) {
      entry.abortController.abort();
      entry.abortController = null;
    }

    this.eventBus.emit(Events.SUBAGENT_PAUSED, { id, name: entry.info.name });
    return { ...entry.info };
  }

  /**
   * Resume a paused sub-agent.
   */
  resume(id: string): SubAgentInfo {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Sub-agent not found: ${id}`);
    if (entry.info.status !== 'paused') throw new Error(`Sub-agent is not paused (status: ${entry.info.status})`);

    entry.info.status = 'running';
    this.scheduleRun(entry);

    this.eventBus.emit(Events.SUBAGENT_RESUMED, { id, name: entry.info.name });
    return { ...entry.info };
  }

  /**
   * Delete (stop and remove) a sub-agent.
   */
  delete(id: string): void {
    const entry = this.agents.get(id);
    if (!entry) throw new Error(`Sub-agent not found: ${id}`);

    entry.info.status = 'stopped';
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.abortController) {
      entry.abortController.abort();
      entry.abortController = null;
    }

    this.agents.delete(id);
    this.eventBus.emit(Events.SUBAGENT_STOPPED, { id, name: entry.info.name });
  }

  /**
   * Stop all sub-agents (for daemon shutdown).
   */
  stopAll(): void {
    for (const [id] of this.agents) {
      try {
        this.delete(id);
      } catch {
        // Ignore errors during shutdown
      }
    }
  }

  private scheduleRun(entry: SubAgentEntry): void {
    if (entry.info.status !== 'running') return;

    const run = async () => {
      if (entry.info.status !== 'running') return;

      entry.abortController = new AbortController();

      const context: SubAgentContext = {
        channelId: entry.info.channelId,
        userId: entry.info.userId,
        emitMessage: (msg: string) => {
          if (entry.info.channelId) {
            this.eventBus.emit(Events.AGENT_RESPONSE, {
              workflowId: entry.info.id,
              userId: entry.info.userId || 'system',
              channelId: entry.info.channelId,
              content: `[SubAgent: ${entry.info.name}] ${msg}`,
            });
          }
        },
      };

      try {
        await entry.task.execute(entry.abortController.signal, context);
        entry.info.lastRunAt = new Date();
        entry.info.runCount++;
        entry.info.lastError = undefined;

        this.eventBus.emit(Events.SUBAGENT_OUTPUT, {
          id: entry.info.id,
          name: entry.info.name,
          runCount: entry.info.runCount,
        });
      } catch (err: any) {
        if (err.name === 'AbortError') return; // Expected on pause/delete
        entry.info.lastError = err.message;
        this.eventBus.emit(Events.SUBAGENT_ERROR, {
          id: entry.info.id,
          name: entry.info.name,
          error: err.message,
        });
      } finally {
        entry.abortController = null;
      }

      // Schedule next run if interval > 0 and still running
      if (entry.task.intervalMs > 0 && entry.info.status === 'running') {
        entry.timer = setTimeout(run, entry.task.intervalMs);
      }
    };

    // First run immediately
    run();
  }
}
