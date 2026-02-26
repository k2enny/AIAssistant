/**
 * IPC Server - Unix domain socket JSON-RPC server
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IPCRequest, IPCResponse, IPCStreamEvent, EventBusInterface } from '../core/interfaces';
import { Events } from '../core/event-bus';

export class IPCServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private authToken: string;
  private clients: Map<string, net.Socket> = new Map();
  private handlers: Map<string, (params: any, clientId: string) => Promise<any>> = new Map();
  private eventBus: EventBusInterface;
  private authAttempts: Map<string, { count: number; lastAttempt: number }> = new Map();
  private readonly maxAuthAttempts = 5;
  private readonly authWindowMs = 60000;

  constructor(eventBus: EventBusInterface, socketPath?: string) {
    const homeDir = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '~', '.aiassistant');

    if (socketPath) {
      this.socketPath = socketPath;
    } else if (process.platform === 'win32') {
      this.socketPath = '\\\\.\\pipe\\aiassistant-daemon';
    } else {
      this.socketPath = path.join(homeDir, 'daemon.sock');
    }

    this.authToken = this.loadOrCreateToken(homeDir);
    this.eventBus = eventBus;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  getAuthToken(): string {
    return this.authToken;
  }

  registerHandler(method: string, handler: (params: any, clientId: string) => Promise<any>): void {
    this.handlers.set(method, handler);
  }

  async start(): Promise<void> {
    // Clean up stale socket (only for Unix sockets)
    if (!this.socketPath.startsWith('\\\\.\\pipe\\')) {
      if (fs.existsSync(this.socketPath)) {
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          // Ignore
        }
      }

      const dir = path.dirname(this.socketPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && this.socketPath.startsWith('\\\\.\\pipe\\')) {
          // On Windows, named pipes can linger in WAIT state.
          // Since we can't unlink them, wait and retry binding a few times.
          console.warn(`Pipe ${this.socketPath} in use, retrying in 1s...`);
          setTimeout(() => {
            this.server?.listen(this.socketPath, () => {
              if (!this.socketPath.startsWith('\\\\.\\pipe\\')) fs.chmodSync(this.socketPath, 0o600);
              resolve();
            });
          }, 1000);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.socketPath, () => {
        if (!this.socketPath.startsWith('\\\\.\\pipe\\')) {
          fs.chmodSync(this.socketPath, 0o600);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all client connections
    for (const [id, socket] of this.clients) {
      socket.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          if (fs.existsSync(this.socketPath)) {
            try { fs.unlinkSync(this.socketPath); } catch { }
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  broadcast(event: string, data: any): void {
    const streamEvent: IPCStreamEvent = {
      id: crypto.randomUUID(),
      event,
      data,
    };
    const msg = JSON.stringify(streamEvent) + '\n';
    for (const [, socket] of this.clients) {
      if (!socket.destroyed) {
        socket.write(msg);
      }
    }
  }

  private handleConnection(socket: net.Socket): void {
    const clientId = crypto.randomUUID();
    let authenticated = false;
    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const request: IPCRequest & { auth?: string } = JSON.parse(line);

          // First message must authenticate
          if (!authenticated) {
            // Rate limit auth attempts
            const remoteAddr = socket.remoteAddress || clientId;
            const attempts = this.authAttempts.get(remoteAddr);
            const now = Date.now();
            if (attempts && attempts.count >= this.maxAuthAttempts && (now - attempts.lastAttempt) < this.authWindowMs) {
              this.sendResponse(socket, {
                id: request.id || 'unknown',
                error: { code: 429, message: 'Too many authentication attempts' },
              });
              socket.destroy();
              return;
            }

            if (request.method === 'auth' && request.params?.token === this.authToken) {
              authenticated = true;
              this.clients.set(clientId, socket);
              this.authAttempts.delete(remoteAddr);
              this.sendResponse(socket, { id: request.id, result: { status: 'authenticated', clientId } });
              continue;
            } else {
              const current = this.authAttempts.get(remoteAddr) || { count: 0, lastAttempt: now };
              this.authAttempts.set(remoteAddr, { count: current.count + 1, lastAttempt: now });
              this.sendResponse(socket, {
                id: request.id || 'unknown',
                error: { code: 401, message: 'Authentication required' },
              });
              socket.destroy();
              return;
            }
          }

          await this.handleRequest(request, socket, clientId);
        } catch (err: any) {
          this.sendResponse(socket, {
            id: 'parse-error',
            error: { code: -32700, message: 'Parse error: ' + err.message },
          });
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
    });

    socket.on('error', () => {
      this.clients.delete(clientId);
    });
  }

  private async handleRequest(request: IPCRequest, socket: net.Socket, clientId: string): Promise<void> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.sendResponse(socket, {
        id: request.id,
        error: { code: -32601, message: `Unknown method: ${request.method}` },
      });
      return;
    }

    try {
      const result = await handler(request.params, clientId);
      this.sendResponse(socket, { id: request.id, result });
    } catch (err: any) {
      this.sendResponse(socket, {
        id: request.id,
        error: { code: -32000, message: err.message },
      });
    }
  }

  private sendResponse(socket: net.Socket, response: IPCResponse): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }

  private loadOrCreateToken(homeDir: string): string {
    const tokenPath = path.join(homeDir, '.auth-token');
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, 'utf-8').trim();
    }
    const token = crypto.randomBytes(32).toString('hex');
    if (!fs.existsSync(homeDir)) {
      fs.mkdirSync(homeDir, { recursive: true });
    }
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    return token;
  }
}
