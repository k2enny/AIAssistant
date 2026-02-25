/**
 * Playwright web automation tool - browse, interact with, and extract data from websites
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as os from 'os';
import * as path from 'path';

export class PlaywrightTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'web_browse',
    description:
      'Automate web browsing: navigate pages, fill forms, click elements, take screenshots, and extract content using Playwright',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description:
          'Action to perform: "navigate", "click", "type", "screenshot", "get_text", "fill_form", "select", "wait", "evaluate", "close"',
        required: true,
      },
      { name: 'url', type: 'string', description: 'URL to navigate to (for "navigate" action)', required: false },
      {
        name: 'selector',
        type: 'string',
        description: 'CSS or text selector for the target element (for "click", "type", "get_text", "select", "wait" actions)',
        required: false,
      },
      { name: 'text', type: 'string', description: 'Text to type (for "type" action)', required: false },
      {
        name: 'fields',
        type: 'object',
        description:
          'Key-value pairs of selector to value for filling forms (for "fill_form" action). Example: {"#username": "user", "#password": "pass"}',
        required: false,
      },
      { name: 'value', type: 'string', description: 'Value to select (for "select" action)', required: false },
      {
        name: 'script',
        type: 'string',
        description: 'JavaScript code to evaluate in the browser (for "evaluate" action)',
        required: false,
      },
      {
        name: 'timeout',
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
        required: false,
        default: 30000,
      },
      {
        name: 'headless',
        type: 'boolean',
        description: 'Run browser in headless mode (default: true)',
        required: false,
        default: true,
      },
      {
        name: 'session_id',
        type: 'string',
        description: 'Session identifier to reuse an existing browser session',
        required: false,
      },
    ],
    returns: 'Action result (text content, screenshot path, page info, etc.)',
    category: 'web',
    permissions: ['web.browse'],
  };

  private sessions: Map<string, { browser: Browser; context: BrowserContext; page: Page }> = new Map();

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const validActions = ['navigate', 'click', 'type', 'screenshot', 'get_text', 'fill_form', 'select', 'wait', 'evaluate', 'close'];

    if (!params.action || typeof params.action !== 'string') {
      errors.push('action is required and must be a string');
    } else if (!validActions.includes(params.action)) {
      errors.push(`action must be one of: ${validActions.join(', ')}`);
    }

    if (params.action === 'navigate' && (!params.url || typeof params.url !== 'string')) {
      errors.push('url is required for navigate action');
    }

    if (params.action === 'click' && (!params.selector || typeof params.selector !== 'string')) {
      errors.push('selector is required for click action');
    }

    if (params.action === 'type') {
      if (!params.selector || typeof params.selector !== 'string') {
        errors.push('selector is required for type action');
      }
      if (!params.text || typeof params.text !== 'string') {
        errors.push('text is required for type action');
      }
    }

    if (params.action === 'fill_form' && (!params.fields || typeof params.fields !== 'object')) {
      errors.push('fields is required for fill_form action and must be an object');
    }

    if (params.action === 'select') {
      if (!params.selector || typeof params.selector !== 'string') {
        errors.push('selector is required for select action');
      }
      if (!params.value || typeof params.value !== 'string') {
        errors.push('value is required for select action');
      }
    }

    if (params.action === 'evaluate' && (!params.script || typeof params.script !== 'string')) {
      errors.push('script is required for evaluate action');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (context.dryRun) {
      return { success: true, output: `[DRY RUN] Would perform web_browse action: ${params.action}` };
    }

    try {
      switch (params.action) {
        case 'navigate':
          return await this.navigate(params);
        case 'click':
          return await this.click(params);
        case 'type':
          return await this.typeText(params);
        case 'screenshot':
          return await this.screenshot(params);
        case 'get_text':
          return await this.getText(params);
        case 'fill_form':
          return await this.fillForm(params);
        case 'select':
          return await this.selectOption(params);
        case 'wait':
          return await this.waitFor(params);
        case 'evaluate':
          return await this.evaluate(params);
        case 'close':
          return await this.closeSession(params);
        default:
          return { success: false, output: null, error: `Unknown action: ${params.action}` };
      }
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }

  private async getOrCreateSession(
    params: Record<string, any>
  ): Promise<{ browser: Browser; context: BrowserContext; page: Page; sessionId: string }> {
    const sessionId = params.session_id || 'default';
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { ...existing, sessionId };
    }

    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: params.headless !== false,
      });
    } catch (err: any) {
      throw new Error(this.diagnoseBrowserLaunchError(err));
    }
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    page.setDefaultTimeout(params.timeout || 30000);
    this.sessions.set(sessionId, { browser, context: browserContext, page });
    return { browser, context: browserContext, page, sessionId };
  }

  /**
   * Inspect a browser launch error and return a user-friendly message
   * with actionable fix instructions.
   */
  private diagnoseBrowserLaunchError(err: any): string {
    const msg: string = (err.message || '').toLowerCase();

    // Playwright browsers not installed
    if (msg.includes('executable doesn\'t exist') || msg.includes('executable doesn\u2019t exist') || msg.includes('no usable browser')) {
      return (
        'Playwright browser is not installed. Run the following command to install it:\n' +
        '  npx playwright install chromium\n\n' +
        'Then, if on Linux, install required system dependencies with:\n' +
        '  npx playwright install-deps chromium\n' +
        '  (or: sudo bash scripts/setup-linux.sh)'
      );
    }

    // Missing system libraries (host dependency issue)
    if ((msg.includes('missing') && msg.includes('librar')) ||
        msg.includes('shared object') ||
        msg.includes('error while loading') ||
        msg.includes('cannot open shared object') ||
        msg.includes('host system is missing dependencies')) {
      return (
        'Browser installed but system libraries are missing. ' +
        'Install the required dependencies:\n' +
        '  npx playwright install-deps chromium\n' +
        '  (or: sudo bash scripts/setup-linux.sh)\n\n' +
        'Original error: ' + err.message
      );
    }

    // Fallback: include generic setup guidance alongside original error
    return (
      'Failed to launch browser: ' + err.message + '\n\n' +
      'Troubleshooting:\n' +
      '  1. Install browser:      npx playwright install chromium\n' +
      '  2. Install system deps:  npx playwright install-deps chromium\n' +
      '  3. Or run setup script:  sudo bash scripts/setup-linux.sh'
    );
  }

  private async navigate(params: Record<string, any>): Promise<ToolResult> {
    const { page, sessionId } = await this.getOrCreateSession(params);
    const response = await page.goto(params.url, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    return {
      success: true,
      output: {
        url: page.url(),
        title,
        status: response?.status(),
        session_id: sessionId,
      },
    };
  }

  private async click(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    await page.click(params.selector, { timeout: params.timeout || 30000 });
    return {
      success: true,
      output: { clicked: params.selector, url: page.url(), title: await page.title() },
    };
  }

  private async typeText(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    await page.fill(params.selector, params.text, { timeout: params.timeout || 30000 });
    return {
      success: true,
      output: { typed: params.text, selector: params.selector },
    };
  }

  private async screenshot(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    const timestamp = Date.now();
    const screenshotPath = params.path || path.join(os.tmpdir(), `screenshot-${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: params.fullPage || false });
    return {
      success: true,
      output: { path: screenshotPath, url: page.url(), title: await page.title() },
    };
  }

  private async getText(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    let text: string;
    if (params.selector) {
      text = await page.textContent(params.selector, { timeout: params.timeout || 30000 }) || '';
    } else {
      text = await page.textContent('body') || '';
    }
    return {
      success: true,
      output: { text: text.trim(), url: page.url(), title: await page.title() },
    };
  }

  private async fillForm(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    const fields = params.fields as Record<string, string>;
    const filled: string[] = [];

    for (const [selector, value] of Object.entries(fields)) {
      await page.fill(selector, value, { timeout: params.timeout || 30000 });
      filled.push(selector);
    }

    return {
      success: true,
      output: { filled_fields: filled, url: page.url() },
    };
  }

  private async selectOption(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    const selected = await page.selectOption(params.selector, params.value, { timeout: params.timeout || 30000 });
    return {
      success: true,
      output: { selector: params.selector, selected },
    };
  }

  private async waitFor(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    if (params.selector) {
      await page.waitForSelector(params.selector, { timeout: params.timeout || 30000 });
      return { success: true, output: { waited_for: params.selector, found: true } };
    }
    // Wait for a fixed duration
    const ms = params.timeout || 1000;
    await page.waitForTimeout(ms);
    return { success: true, output: { waited_ms: ms } };
  }

  private async evaluate(params: Record<string, any>): Promise<ToolResult> {
    const { page } = await this.getOrCreateSession(params);
    const result = await page.evaluate(params.script);
    return {
      success: true,
      output: { result },
    };
  }

  private async closeSession(params: Record<string, any>): Promise<ToolResult> {
    const sessionId = params.session_id || 'default';
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: true, output: { message: 'No active session to close' } };
    }

    await session.page.close();
    await session.context.close();
    await session.browser.close();
    this.sessions.delete(sessionId);
    return { success: true, output: { message: `Session "${sessionId}" closed` } };
  }

  /**
   * Clean up all browser sessions
   */
  async cleanup(): Promise<void> {
    for (const [id, session] of this.sessions.entries()) {
      try {
        await session.page.close();
        await session.context.close();
        await session.browser.close();
      } catch {
        // Ignore errors during cleanup
      }
      this.sessions.delete(id);
    }
  }
}
