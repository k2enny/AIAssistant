/**
 * Memory manager - workflow-scoped memory with summarization
 */
import * as crypto from 'crypto';
import {
  WorkflowMemory,
  MemoryContext,
  MemoryMessage,
  StorageInterface,
} from '../core/interfaces';

const MEMORY_TABLE = 'memory_messages';
const SUMMARY_TABLE = 'memory_summaries';

export class MemoryManager {
  private storage: StorageInterface;
  private maxContextMessages: number;

  constructor(storage: StorageInterface, maxContextMessages = 50) {
    this.storage = storage;
    this.maxContextMessages = maxContextMessages;
  }

  async initialize(): Promise<void> {
    await this.storage.ensureTable(MEMORY_TABLE, {
      id: 'TEXT PRIMARY KEY',
      data: 'TEXT NOT NULL',
      updated_at: 'TEXT',
    });
    await this.storage.ensureTable(SUMMARY_TABLE, {
      id: 'TEXT PRIMARY KEY',
      data: 'TEXT NOT NULL',
      updated_at: 'TEXT',
    });
  }

  createMemory(workflowId: string): WorkflowMemory {
    return new WorkflowMemoryImpl(workflowId, this.storage, this.maxContextMessages);
  }

  async clearWorkflow(workflowId: string): Promise<void> {
    const messages = await this.storage.query(MEMORY_TABLE);
    for (const msg of messages) {
      const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
      if (data.workflowId === workflowId) {
        await this.storage.delete(MEMORY_TABLE, msg.id);
      }
    }
    await this.storage.delete(SUMMARY_TABLE, workflowId);
  }

  async clearAll(): Promise<void> {
    // Clear all messages and summaries
    const messages = await this.storage.query(MEMORY_TABLE);
    for (const msg of messages) {
      await this.storage.delete(MEMORY_TABLE, msg.id);
    }
    const summaries = await this.storage.query(SUMMARY_TABLE);
    for (const sum of summaries) {
      await this.storage.delete(SUMMARY_TABLE, sum.id);
    }
  }
}

class WorkflowMemoryImpl implements WorkflowMemory {
  workflowId: string;
  private storage: StorageInterface;
  private maxMessages: number;
  private messageCache: MemoryMessage[] = [];
  private loaded = false;

  constructor(workflowId: string, storage: StorageInterface, maxMessages: number) {
    this.workflowId = workflowId;
    this.storage = storage;
    this.maxMessages = maxMessages;
  }

  async getContext(): Promise<MemoryContext> {
    await this.ensureLoaded();
    
    const summary = await this.getSummary();
    const messages = this.messageCache.slice(-this.maxMessages);
    
    return {
      messages,
      summary: summary || undefined,
    };
  }

  async addMessage(
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    const message: MemoryMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: new Date(),
      metadata,
    };
    
    this.messageCache.push(message);
    
    await this.storage.set(MEMORY_TABLE, message.id, {
      ...message,
      workflowId: this.workflowId,
      timestamp: message.timestamp.toISOString(),
    });
  }

  async getSummary(): Promise<string> {
    const entry = await this.storage.get(SUMMARY_TABLE, this.workflowId);
    if (entry?.data) {
      const data = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
      return data.summary || '';
    }
    return '';
  }

  async setSummary(summary: string): Promise<void> {
    await this.storage.set(SUMMARY_TABLE, this.workflowId, { summary });
  }

  async clear(): Promise<void> {
    for (const msg of this.messageCache) {
      await this.storage.delete(MEMORY_TABLE, msg.id);
    }
    this.messageCache = [];
    await this.storage.delete(SUMMARY_TABLE, this.workflowId);
  }

  async fork(newWorkflowId: string): Promise<WorkflowMemory> {
    const newMemory = new WorkflowMemoryImpl(newWorkflowId, this.storage, this.maxMessages);
    
    // Copy messages
    for (const msg of this.messageCache) {
      await newMemory.addMessage(msg.role, msg.content, msg.metadata);
    }
    
    return newMemory;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    
    try {
      const allMessages = await this.storage.query(MEMORY_TABLE);
      this.messageCache = allMessages
        .map(row => {
          const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          return data;
        })
        .filter(msg => msg.workflowId === this.workflowId)
        .map(msg => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
          metadata: msg.metadata,
        }))
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch {
      this.messageCache = [];
    }
    
    this.loaded = true;
  }
}
