/**
 * Task manager - manages periodic coded tasks that run on a schedule.
 *
 * A task is similar to a skill but runs automatically at a configurable
 * interval (e.g. "check my emails every 30 seconds").  Tasks are persisted
 * to disk so they can be restored across daemon restarts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventBusInterface } from './interfaces';
import { Events } from './event-bus';
import type { ToolRegistry } from '../tools/registry';
import type { SkillManager } from './skill-manager';

export type TaskStatus = 'running' | 'paused' | 'stopped';

export interface TaskInfo {
  id: string;
  name: string;
  description: string;
  /** The JavaScript source code to run periodically */
  code: string;
  /** Interval between runs in milliseconds */
  intervalMs: number;
  status: TaskStatus;
  createdAt: Date;
  lastRunAt?: Date;
  runCount: number;
  lastError?: string;
  filePath: string;
}

export class TaskManager {
  private tasks: Map<string, TaskInfo> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private eventBus: EventBusInterface;
  private tasksDir: string;
  private toolRegistry?: ToolRegistry;
  private skillManager?: SkillManager;

  constructor(eventBus: EventBusInterface, tasksDir: string, toolRegistry?: ToolRegistry, skillManager?: SkillManager) {
    this.eventBus = eventBus;
    this.tasksDir = tasksDir;
    this.toolRegistry = toolRegistry;
    this.skillManager = skillManager;
    if (!fs.existsSync(this.tasksDir)) {
      fs.mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  /**
   * Reload persisted tasks from disk on startup (but do NOT auto-start them).
   */
  loadFromDisk(): void {
    if (!fs.existsSync(this.tasksDir)) return;
    const entries = fs.readdirSync(this.tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.tasksDir, entry.name, 'meta.json');
      const codePath = path.join(this.tasksDir, entry.name, 'index.js');
      if (!fs.existsSync(metaPath) || !fs.existsSync(codePath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const code = fs.readFileSync(codePath, 'utf-8');
        const info: TaskInfo = {
          id: meta.id,
          name: meta.name,
          description: meta.description,
          code,
          intervalMs: meta.intervalMs,
          status: 'stopped',
          createdAt: new Date(meta.createdAt),
          runCount: meta.runCount || 0,
          filePath: codePath,
        };
        this.tasks.set(info.id, info);
      } catch {
        // skip corrupt entries
      }
    }
  }

  /**
   * Create a new periodic task, persist to disk, and start it.
   */
  create(name: string, description: string, code: string, intervalMs: number): TaskInfo {
    for (const t of this.tasks.values()) {
      if (t.name === name) throw new Error(`Task already exists with name: ${name}`);
    }

    const id = crypto.randomUUID();
    const dir = path.join(this.tasksDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const codePath = path.join(dir, 'index.js');
    fs.writeFileSync(codePath, code);

    const info: TaskInfo = {
      id,
      name,
      description,
      code,
      intervalMs,
      status: 'running',
      createdAt: new Date(),
      runCount: 0,
      filePath: codePath,
    };

    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id: info.id,
      name: info.name,
      description: info.description,
      intervalMs: info.intervalMs,
      createdAt: info.createdAt.toISOString(),
      runCount: info.runCount,
    }, null, 2));

    this.tasks.set(id, info);
    this.scheduleRun(info);
    this.eventBus.emit(Events.TASK_CREATED, { id, name, description });
    return { ...info };
  }

  list(): TaskInfo[] {
    return Array.from(this.tasks.values()).map(t => ({ ...t }));
  }

  get(id: string): TaskInfo | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  start(id: string): TaskInfo {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status === 'running') throw new Error(`Task is already running`);

    task.status = 'running';
    this.scheduleRun(task);
    this.eventBus.emit(Events.TASK_STARTED, { id, name: task.name });
    return { ...task };
  }

  pause(id: string): TaskInfo {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== 'running') throw new Error(`Task is not running (status: ${task.status})`);

    task.status = 'paused';
    this.clearTimer(id);
    this.eventBus.emit(Events.TASK_PAUSED, { id, name: task.name });
    return { ...task };
  }

  resume(id: string): TaskInfo {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== 'paused') throw new Error(`Task is not paused (status: ${task.status})`);

    task.status = 'running';
    this.scheduleRun(task);
    this.eventBus.emit(Events.TASK_RESUMED, { id, name: task.name });
    return { ...task };
  }

  delete(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    this.clearTimer(id);
    task.status = 'stopped';

    // Remove files
    const dir = path.dirname(task.filePath);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    this.tasks.delete(id);
    this.eventBus.emit(Events.TASK_DELETED, { id, name: task.name });
  }

  stopAll(): void {
    for (const [id] of this.tasks) {
      this.clearTimer(id);
      const task = this.tasks.get(id);
      if (task) task.status = 'stopped';
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private scheduleRun(task: TaskInfo): void {
    const run = async () => {
      if (task.status !== 'running') return;
      try {
        // Clear require cache
        try { delete require.cache[require.resolve(task.filePath)]; } catch { /* noop */ }
        const mod = require(task.filePath);
        const fn = typeof mod === 'function' ? mod : mod.default || mod.run;
        if (typeof fn === 'function') {
          const context: Record<string, any> = {};
          if (this.toolRegistry) {
            context.tools = this.toolRegistry.getToolbox();
          }
          if (this.skillManager) {
            context.skills = this.skillManager.getSkillRunner();
          }
          await fn(context);
        }
        task.runCount++;
        task.lastRunAt = new Date();
        task.lastError = undefined;
        this.eventBus.emit(Events.TASK_EXECUTED, { id: task.id, name: task.name, runCount: task.runCount });
      } catch (err: any) {
        task.lastError = err.message;
        this.eventBus.emit(Events.TASK_ERROR, { id: task.id, name: task.name, error: err.message });
      }

      // Schedule next run
      if (task.status === 'running' && task.intervalMs > 0) {
        this.timers.set(task.id, setTimeout(run, task.intervalMs));
      }
    };

    // First run after one interval (give the system time to settle)
    this.timers.set(task.id, setTimeout(run, task.intervalMs));
  }
}
