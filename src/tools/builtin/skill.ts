/**
 * Skill management tool - lets the LLM create, list, execute, and delete
 * reusable coded functions (skills).
 *
 * Actions:
 *   create  - Generate and save a new skill
 *   list    - List all skills
 *   execute - Run a skill by id or name
 *   get     - Get details of a specific skill
 *   delete  - Delete a skill
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';
import { SkillManager } from '../../core/skill-manager';

export class SkillTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'skill',
    description:
      'Manage reusable coded skills. Skills are one-time coded functions that you create and can invoke repeatedly. ' +
      'Use this when the user asks you to create a reusable capability (e.g. "read a website", "convert currencies"). ' +
      'The code should be a Node.js module that exports a single async function. ' +
      'IMPORTANT: The function receives (params, { tools, skills }) where "tools" is an object ' +
      'with all built-in tools (e.g. tools.gmail, tools.web_browse, tools.shell_exec) and "skills" ' +
      'is an object with all created skills callable by name (e.g. await skills["my-skill"]({ param: "value" })). ' +
      'Always prefer using built-in tools and existing skills over writing raw implementations. ' +
      'For example, to send email use: const result = await tools.gmail({ action: "send", to, subject, body }); ' +
      'Signature: module.exports = async function(params, { tools, skills }) { ... }',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action: "create", "list", "execute", "get", "delete"',
        required: true,
      },
      {
        name: 'skill_id',
        type: 'string',
        description: 'Skill ID (for "execute", "get", "delete"). Can also pass skill name.',
        required: false,
      },
      {
        name: 'name',
        type: 'string',
        description: 'Name for the new skill (for "create")',
        required: false,
      },
      {
        name: 'description',
        type: 'string',
        description: 'Description of what the skill does (for "create")',
        required: false,
      },
      {
        name: 'code',
        type: 'string',
        description:
          'The Node.js code for the skill (for "create"). Must export a function: module.exports = async function(params) { ... }',
        required: false,
      },
      {
        name: 'parameters',
        type: 'array',
        description: 'Parameter definitions for the skill (for "create")',
        required: false,
      },
      {
        name: 'params',
        type: 'object',
        description: 'Parameters to pass when executing the skill (for "execute")',
        required: false,
      },
    ],
    returns: 'Skill information or execution result',
    category: 'system',
    permissions: ['skill.manage'],
  };

  private manager: SkillManager;

  constructor(manager: SkillManager) {
    this.manager = manager;
  }

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const validActions = ['create', 'list', 'execute', 'get', 'delete'];

    if (!params.action || !validActions.includes(params.action)) {
      errors.push(`action must be one of: ${validActions.join(', ')}`);
    }

    if (params.action === 'create') {
      if (!params.name) errors.push('name is required for create action');
      if (!params.code) errors.push('code is required for create action');
    }

    if (['execute', 'get', 'delete'].includes(params.action) && !params.skill_id) {
      errors.push('skill_id is required for this action');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (context.dryRun) {
      return { success: true, output: `[DRY RUN] Would perform skill action: ${params.action}` };
    }

    try {
      switch (params.action) {
        case 'create':
          return this.createSkill(params);
        case 'list':
          return this.listSkills();
        case 'execute':
          return await this.executeSkill(params);
        case 'get':
          return this.getSkill(params.skill_id);
        case 'delete':
          return this.deleteSkill(params.skill_id);
        default:
          return { success: false, output: null, error: `Unknown action: ${params.action}` };
      }
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }

  private createSkill(params: Record<string, any>): ToolResult {
    const info = this.manager.create(
      params.name,
      params.description || params.name,
      params.code,
      params.parameters || []
    );
    return {
      success: true,
      output: { message: `Skill "${params.name}" created successfully`, skill: info },
    };
  }

  private listSkills(): ToolResult {
    const skills = this.manager.list();
    return {
      success: true,
      output: { count: skills.length, skills },
    };
  }

  private async executeSkill(params: Record<string, any>): Promise<ToolResult> {
    // Resolve by id or name
    let id = params.skill_id;
    if (!this.manager.get(id)) {
      const byName = this.manager.getByName(id);
      if (byName) id = byName.id;
    }
    const result = await this.manager.execute(id, params.params || {});
    return {
      success: true,
      output: { message: `Skill executed successfully`, result },
    };
  }

  private getSkill(skillId: string): ToolResult {
    let info = this.manager.get(skillId);
    if (!info) {
      info = this.manager.getByName(skillId);
    }
    if (!info) {
      return { success: false, output: null, error: `Skill not found: ${skillId}` };
    }
    return { success: true, output: info };
  }

  private deleteSkill(skillId: string): ToolResult {
    let info = this.manager.get(skillId);
    if (!info) {
      const byName = this.manager.getByName(skillId);
      if (byName) skillId = byName.id;
      info = byName;
    }
    this.manager.delete(skillId);
    return {
      success: true,
      output: { message: `Skill "${info?.name || skillId}" deleted` },
    };
  }
}
