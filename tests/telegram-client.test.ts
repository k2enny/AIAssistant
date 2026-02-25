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
        getMe: jest.fn().mockResolvedValue({ id: 123456, username: 'test_bot', first_name: 'TestBot', is_bot: true }),
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

  test('testConnection should validate token and daemon connectivity', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');

    const result = await client.testConnection();

    expect(result.token).toBe(true);
    expect(result.bot).toBeDefined();
    expect(result.bot.id).toBe(123456);
    expect(result.bot.username).toBe('test_bot');
    expect(result.bot.firstName).toBe('TestBot');
    expect(result.daemon).toBe(true);
  });

  test('should register command handlers before text handler', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    await client.start();

    // Access the mock bot via the Telegraf constructor
    const { Telegraf } = require('telegraf');
    const botInstance = Telegraf.mock.results[Telegraf.mock.results.length - 1].value;

    // command() should have been called before on('text')
    const commandCalls = botInstance.command.mock.invocationCallOrder;
    const onCalls = botInstance.on.mock.invocationCallOrder;

    // All command registrations should come before the text handler registration
    const lastCommandOrder = Math.max(...commandCalls);
    const firstOnOrder = Math.min(...onCalls);
    expect(lastCommandOrder).toBeLessThan(firstOnOrder);

    await client.stop();
  });

  test('should invoke command handler directly for /start', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    await client.start();

    const { Telegraf } = require('telegraf');
    const botInstance = Telegraf.mock.results[Telegraf.mock.results.length - 1].value;

    // Invoke the /start command handler
    const replyMock = jest.fn().mockResolvedValue(undefined);
    const ctx = { reply: replyMock };
    const startHandler = botInstance._commands['start'];
    expect(startHandler).toBeDefined();
    await startHandler(ctx);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0][0]).toContain('AIAssistant is ready');

    await client.stop();
  });

  test('should send text messages to daemon via IPC and receive response', async () => {
    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');
    await client.start();

    const { Telegraf } = require('telegraf');
    const botInstance = Telegraf.mock.results[Telegraf.mock.results.length - 1].value;

    // Simulate a text message arriving via the bot
    const textHandler = botInstance._handlers['text'];
    expect(textHandler).toBeDefined();

    const mockCtx = {
      message: {
        text: 'hello world',
        from: { id: 789, username: 'testuser', first_name: 'Test' },
        chat: { id: 101112 },
      },
    };

    await textHandler(mockCtx);

    // Verify the message was sent to daemon
    const sendReq = receivedRequests.find(r => r.method === 'send_message');
    expect(sendReq).toBeDefined();
    expect(sendReq.params.content).toBe('hello world');
    expect(sendReq.params.userId).toBe('789');
    expect(sendReq.params.channelId).toBe('telegram');

    // Wait for the agent:response event to be processed
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify response was sent back to Telegram
    expect(botInstance.telegram.sendMessage).toHaveBeenCalledWith(
      101112,
      'Test response'
    );

    await client.stop();
  });

  test('testConnection should report daemon error when daemon is unreachable', async () => {
    // Point to a non-existent socket
    const badHome = `/tmp/aiassistant-test-conn-${Date.now()}`;
    fs.mkdirSync(badHome, { recursive: true });
    fs.writeFileSync(path.join(badHome, '.auth-token'), 'token');
    process.env.AIASSISTANT_HOME = badHome;

    const { TelegramClient } = require('../src/channels/telegram/client');
    const client = new TelegramClient('fake-token');

    const result = await client.testConnection();

    expect(result.token).toBe(true);
    expect(result.bot).toBeDefined();
    expect(result.daemon).toBe(false);
    expect(result.error).toContain('Daemon connection error');

    // Restore env for other tests
    process.env.AIASSISTANT_HOME = homeDir;
    fs.rmSync(badHome, { recursive: true, force: true });
  });
});
