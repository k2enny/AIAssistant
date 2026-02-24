/**
 * Audit logging - tracks all tool calls, policy decisions, plugin events
 */
import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  timestamp: string;
  category: 'tool' | 'policy' | 'plugin' | 'auth' | 'system' | 'workflow';
  action: string;
  userId?: string;
  workflowId?: string;
  details: Record<string, any>;
  outcome: 'success' | 'failure' | 'blocked' | 'confirmed' | 'denied';
}

export class AuditLogger {
  private logDir: string;
  private stream: fs.WriteStream | null = null;

  constructor(baseDir?: string) {
    const dir = baseDir || path.join(process.env.HOME || '~', '.aiassistant');
    this.logDir = path.join(dir, 'logs');
  }

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    const logFile = path.join(this.logDir, 'audit.jsonl');
    this.stream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  }

  log(entry: AuditEntry): void {
    if (!this.stream) return;
    
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
    this.stream.write(line + '\n');
  }

  logToolCall(tool: string, params: Record<string, any>, outcome: AuditEntry['outcome'], userId?: string, workflowId?: string): void {
    this.log({
      timestamp: new Date().toISOString(),
      category: 'tool',
      action: `execute:${tool}`,
      userId,
      workflowId,
      details: { tool, params: this.sanitizeParams(params) },
      outcome,
    });
  }

  logPolicyDecision(rule: string, action: string, outcome: AuditEntry['outcome'], details?: Record<string, any>): void {
    this.log({
      timestamp: new Date().toISOString(),
      category: 'policy',
      action,
      details: { rule, ...details },
      outcome,
    });
  }

  logPluginEvent(plugin: string, action: string, outcome: AuditEntry['outcome'], details?: Record<string, any>): void {
    this.log({
      timestamp: new Date().toISOString(),
      category: 'plugin',
      action: `${action}:${plugin}`,
      details: { plugin, ...details },
      outcome,
    });
  }

  async close(): Promise<void> {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  private sanitizeParams(params: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'api_key', 'apikey', 'authorization'];
    
    for (const [key, value] of Object.entries(params)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
