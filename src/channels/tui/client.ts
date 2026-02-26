/**
 * TUI Client - connects to daemon via IPC
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { IPCRequest, IPCResponse, IPCStreamEvent } from '../../core/interfaces';

export class TUIClient {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private authToken: string;
  private authenticated = false;
  private pendingRequests: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }> = new Map();
  private eventHandlers: Map<string, Array<(data: any) => void>> = new Map();
  private rl: readline.Interface | null = null;
  private buffer = '';
  private requestCounter = 0;
  private activeRequest = false;

  constructor() {
    const homeDir = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant');
    this.socketPath = path.join(homeDir, 'daemon.sock');
    
    const tokenPath = path.join(homeDir, '.auth-token');
    this.authToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf-8').trim() : '';
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(this.socketPath)) {
      throw new Error('Daemon is not running. Start it with: ./aiassistant start');
    }

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath, () => {
        // Authenticate
        this.sendRaw({
          id: 'auth-0',
          method: 'auth',
          params: { token: this.authToken },
        });
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleMessage(msg);

            // Resolve auth
            if (msg.id === 'auth-0' && msg.result?.status === 'authenticated') {
              this.authenticated = true;
              resolve();
            } else if (msg.id === 'auth-0' && msg.error) {
              reject(new Error(msg.error.message));
            }
          } catch {
            // Ignore parse errors
          }
        }
      });

      this.socket.on('error', (err) => {
        if (!this.authenticated) {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.authenticated = false;
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.authenticated = false;
  }

  async request(method: string, params?: any): Promise<any> {
    if (!this.authenticated) {
      throw new Error('Not connected to daemon');
    }

    const id = `req-${++this.requestCounter}`;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.sendRaw({ id, method, params });
    });
  }

  onEvent(event: string, handler: (data: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  async startInteractive(): Promise<void> {
    console.log('\n🤖 AIAssistant TUI');
    console.log('─'.repeat(50));
    console.log('Type a message to chat. Commands:');
    console.log('  quit       - Exit TUI (daemon keeps running)');
    console.log('  /status    - Show daemon status');
    console.log('  /tools     - List available tools');
    console.log('  /workflows - List active workflows');
    console.log('  /policy    - List policy rules');
    console.log('  /plugins   - List loaded plugins');
    console.log('  /new       - Start new conversation');
    console.log('  /help      - Show this help');
    console.log('─'.repeat(50));

    // Listen for agent responses.
    // Proactive messages (from the send_message tool, subagents, etc.)
    // are displayed here.  Responses to the user's own messages are
    // displayed via the IPC result in handleInput, so we skip
    // non-proactive events while a request is in flight to avoid
    // duplicate output.
    this.onEvent('agent:response', (data) => {
      if (!data.proactive && this.activeRequest) return;
      console.log(`\n🤖 Assistant: ${data.content}\n`);
      process.stdout.write('You: ');
    });

    this.onEvent('agent:error', (data) => {
      if (!data.proactive && this.activeRequest) return;
      console.log(`\n❌ Error: ${data.error}\n`);
      process.stdout.write('You: ');
    });

    this.onEvent('tool:executing', (data) => {
      console.log(`\n⚙️  Executing tool: ${data.tool}`);
    });

    this.onEvent('tool:completed', (data) => {
      console.log(`✅ Tool completed: ${data.tool}`);
    });

    this.onEvent('policy:decision', (data) => {
      if (data.decision && !data.decision.allowed) {
        console.log(`\n🛡️  Policy: ${data.decision.reason}`);
      }
    });

    this.onEvent('confirmation:required', (data) => {
      console.log(`\n⚠️  Confirmation required: ${data.reason}`);
      console.log(`   Tool: ${data.tool}`);
    });

    this.onEvent('plugin:loaded', (data) => {
      console.log(`\n📦 Plugin loaded: ${data.name}`);
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'You: ',
    });

    this.rl.prompt();

    return new Promise((resolve) => {
      this.rl!.on('line', async (line) => {
        const input = line.trim();
        if (!input) {
          this.rl!.prompt();
          return;
        }

        if (input.toLowerCase() === 'quit' || input.toLowerCase() === 'exit') {
          console.log('\n👋 Exiting TUI. Daemon continues running.');
          this.rl!.close();
          resolve();
          return;
        }

        try {
          await this.handleInput(input);
        } catch (err: any) {
          console.log(`\n❌ Error: ${err.message}`);
        }

        this.rl!.prompt();
      });

      this.rl!.on('close', () => {
        resolve();
      });
    });
  }

  private async handleInput(input: string): Promise<void> {
    switch (input.toLowerCase()) {
      case '/status': {
        const status = await this.request('status');
        console.log('\n📊 Daemon Status:');
        console.log(`  Running: ${status.running}`);
        console.log(`  PID: ${status.pid}`);
        console.log(`  Uptime: ${Math.floor(status.uptime)}s`);
        console.log(`  Channels: ${status.channels.join(', ') || 'none'}`);
        console.log(`  Plugins: ${status.plugins.join(', ') || 'none'}`);
        console.log(`  Tools: ${status.tools.join(', ')}`);
        console.log(`  Active Workflows: ${status.activeWorkflows}`);
        break;
      }
      case '/tools': {
        const tools = await this.request('list_tools');
        console.log('\n🔧 Available Tools:');
        for (const tool of tools) {
          console.log(`  • ${tool.name}: ${tool.description}`);
        }
        break;
      }
      case '/workflows': {
        const workflows = await this.request('list_workflows');
        if (workflows.length === 0) {
          console.log('\n📋 No active workflows.');
        } else {
          console.log('\n📋 Workflows:');
          for (const wf of workflows) {
            console.log(`  [${wf.status}] ${wf.name} (${wf.id.substring(0, 8)})`);
          }
        }
        break;
      }
      case '/policy': {
        const rules = await this.request('policy_list');
        console.log('\n🛡️  Policy Rules:');
        for (const rule of rules) {
          const status = rule.enabled ? '✅' : '❌';
          console.log(`  ${status} [${rule.action}] ${rule.name}: ${rule.description}`);
        }
        break;
      }
      case '/plugins': {
        const plugins = await this.request('plugin_list');
        if (plugins.length === 0) {
          console.log('\n📦 No plugins loaded.');
        } else {
          console.log('\n📦 Loaded Plugins:');
          for (const p of plugins) {
            console.log(`  • ${p.name} v${p.version}: ${p.description}`);
            if (p.tools.length > 0) {
              console.log(`    Tools: ${p.tools.join(', ')}`);
            }
          }
        }
        break;
      }
      case '/new': {
        await this.request('memory_clear');
        console.log('\n🗑️  Conversation cleared. Starting fresh.');
        break;
      }
      case '/help': {
        console.log('\n📖 Commands:');
        console.log('  quit       - Exit TUI');
        console.log('  /status    - Show daemon status');
        console.log('  /tools     - List available tools');
        console.log('  /workflows - List active workflows');
        console.log('  /policy    - List policy rules');
        console.log('  /plugins   - List loaded plugins');
        console.log('  /new       - Clear conversation');
        console.log('  /help      - Show this help');
        break;
      }
      default: {
        // Send message to daemon and use the IPC result to display the
        // reply.  Previously the response was discarded (fire-and-forget)
        // and the TUI relied solely on the agent:response broadcast
        // event, which could be lost.
        console.log('\n⏳ Processing...');
        this.activeRequest = true;
        try {
          const result = await this.request('send_message', { content: input, userId: 'local' });
          if (result?.content) {
            console.log(`\n🤖 Assistant: ${result.content}\n`);
          }
        } finally {
          this.activeRequest = false;
        }
      }
    }
  }

  private handleMessage(msg: any): void {
    // Handle response to pending request
    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Handle stream events
    if (msg.event) {
      const handlers = this.eventHandlers.get(msg.event) || [];
      for (const handler of handlers) {
        handler(msg.data);
      }
      
      // Also fire wildcard handlers
      const wildcardHandlers = this.eventHandlers.get('*') || [];
      for (const handler of wildcardHandlers) {
        handler({ event: msg.event, data: msg.data });
      }
    }
  }

  private sendRaw(data: any): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(data) + '\n');
    }
  }
}
