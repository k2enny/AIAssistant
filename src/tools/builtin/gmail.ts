/**
 * Gmail tool - send and receive emails via Google Gmail API
 *
 * Supports OAuth2 authentication.  The assistant can guide the user through
 * configuring Gmail credentials via the setup wizard or interactively.
 *
 * Actions:
 *   send       - Send an email
 *   read       - Read a specific email by ID
 *   list       - List recent emails (inbox)
 *   search     - Search emails by query
 *   configure  - Store Gmail OAuth2 credentials (client_id, client_secret, refresh_token)
 *   status     - Check whether Gmail is configured and accessible
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

interface GmailCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export class GmailTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'gmail',
    description:
      'Send and receive emails via Gmail. Supports sending, reading, listing, searching emails and configuring Gmail OAuth2 credentials.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description:
          'Action to perform: "send", "read", "list", "search", "configure", "status"',
        required: true,
      },
      {
        name: 'to',
        type: 'string',
        description: 'Recipient email address (for "send")',
        required: false,
      },
      {
        name: 'subject',
        type: 'string',
        description: 'Email subject (for "send")',
        required: false,
      },
      {
        name: 'body',
        type: 'string',
        description: 'Email body text (for "send")',
        required: false,
      },
      {
        name: 'message_id',
        type: 'string',
        description: 'Gmail message ID (for "read")',
        required: false,
      },
      {
        name: 'query',
        type: 'string',
        description: 'Search query (for "search"), e.g. "is:unread from:boss@example.com"',
        required: false,
      },
      {
        name: 'max_results',
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
        required: false,
        default: 10,
      },
      {
        name: 'client_id',
        type: 'string',
        description: 'Google OAuth2 client ID (for "configure")',
        required: false,
      },
      {
        name: 'client_secret',
        type: 'string',
        description: 'Google OAuth2 client secret (for "configure")',
        required: false,
      },
      {
        name: 'refresh_token',
        type: 'string',
        description: 'Google OAuth2 refresh token (for "configure")',
        required: false,
      },
    ],
    returns: 'Email data or operation result',
    category: 'communication',
    permissions: ['gmail.read', 'gmail.send'],
  };

  private homeDir: string;

  constructor() {
    this.homeDir =
      process.env.AIASSISTANT_HOME ||
      path.join(process.env.HOME || '~', '.aiassistant');
  }

  validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const validActions = ['send', 'read', 'list', 'search', 'configure', 'status'];

    if (!params.action || typeof params.action !== 'string') {
      errors.push('action is required and must be a string');
    } else if (!validActions.includes(params.action)) {
      errors.push(`action must be one of: ${validActions.join(', ')}`);
    }

    if (params.action === 'send') {
      if (!params.to) errors.push('to is required for send action');
      if (!params.subject) errors.push('subject is required for send action');
      if (!params.body) errors.push('body is required for send action');
    }

    if (params.action === 'read' && !params.message_id) {
      errors.push('message_id is required for read action');
    }

    if (params.action === 'configure') {
      if (!params.client_id) errors.push('client_id is required for configure action');
      if (!params.client_secret) errors.push('client_secret is required for configure action');
      if (!params.refresh_token) errors.push('refresh_token is required for configure action');
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (context.dryRun) {
      return { success: true, output: `[DRY RUN] Would perform gmail action: ${params.action}` };
    }

    try {
      switch (params.action) {
        case 'configure':
          return this.configure(params);
        case 'status':
          return await this.status();
        case 'send':
          return await this.send(params);
        case 'read':
          return await this.readMessage(params);
        case 'list':
          return await this.listMessages(params);
        case 'search':
          return await this.searchMessages(params);
        default:
          return { success: false, output: null, error: `Unknown action: ${params.action}` };
      }
    } catch (err: any) {
      return { success: false, output: null, error: err.message };
    }
  }

  // ------------------------------------------------------------------
  // Credentials helpers
  // ------------------------------------------------------------------

  private getCredentialsPath(): string {
    return path.join(this.homeDir, 'config', 'gmail-credentials.json');
  }

  private loadCredentials(): GmailCredentials | null {
    const credPath = this.getCredentialsPath();
    if (!fs.existsSync(credPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  private saveCredentials(creds: GmailCredentials): void {
    const configDir = path.join(this.homeDir, 'config');
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(this.getCredentialsPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  private async getAccessToken(): Promise<string> {
    const creds = this.loadCredentials();
    if (!creds) {
      throw new Error(
        'Gmail is not configured. Use the gmail tool with action "configure" to set up OAuth2 credentials, or run the setup wizard.'
      );
    }

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to refresh Gmail access token: ${text}`);
    }

    const data = (await resp.json()) as any;
    return data.access_token;
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  private configure(params: Record<string, any>): ToolResult {
    this.saveCredentials({
      client_id: params.client_id,
      client_secret: params.client_secret,
      refresh_token: params.refresh_token,
    });
    return {
      success: true,
      output: {
        message: 'Gmail OAuth2 credentials saved successfully. You can now use send, read, list, and search actions.',
      },
    };
  }

  private async status(): Promise<ToolResult> {
    const creds = this.loadCredentials();
    if (!creds) {
      return {
        success: true,
        output: {
          configured: false,
          message:
            'Gmail is not configured. To set up, use the gmail tool with action "configure" providing client_id, client_secret, and refresh_token. You can obtain these by creating a Google Cloud project, enabling the Gmail API, and generating OAuth2 credentials.',
        },
      };
    }

    try {
      const token = await this.getAccessToken();
      const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`API error: ${resp.status}`);
      const profile = (await resp.json()) as any;
      return {
        success: true,
        output: {
          configured: true,
          email: profile.emailAddress,
          messagesTotal: profile.messagesTotal,
          threadsTotal: profile.threadsTotal,
        },
      };
    } catch (err: any) {
      return {
        success: true,
        output: {
          configured: true,
          error: `Credentials saved but connection failed: ${err.message}`,
        },
      };
    }
  }

  private async send(params: Record<string, any>): Promise<ToolResult> {
    const token = await this.getAccessToken();

    const raw = this.createRawEmail(params.to, params.subject, params.body);
    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to send email: ${text}`);
    }

    const data = (await resp.json()) as any;
    return {
      success: true,
      output: { message: 'Email sent successfully', messageId: data.id, threadId: data.threadId },
    };
  }

  private async readMessage(params: Record<string, any>): Promise<ToolResult> {
    const token = await this.getAccessToken();

    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${params.message_id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to read email: ${text}`);
    }

    const data = (await resp.json()) as any;
    return {
      success: true,
      output: this.parseMessage(data),
    };
  }

  private async listMessages(params: Record<string, any>): Promise<ToolResult> {
    const token = await this.getAccessToken();
    const maxResults = params.max_results || 10;

    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to list emails: ${text}`);
    }

    const data = (await resp.json()) as any;
    const messages = data.messages || [];

    // Fetch summaries for each message
    const summaries = await Promise.all(
      messages.slice(0, maxResults).map(async (m: any) => {
        try {
          const msgResp = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!msgResp.ok) return { id: m.id, error: 'Failed to fetch' };
          const msgData = (await msgResp.json()) as any;
          return this.parseMessageSummary(msgData);
        } catch {
          return { id: m.id, error: 'Failed to fetch' };
        }
      })
    );

    return {
      success: true,
      output: { count: messages.length, messages: summaries },
    };
  }

  private async searchMessages(params: Record<string, any>): Promise<ToolResult> {
    const token = await this.getAccessToken();
    const maxResults = params.max_results || 10;
    const query = encodeURIComponent(params.query || '');

    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=${maxResults}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to search emails: ${text}`);
    }

    const data = (await resp.json()) as any;
    const messages = data.messages || [];

    const summaries = await Promise.all(
      messages.slice(0, maxResults).map(async (m: any) => {
        try {
          const msgResp = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!msgResp.ok) return { id: m.id, error: 'Failed to fetch' };
          const msgData = (await msgResp.json()) as any;
          return this.parseMessageSummary(msgData);
        } catch {
          return { id: m.id, error: 'Failed to fetch' };
        }
      })
    );

    return {
      success: true,
      output: { query: params.query, count: messages.length, messages: summaries },
    };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private createRawEmail(to: string, subject: string, body: string): string {
    const email = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');

    return Buffer.from(email).toString('base64url');
  }

  private parseMessage(data: any): any {
    const headers = data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    let bodyText = '';
    if (data.payload?.body?.data) {
      bodyText = Buffer.from(data.payload.body.data, 'base64url').toString('utf-8');
    } else if (data.payload?.parts) {
      const textPart = data.payload.parts.find((p: any) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        bodyText = Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
      }
    }

    return {
      id: data.id,
      threadId: data.threadId,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: data.snippet,
      body: bodyText,
      labels: data.labelIds,
    };
  }

  private parseMessageSummary(data: any): any {
    const headers = data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    return {
      id: data.id,
      threadId: data.threadId,
      from: getHeader('From'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: data.snippet,
      labels: data.labelIds,
    };
  }
}
