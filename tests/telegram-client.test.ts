/**
 * Tests for TelegramClient - verifies IPC bridge behavior
 */

// Mock telegraf before importing TelegramClient
jest.mock('telegraf', () => {
  const handlers: Record<string, Function> = {};
  const commands: Record<string, Function> = {};
  return {
    Telegraf: jest.fn().mockImplementation(() => ({
      on: jest.fn((event: string, handler: Function) => { handlers[event] = handler; }),
      command: jest.fn((cmd: string, handler: Function) => { commands[cmd] = handler; }),
      launch: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn(),
      telegram: {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      },
      _handlers: handlers,
      _commands: commands,
    })),
    Context: jest.fn(),
  };
});

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

describe('TelegramClient', () => {
  let server: net.Server;
  let socketPath: string;
  let authToken: string;
  let homeDir: string;
  let receivedRequests: any[];

  beforeEach(async () => {
    homeDir = `/tmp/aiassistant-telegram-test-${Date.now()}`;
    socketPath = path.join(homeDir, 'daemon.sock');
    authToken = crypto.randomBytes(16).toString('hex');
    receivedRequests = [];

    // Create test directory and auth token file
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.auth-token'), authToken);

    // Set env vars
    process.env.AIASSISTANT_HOME = homeDir;

    // Start a mock IPC server
    await new Promise<void>((resolve) => {
      server = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            receivedRequests.push(msg);

            // Handle auth
            if (msg.method === 'auth' && msg.params?.token === authToken) {
              socket.write(JSON.stringify({ id: msg.id, result: { status: 'authenticated', clientId: 'test' } }) + '\n');
              continue;
            }

            // Handle send_message
            if (msg.method === 'send_message') {
              socket.write(JSON.stringify({ id: msg.id, result: { status: 'ok', workflowId: 'wf-1' } }) + '\n');

              // Simulate agent response after a short delay
              setTimeout(() => {
                const event = {
                  id: crypto.randomUUID(),
                  event: 'agent:response',
                  data: {
                    channelId: msg.params.channelId || 'tui',
                    userId: msg.params.userId,
                    content: 'Test response',
                  },
                };
                socket.write(JSON.stringify(event) + '\n');
              }, 50);
              continue;
            }

            // Handle status
            if (msg.method === 'status') {
              socket.write(JSON.stringify({
                id: msg.id,
                result: {
                  running: true,
                  pid: process.pid,
                  uptime: 100,
                  channels: ['tui', 'telegram'],
                  plugins: [],
                  tools: ['shell_exec', 'datetime'],
                  activeWorkflows: 0,
                },
              }) + '\n');
              continue;
            }

            // Handle list_tools
            if (msg.method === 'list_tools') {
              socket.write(JSON.stringify({
                id: msg.id,
                result: [
                  { name: 'shell_exec', description: 'Execute shell commands' },
                  { name: 'datetime', description: 'Date/time operations' },
                ],
              }) + '\n');
              continue;
            }

            // Default: unknown method
            socket.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } }) + '\n');
          }
        });
      });

      server.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (fs.existsSync(socketPath)) {
      try { fs.unlinkSync(socketPath); } catch {}
    }
    if (fs.existsSync(homeDir)) {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
    delete process.env.AIASSISTANT_HOME;
  });

  test('should connect and authenticate with daemon', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    await client.connect();

    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].method).toBe('auth');
    expect(receivedRequests[0].params.token).toBe(authToken);

    await client.disconnect();
  });

  test('should send messages to daemon with telegram channelId', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    await client.connect();

    const result = await client.request('send_message', {
      content: 'hello',
      userId: '123',
      channelId: 'telegram',
    });

    expect(result.status).toBe('ok');
    const sendReq = receivedRequests.find(r => r.method === 'send_message');
    expect(sendReq).toBeDefined();
    expect(sendReq.params.channelId).toBe('telegram');
    expect(sendReq.params.userId).toBe('123');
    expect(sendReq.params.content).toBe('hello');

    await client.disconnect();
  });

  test('should request status from daemon', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    await client.connect();

    const status = await client.request('status');
    expect(status.running).toBe(true);
    expect(status.tools).toContain('shell_exec');
    expect(status.tools).toContain('datetime');

    await client.disconnect();
  });

  test('should handle event routing for telegram channel', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    await client.connect();

    let receivedEvent: any = null;
    client.onEvent('agent:response', (data: any) => {
      if (data.channelId === 'telegram') {
        receivedEvent = data;
      }
    });

    // Send a message which triggers a simulated response
    await client.request('send_message', {
      content: 'test',
      userId: '456',
      channelId: 'telegram',
    });

    // Wait for the simulated event
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(receivedEvent).toBeDefined();
    expect(receivedEvent.channelId).toBe('telegram');
    expect(receivedEvent.userId).toBe('456');
    expect(receivedEvent.content).toBe('Test response');

    await client.disconnect();
  });

  test('should throw when connecting without daemon running', async () => {
    // Point to a non-existent socket
    const badHome = `/tmp/aiassistant-bad-${Date.now()}`;
    fs.mkdirSync(badHome, { recursive: true });
    fs.writeFileSync(path.join(badHome, '.auth-token'), 'token');
    process.env.AIASSISTANT_HOME = badHome;

    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');

    await expect(client.connect()).rejects.toThrow();

    fs.rmSync(badHome, { recursive: true, force: true });
  });

  test('isRunning returns false before start', () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    expect(client.isRunning()).toBe(false);
  });
});
