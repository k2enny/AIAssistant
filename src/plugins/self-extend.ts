/**
 * Self-extension pipeline - generate, validate, and hot-load new skills
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { generateSkillPlugin, SkillTemplate } from './sdk';
import { PluginLoader } from './loader';
import { EventBusInterface } from '../core/interfaces';
import { Events } from '../core/event-bus';

export interface ExtensionRequest {
  name: string;
  description: string;
  toolName: string;
  toolDescription: string;
  parameters: Array<{ name: string; type: string; description: string; required: boolean }>;
  permissions?: string[];
  author?: string;
}

export interface ExtensionResult {
  success: boolean;
  pluginPath?: string;
  error?: string;
  testOutput?: string;
}

export class SelfExtensionPipeline {
  private pluginLoader: PluginLoader;
  private eventBus: EventBusInterface;
  private pluginBaseDir: string;

  constructor(pluginLoader: PluginLoader, eventBus: EventBusInterface, pluginBaseDir?: string) {
    this.pluginLoader = pluginLoader;
    this.eventBus = eventBus;
    this.pluginBaseDir = pluginBaseDir || 
      path.join(process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant'), 'plugins');
  }

  /**
   * Generate a new skill plugin
   */
  async generateSkill(request: ExtensionRequest): Promise<ExtensionResult> {
    const pluginDir = path.join(this.pluginBaseDir, request.name);

    // Check if plugin already exists
    if (fs.existsSync(pluginDir)) {
      return { success: false, error: `Plugin directory already exists: ${pluginDir}` };
    }

    try {
      const template: SkillTemplate = {
        name: request.name,
        version: '1.0.0',
        description: request.description,
        author: request.author || 'AIAssistant',
        permissions: request.permissions || [],
        toolName: request.toolName,
        toolDescription: request.toolDescription,
        parameters: request.parameters,
      };

      generateSkillPlugin(template, pluginDir);

      return { success: true, pluginPath: pluginDir };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Validate a generated skill (run tests)
   */
  async validateSkill(pluginName: string): Promise<ExtensionResult> {
    const pluginDir = path.join(this.pluginBaseDir, pluginName);
    const testFile = path.join(pluginDir, 'test.js');

    if (!fs.existsSync(testFile)) {
      return { success: false, error: 'No test file found' };
    }

    try {
      const output = execSync(`node "${testFile}"`, {
        timeout: 30000,
        encoding: 'utf-8',
        cwd: pluginDir,
      });

      return { success: true, testOutput: output, pluginPath: pluginDir };
    } catch (err: any) {
      return {
        success: false,
        error: 'Tests failed',
        testOutput: err.stdout?.toString() || err.message,
      };
    }
  }

  /**
   * Enable a plugin (hot-load into the daemon)
   */
  async enableSkill(pluginName: string): Promise<ExtensionResult> {
    try {
      await this.pluginLoader.loadPlugin(pluginName);
      
      this.eventBus.emit(Events.PLUGIN_LOADED, { 
        name: pluginName,
        source: 'self-extension',
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Full pipeline: generate -> validate -> enable
   */
  async extendWithApproval(
    request: ExtensionRequest,
    approvalCallback: (diff: string) => Promise<boolean>
  ): Promise<ExtensionResult> {
    // Step 1: Generate
    const genResult = await this.generateSkill(request);
    if (!genResult.success) return genResult;

    // Step 2: Show diff for approval
    const pluginDir = path.join(this.pluginBaseDir, request.name);
    const files = fs.readdirSync(pluginDir);
    let diff = `New plugin: ${request.name}\nFiles:\n`;
    for (const file of files) {
      const content = fs.readFileSync(path.join(pluginDir, file), 'utf-8');
      diff += `\n--- ${file} ---\n${content}\n`;
    }

    // Step 3: Validate
    const valResult = await this.validateSkill(request.name);
    diff += `\n--- Test Results ---\n${valResult.testOutput || 'No output'}\n`;

    if (!valResult.success) {
      // Clean up failed plugin
      this.cleanupPlugin(request.name);
      return { ...valResult, error: `Validation failed: ${valResult.error}` };
    }

    // Step 4: Get approval
    const approved = await approvalCallback(diff);
    if (!approved) {
      this.cleanupPlugin(request.name);
      return { success: false, error: 'Plugin rejected by user' };
    }

    // Step 5: Enable
    return this.enableSkill(request.name);
  }

  private cleanupPlugin(pluginName: string): void {
    const pluginDir = path.join(this.pluginBaseDir, pluginName);
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  }
}
