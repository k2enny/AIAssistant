/**
 * Skill SDK - template and utilities for creating plugins
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SkillTemplate {
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: string[];
  toolName: string;
  toolDescription: string;
  parameters: Array<{ name: string; type: string; description: string; required: boolean }>;
}

/**
 * Generate a new skill plugin from a template
 */
export function generateSkillPlugin(template: SkillTemplate, outputDir: string): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate plugin.json
  const metadata = {
    name: template.name,
    version: template.version,
    description: template.description,
    author: template.author,
    permissions: template.permissions,
    tools: [template.toolName],
  };
  fs.writeFileSync(
    path.join(outputDir, 'plugin.json'),
    JSON.stringify(metadata, null, 2)
  );

  // Generate index.js
  const indexCode = generatePluginCode(template);
  fs.writeFileSync(path.join(outputDir, 'index.js'), indexCode);

  // Generate test file
  const testCode = generateTestCode(template);
  fs.writeFileSync(path.join(outputDir, 'test.js'), testCode);

  // Generate README
  const readme = generateReadme(template);
  fs.writeFileSync(path.join(outputDir, 'README.md'), readme);
}

function generatePluginCode(template: SkillTemplate): string {
  const paramsInterface = template.parameters
    .map(p => `    // ${p.name} (${p.type}): ${p.description}`)
    .join('\n');

  return `'use strict';

/**
 * ${template.description}
 * Auto-generated plugin by AIAssistant Skill SDK
 */

class ${toPascalCase(template.toolName)}Tool {
  constructor() {
    this.schema = {
      name: '${template.toolName}',
      description: '${template.toolDescription}',
      parameters: ${JSON.stringify(template.parameters, null, 8)},
      returns: 'Tool result',
      category: 'plugin',
      permissions: ${JSON.stringify(template.permissions)},
    };
  }

  validate(params) {
    const errors = [];
${template.parameters.filter(p => p.required).map(p => 
    `    if (!params.${p.name}) errors.push('${p.name} is required');`
  ).join('\n')}
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params, context) {
    try {
      if (context.dryRun) {
        return { success: true, output: '[DRY RUN] ${template.toolName} would execute with: ' + JSON.stringify(params) };
      }

      // TODO: Implement actual tool logic here
${paramsInterface}
      
      return {
        success: true,
        output: { message: '${template.toolName} executed successfully', params },
      };
    } catch (err) {
      return { success: false, output: null, error: err.message };
    }
  }
}

class ${toPascalCase(template.name)}Plugin {
  constructor() {
    this.metadata = {
      name: '${template.name}',
      version: '${template.version}',
      description: '${template.description}',
      author: '${template.author}',
      permissions: ${JSON.stringify(template.permissions)},
      tools: ['${template.toolName}'],
    };
    this.tool = new ${toPascalCase(template.toolName)}Tool();
  }

  async initialize(context) {
    context.registerTool(this.tool);
    context.logger.info('Plugin ${template.name} initialized');
  }

  async shutdown() {
    // Cleanup resources if needed
  }

  getTools() {
    return [this.tool];
  }
}

module.exports = ${toPascalCase(template.name)}Plugin;
`;
}

function generateTestCode(template: SkillTemplate): string {
  return `'use strict';

const PluginClass = require('./index');

async function runTests() {
  console.log('Testing ${template.name} plugin...');
  
  const plugin = new PluginClass();
  
  // Test 1: Metadata
  console.assert(plugin.metadata.name === '${template.name}', 'Plugin name should match');
  console.assert(plugin.metadata.version === '${template.version}', 'Version should match');
  console.log('  ✅ Metadata test passed');
  
  // Test 2: Tool schema
  const tools = plugin.getTools();
  console.assert(tools.length === 1, 'Should have one tool');
  console.assert(tools[0].schema.name === '${template.toolName}', 'Tool name should match');
  console.log('  ✅ Tool schema test passed');
  
  // Test 3: Tool validation
  const tool = tools[0];
  if (tool.validate) {
    const validResult = tool.validate(${JSON.stringify(
      template.parameters.reduce((acc: any, p) => {
        acc[p.name] = p.type === 'number' ? 42 : 'test';
        return acc;
      }, {})
    )});
    console.assert(validResult.valid === true, 'Should be valid with all params');
    console.log('  ✅ Validation test passed');
  }
  
  // Test 4: Tool execution (dry run)
  const result = await tool.execute(
    ${JSON.stringify(
      template.parameters.reduce((acc: any, p) => {
        acc[p.name] = p.type === 'number' ? 42 : 'test';
        return acc;
      }, {})
    )},
    { workflowId: 'test', userId: 'test', channelId: 'test', dryRun: true }
  );
  console.assert(result.success === true, 'Dry run should succeed');
  console.log('  ✅ Dry run execution test passed');
  
  // Test 5: Plugin lifecycle
  const mockContext = {
    storage: {},
    eventBus: { emit: () => {}, on: () => {}, off: () => {}, once: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registerTool: () => {},
    unregisterTool: () => {},
  };
  
  await plugin.initialize(mockContext);
  await plugin.shutdown();
  console.log('  ✅ Lifecycle test passed');
  
  console.log('\\n✅ All tests passed for ${template.name}!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
`;
}

function generateReadme(template: SkillTemplate): string {
  return `# ${template.name}

${template.description}

## Tool: ${template.toolName}

${template.toolDescription}

### Parameters

${template.parameters.map(p => `- **${p.name}** (${p.type}${p.required ? ', required' : ''}): ${p.description}`).join('\n')}

## Installation

Copy this plugin directory to \`~/.aiassistant/plugins/${template.name}/\`

## Testing

\`\`\`bash
node test.js
\`\`\`

## Version

${template.version}

## Author

${template.author}
`;
}

function toPascalCase(str: string): string {
  return str
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}
