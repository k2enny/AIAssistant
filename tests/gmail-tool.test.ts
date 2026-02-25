/**
 * Tests for GmailTool
 */
import { GmailTool } from '../src/tools/builtin/gmail';
import { ToolContext } from '../src/core/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('GmailTool', () => {
  let tool: GmailTool;
  let tmpDir: string;
  const context: ToolContext = {
    workflowId: 'test',
    userId: 'test',
    channelId: 'test',
    dryRun: false,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiassistant-gmail-test-'));
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    process.env.AIASSISTANT_HOME = tmpDir;
    tool = new GmailTool();
  });

  afterEach(() => {
    delete process.env.AIASSISTANT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('should have correct schema', () => {
    expect(tool.schema.name).toBe('gmail');
    expect(tool.schema.category).toBe('communication');
    expect(tool.schema.parameters.length).toBeGreaterThan(0);
  });

  test('should validate send action requires to, subject, body', () => {
    const result = tool.validate!({ action: 'send' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('to is required for send action');
    expect(result.errors).toContain('subject is required for send action');
    expect(result.errors).toContain('body is required for send action');
  });

  test('should validate send action with all params', () => {
    const result = tool.validate!({ action: 'send', to: 'a@b.com', subject: 'Hi', body: 'Hello' });
    expect(result.valid).toBe(true);
  });

  test('should validate read action requires message_id', () => {
    const result = tool.validate!({ action: 'read' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('message_id is required for read action');
  });

  test('should validate configure action requires credentials', () => {
    const result = tool.validate!({ action: 'configure' });
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBe(3);
  });

  test('should validate list action with no extra params', () => {
    const result = tool.validate!({ action: 'list' });
    expect(result.valid).toBe(true);
  });

  test('should validate unknown action', () => {
    const result = tool.validate!({ action: 'unknown' });
    expect(result.valid).toBe(false);
  });

  test('should handle dry run', async () => {
    const dryContext = { ...context, dryRun: true };
    const result = await tool.execute({ action: 'send', to: 'a@b.com', subject: 'Hi', body: 'Test' }, dryContext);
    expect(result.success).toBe(true);
    expect(result.output).toContain('[DRY RUN]');
  });

  test('configure should save credentials file', async () => {
    const result = await tool.execute({
      action: 'configure',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      refresh_token: 'test-refresh-token',
    }, context);

    expect(result.success).toBe(true);
    const credPath = path.join(tmpDir, 'config', 'gmail-credentials.json');
    expect(fs.existsSync(credPath)).toBe(true);

    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    expect(creds.client_id).toBe('test-client-id');
    expect(creds.client_secret).toBe('test-client-secret');
    expect(creds.refresh_token).toBe('test-refresh-token');
  });

  test('status should report not configured when no credentials', async () => {
    const result = await tool.execute({ action: 'status' }, context);
    expect(result.success).toBe(true);
    expect(result.output.configured).toBe(false);
  });

  test('status should report configured after configure', async () => {
    // First configure
    await tool.execute({
      action: 'configure',
      client_id: 'id',
      client_secret: 'secret',
      refresh_token: 'token',
    }, context);

    // Status will try to connect but will fail (no real API) - that's ok
    const result = await tool.execute({ action: 'status' }, context);
    expect(result.success).toBe(true);
    expect(result.output.configured).toBe(true);
  });

  test('send should fail when not configured', async () => {
    const result = await tool.execute({
      action: 'send',
      to: 'test@example.com',
      subject: 'Test',
      body: 'Hello',
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('list should fail when not configured', async () => {
    const result = await tool.execute({ action: 'list' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('search should fail when not configured', async () => {
    const result = await tool.execute({ action: 'search', query: 'is:unread' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('read should fail when not configured', async () => {
    const result = await tool.execute({ action: 'read', message_id: '123' }, context);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });
});
