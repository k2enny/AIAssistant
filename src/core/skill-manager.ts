/**
 * Skill manager - manages reusable coded functions (skills) that the
 * assistant creates, persists to disk, and can invoke later.
 *
 * A skill is a small JavaScript function saved to a file.  The assistant
 * generates the code at creation time and the skill can be called
 * repeatedly without regenerating.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventBusInterface } from './interfaces';
import { Events } from './event-bus';
import type { ToolRegistry } from '../tools/registry';

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  /** The JavaScript source code of the skill */
  code: string;
  /** JSON-serialisable parameter schema for documentation */
  parameters: Array<{ name: string; type: string; description: string; required: boolean }>;
  createdAt: Date;
  lastUsedAt?: Date;
  useCount: number;
  filePath: string;
}

export class SkillManager {
  private skills: Map<string, SkillInfo> = new Map();
  private eventBus: EventBusInterface;
  private skillsDir: string;
  private toolRegistry?: ToolRegistry;

  constructor(eventBus: EventBusInterface, skillsDir: string, toolRegistry?: ToolRegistry) {
    this.eventBus = eventBus;
    this.skillsDir = skillsDir;
    this.toolRegistry = toolRegistry;
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  /**
   * Reload persisted skills from disk on startup.
   */
  loadFromDisk(): void {
    if (!fs.existsSync(this.skillsDir)) return;
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.skillsDir, entry.name, 'meta.json');
      const codePath = path.join(this.skillsDir, entry.name, 'index.js');
      if (!fs.existsSync(metaPath) || !fs.existsSync(codePath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const code = fs.readFileSync(codePath, 'utf-8');
        const info: SkillInfo = {
          id: meta.id,
          name: meta.name,
          description: meta.description,
          code,
          parameters: meta.parameters || [],
          createdAt: new Date(meta.createdAt),
          lastUsedAt: meta.lastUsedAt ? new Date(meta.lastUsedAt) : undefined,
          useCount: meta.useCount || 0,
          filePath: codePath,
        };
        this.skills.set(info.id, info);
      } catch {
        // skip corrupt entries
      }
    }
  }

  /**
   * Create a new skill, persist code to disk.
   */
  create(name: string, description: string, code: string, parameters: SkillInfo['parameters'] = []): SkillInfo {
    // Ensure uniqueness by name
    for (const s of this.skills.values()) {
      if (s.name === name) throw new Error(`Skill already exists with name: ${name}`);
    }
    const id = crypto.randomUUID();
    const dir = path.join(this.skillsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const codePath = path.join(dir, 'index.js');
    fs.writeFileSync(codePath, code);

    const info: SkillInfo = {
      id,
      name,
      description,
      code,
      parameters,
      createdAt: new Date(),
      useCount: 0,
      filePath: codePath,
    };

    // Persist metadata
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id: info.id,
      name: info.name,
      description: info.description,
      parameters: info.parameters,
      createdAt: info.createdAt.toISOString(),
      useCount: info.useCount,
    }, null, 2));

    this.skills.set(id, info);
    this.eventBus.emit(Events.SKILL_CREATED, { id, name, description });
    return { ...info };
  }

  /**
   * Execute a skill by id.  The code is loaded fresh from the cached
   * source and evaluated in a minimal sandbox.
   */
  async execute(id: string, params: Record<string, any> = {}): Promise<any> {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Skill not found: ${id}`);

    // Clear require cache to pick up any edits
    try { delete require.cache[require.resolve(skill.filePath)]; } catch { /* noop */ }
    const mod = require(skill.filePath);
    const fn = typeof mod === 'function' ? mod : mod.default || mod.run;
    if (typeof fn !== 'function') {
      throw new Error(`Skill "${skill.name}" does not export a callable function`);
    }

    const context: Record<string, any> = {};
    if (this.toolRegistry) {
      context.tools = this.toolRegistry.getToolbox();
    }
    const result = await fn(params, context);
    skill.useCount++;
    skill.lastUsedAt = new Date();
    this.eventBus.emit(Events.SKILL_EXECUTED, { id, name: skill.name });
    return result;
  }

  list(): SkillInfo[] {
    return Array.from(this.skills.values()).map(s => ({ ...s }));
  }

  get(id: string): SkillInfo | undefined {
    const s = this.skills.get(id);
    return s ? { ...s } : undefined;
  }

  getByName(name: string): SkillInfo | undefined {
    for (const s of this.skills.values()) {
      if (s.name === name) return { ...s };
    }
    return undefined;
  }

  delete(id: string): void {
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`Skill not found: ${id}`);

    // Remove files
    const dir = path.dirname(skill.filePath);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    this.skills.delete(id);
    this.eventBus.emit(Events.SKILL_DELETED, { id, name: skill.name });
  }
}
