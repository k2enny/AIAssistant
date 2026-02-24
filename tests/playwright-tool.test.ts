import { PlaywrightTool } from '../src/tools/builtin/playwright';
import { ToolContext } from '../src/core/interfaces';

describe('PlaywrightTool', () => {
  const tool = new PlaywrightTool();
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  afterAll(async () => {
    await tool.cleanup();
  });

  describe('schema', () => {
    test('should have correct tool name', () => {
      expect(tool.schema.name).toBe('web_browse');
    });

    test('should have web category', () => {
      expect(tool.schema.category).toBe('web');
    });

    test('should require web.browse permission', () => {
      expect(tool.schema.permissions).toContain('web.browse');
    });

    test('should define action parameter as required', () => {
      const actionParam = tool.schema.parameters.find(p => p.name === 'action');
      expect(actionParam).toBeDefined();
      expect(actionParam!.required).toBe(true);
    });
  });

  describe('validate', () => {
    test('should reject missing action', () => {
      const result = tool.validate!({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('action is required and must be a string');
    });

    test('should reject invalid action', () => {
      const result = tool.validate!({ action: 'invalid' });
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toContain('action must be one of');
    });

    test('should require url for navigate action', () => {
      const result = tool.validate!({ action: 'navigate' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('url is required for navigate action');
    });

    test('should accept valid navigate params', () => {
      const result = tool.validate!({ action: 'navigate', url: 'https://example.com' });
      expect(result.valid).toBe(true);
    });

    test('should require selector for click action', () => {
      const result = tool.validate!({ action: 'click' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('selector is required for click action');
    });

    test('should accept valid click params', () => {
      const result = tool.validate!({ action: 'click', selector: '#btn' });
      expect(result.valid).toBe(true);
    });

    test('should require selector and text for type action', () => {
      const result = tool.validate!({ action: 'type' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('selector is required for type action');
      expect(result.errors).toContain('text is required for type action');
    });

    test('should accept valid type params', () => {
      const result = tool.validate!({ action: 'type', selector: '#input', text: 'hello' });
      expect(result.valid).toBe(true);
    });

    test('should require fields for fill_form action', () => {
      const result = tool.validate!({ action: 'fill_form' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('fields is required for fill_form action and must be an object');
    });

    test('should accept valid fill_form params', () => {
      const result = tool.validate!({ action: 'fill_form', fields: { '#user': 'test' } });
      expect(result.valid).toBe(true);
    });

    test('should require selector and value for select action', () => {
      const result = tool.validate!({ action: 'select' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('selector is required for select action');
      expect(result.errors).toContain('value is required for select action');
    });

    test('should accept valid select params', () => {
      const result = tool.validate!({ action: 'select', selector: '#dropdown', value: 'opt1' });
      expect(result.valid).toBe(true);
    });

    test('should require script for evaluate action', () => {
      const result = tool.validate!({ action: 'evaluate' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('script is required for evaluate action');
    });

    test('should accept valid evaluate params', () => {
      const result = tool.validate!({ action: 'evaluate', script: 'document.title' });
      expect(result.valid).toBe(true);
    });

    test('should accept screenshot action without additional params', () => {
      const result = tool.validate!({ action: 'screenshot' });
      expect(result.valid).toBe(true);
    });

    test('should accept wait action without additional params', () => {
      const result = tool.validate!({ action: 'wait' });
      expect(result.valid).toBe(true);
    });

    test('should accept close action without additional params', () => {
      const result = tool.validate!({ action: 'close' });
      expect(result.valid).toBe(true);
    });
  });

  describe('dry run', () => {
    test('should return dry run message for any action', async () => {
      const dryContext = { ...context, dryRun: true };
      const result = await tool.execute({ action: 'navigate', url: 'https://example.com' }, dryContext);
      expect(result.success).toBe(true);
      expect(result.output).toContain('[DRY RUN]');
      expect(result.output).toContain('navigate');
    });
  });

  describe('close', () => {
    test('should handle closing non-existent session', async () => {
      const result = await tool.execute({ action: 'close', session_id: 'nonexistent' }, context);
      expect(result.success).toBe(true);
      expect(result.output.message).toContain('No active session');
    });
  });

  describe('unknown action', () => {
    test('should return error for unknown action at runtime', async () => {
      // Bypass validation by passing directly to execute
      const result = await tool.execute({ action: 'unknown_action' }, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });
  });
});
