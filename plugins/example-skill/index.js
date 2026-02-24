'use strict';

/**
 * Example skill plugin - demonstrates the plugin API
 */

class EchoTool {
  constructor() {
    this.schema = {
      name: 'echo',
      description: 'Echo back the input message (example tool)',
      parameters: [
        { name: 'message', type: 'string', description: 'Message to echo back', required: true },
        { name: 'uppercase', type: 'boolean', description: 'Convert to uppercase', required: false, default: false },
      ],
      returns: 'The echoed message',
      category: 'example',
      permissions: [],
    };
  }

  validate(params) {
    const errors = [];
    if (!params.message || typeof params.message !== 'string') {
      errors.push('message is required and must be a string');
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params, context) {
    if (context.dryRun) {
      return { success: true, output: `[DRY RUN] Would echo: ${params.message}` };
    }

    let result = params.message;
    if (params.uppercase) {
      result = result.toUpperCase();
    }

    return {
      success: true,
      output: { echo: result, timestamp: new Date().toISOString() },
    };
  }
}

class ExampleSkillPlugin {
  constructor() {
    this.metadata = {
      name: 'example-skill',
      version: '1.0.0',
      description: 'Example plugin demonstrating the skill SDK',
      author: 'AIAssistant',
      permissions: [],
      tools: ['echo'],
    };
    this.tool = new EchoTool();
  }

  async initialize(context) {
    context.registerTool(this.tool);
    context.logger.info('Example skill plugin initialized');
  }

  async shutdown() {
    // Nothing to clean up
  }

  getTools() {
    return [this.tool];
  }
}

module.exports = ExampleSkillPlugin;
