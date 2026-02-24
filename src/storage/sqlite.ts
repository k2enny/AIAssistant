/**
 * SQLite storage implementation
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { StorageInterface } from '../core/interfaces';

export class SQLiteStorage implements StorageInterface {
  private db: Database.Database | null = null;
  private dbPath: string;
  private tables: Set<string> = new Set();

  constructor(dbPath?: string) {
    const baseDir = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant');
    this.dbPath = dbPath || path.join(baseDir, 'data', 'aiassistant.db');
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    
    // Create core metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async ensureTable(table: string, schema: Record<string, string>): Promise<void> {
    if (this.tables.has(table)) return;
    this.assertDb();
    
    const safeTable = this.sanitizeIdentifier(table);
    
    const safeTable = this.sanitizeIdentifier(table);
    const safeColumns = Object.entries(schema)
      .map(([name, type]) => `${this.sanitizeIdentifier(name)} ${type}`)
      .join(', ');
    
    this.db!.exec(`CREATE TABLE IF NOT EXISTS ${safeTable} (${safeColumns})`);
    this.tables.add(table);
  }

  async get(table: string, key: string): Promise<any> {
    this.assertDb();
    const safeTable = this.sanitizeIdentifier(table);
    const row = this.db!.prepare(`SELECT * FROM ${safeTable} WHERE id = ?`).get(key) as any;
    if (row && row.data) {
      try {
        return { ...row, data: JSON.parse(row.data) };
      } catch {
        return row;
      }
    }
    return row || null;
  }

  async set(table: string, key: string, value: any): Promise<void> {
    this.assertDb();
    const safeTable = this.sanitizeIdentifier(table);
    const data = typeof value === 'object' ? JSON.stringify(value) : value;
    const now = new Date().toISOString();
    
    this.db!.prepare(`
      INSERT OR REPLACE INTO ${safeTable} (id, data, updated_at)
      VALUES (?, ?, ?)
    `).run(key, data, now);
  }

  async delete(table: string, key: string): Promise<void> {
    this.assertDb();
    const safeTable = this.sanitizeIdentifier(table);
    this.db!.prepare(`DELETE FROM ${safeTable} WHERE id = ?`).run(key);
  }

  async query(table: string, filter?: Record<string, any>): Promise<any[]> {
    this.assertDb();
    const safeTable = this.sanitizeIdentifier(table);
    
    if (!filter || Object.keys(filter).length === 0) {
      const rows = this.db!.prepare(`SELECT * FROM ${safeTable}`).all() as any[];
      return rows.map(row => {
        if (row.data) {
          try { row.data = JSON.parse(row.data); } catch {}
        }
        return row;
      });
    }
    
    const conditions = Object.keys(filter).map(k => `${this.sanitizeIdentifier(k)} = ?`).join(' AND ');
    const values = Object.values(filter);
    
    const rows = this.db!.prepare(`SELECT * FROM ${safeTable} WHERE ${conditions}`).all(...values) as any[];
    return rows.map(row => {
      if (row.data) {
        try { row.data = JSON.parse(row.data); } catch {}
      }
      return row;
    });
  }

  // Direct SQL execution for advanced queries
  exec(sql: string, params?: any[]): any {
    this.assertDb();
    if (params) {
      return this.db!.prepare(sql).run(...params);
    }
    return this.db!.exec(sql);
  }

  queryRaw(sql: string, params?: any[]): any[] {
    this.assertDb();
    if (params) {
      return this.db!.prepare(sql).all(...params) as any[];
    }
    return this.db!.prepare(sql).all() as any[];
  }

  private assertDb(): void {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
  }

  private sanitizeIdentifier(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid identifier: ${name}`);
    }
    return name;
  }
}
