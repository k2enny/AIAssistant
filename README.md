# AIAssistant

Production-grade, extensible AI operator tool — a daemon + TUI + Telegram agent platform powered by OpenRouter LLM.

## Architecture

**Stack:** Node.js / TypeScript

```
┌──────────────────────────────────────────────────────────┐
│                     ./aiassistant CLI                     │
├───────────┬───────────┬───────────┬──────────┬───────────┤
│   setup   │   start   │   stop    │  policy  │   logs    │
├───────────┴───────────┴───────────┴──────────┴───────────┤
│                                                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │                    Daemon Process                     │ │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │ │
│  │  │ Orchestrator │  │ Policy Engine│  │ Event Bus  │  │ │
│  │  └──────┬──────┘  └──────────────┘  └────────────┘  │ │
│  │         │                                            │ │
│  │  ┌──────┴──────┐  ┌──────────────┐  ┌────────────┐  │ │
│  │  │ Tool Registry│  │Memory Manager│  │Plugin Loader│  │ │
│  │  └─────────────┘  └──────────────┘  └────────────┘  │ │
│  │                                                      │ │
│  │  ┌──────────────┐  ┌──────────────┐                  │ │
│  │  │  IPC Server  │  │   SQLite     │                  │ │
│  │  │ (Unix Socket)│  │   Storage    │                  │ │
│  │  └──────┬───────┘  └──────────────┘                  │ │
│  └─────────┼────────────────────────────────────────────┘ │
│            │ IPC (Unix Socket)                            │
│  ┌─────────┴──────────────────────────────────────────┐   │
│  │              Channel Clients                        │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  │   │
│  │  │  TUI Client  │  │   Telegram   │  │ Future:  │  │   │
│  │  │ (terminal)   │  │    Client    │  │ Discord, │  │   │
│  │  │              │  │  (Telegraf)  │  │ WhatsApp │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────┘  │   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Node.js/TypeScript**: First-class Playwright support, async I/O, rich ecosystem for Telegram bots and TUI, and straightforward packaging.
- **Daemon + Client**: Background service handles all logic; channel clients (TUI, Telegram, etc.) connect/disconnect freely via IPC.
- **Channel Clients as Peers**: All input channels (TUI, Telegram, future Discord/WhatsApp) are separate processes that connect to the daemon via IPC. This keeps the daemon focused on orchestration and makes it easy to add new channel types.
- **Unix Domain Socket IPC**: Secure, fast, local-only communication with auth token.
- **Plugin Hot-Reload**: Plugins loaded/unloaded/reloaded at runtime without daemon restart.
- **Policy Engine**: Every tool call evaluated against hierarchical rules before execution.
- **Event-Driven**: In-process event bus decouples all components.

## Quick Start

### Prerequisites (Linux)

```bash
# Install prerequisites
sudo bash scripts/setup-linux.sh

# Or manually: Node.js 18+, build-essential, python3, sqlite3
```

### Install & Build

```bash
npm install
npm run build
```

### First-Time Setup

```bash
# Interactive setup wizard (configures API keys, starts daemon, opens TUI)
node dist/index.js setup
```

### Usage

```bash
# Start daemon in background
node dist/index.js start

# Check status
node dist/index.js status

# Open interactive TUI (type 'quit' to exit, daemon stays running)
node dist/index.js tui

# Start Telegram bot channel (connects to daemon via IPC)
node dist/index.js telegram

# Stop daemon
node dist/index.js stop

# Restart daemon
node dist/index.js restart

# Follow logs
node dist/index.js logs -f

# Reset conversation data
node dist/index.js reset

# Policy management
node dist/index.js policy list
node dist/index.js policy add
node dist/index.js policy remove <id>
```

### TUI Commands

| Command      | Description                |
|-------------|----------------------------|
| `quit`      | Exit TUI (daemon stays running) |
| `/status`   | Show daemon status         |
| `/tools`    | List available tools       |
| `/workflows`| List active workflows      |
| `/policy`   | List policy rules          |
| `/plugins`  | List loaded plugins        |
| `/new`      | Clear conversation         |
| `/help`     | Show help                  |

### Release Build

```bash
bash scripts/build.sh
# Produces: build/aiassistant
./build/aiassistant setup
```

## Core Components

### Event Bus (`src/core/event-bus.ts`)
In-process pub/sub with event history. All components communicate via events, enabling loose coupling and easy extension.

### Policy Engine (`src/policy/engine.ts`)
Evaluates rules before every tool execution. Supports:
- Hierarchical scopes: global, per-tool, per-channel, per-agent, per-workflow
- Actions: `allow`, `deny`, `require-confirmation`
- Target matching: commands, domains, users, patterns
- Default rules: confirm downloads, restrict shell access, etc.

### Plugin System (`src/plugins/`)
- **Loader** (`loader.ts`): Discover, load, unload, reload plugins at runtime
- **SDK** (`sdk.ts`): Generate new plugin scaffolding
- **Self-Extension** (`self-extend.ts`): Pipeline to generate → validate → approve → hot-load new skills
- Plugins live in `~/.aiassistant/plugins/` or `./plugins/`

### Tool Registry (`src/tools/registry.ts`)
Manages tool registration with schemas for LLM function calling. Built-in tools:
- `shell_exec`: Sandboxed shell command execution (with policy approval)
- `datetime`: Date/time operations (current time, parse, format, diff)

> **Note:** Web browsing is not currently available as a built-in skill. Playwright-based web automation is planned for Phase 2. Custom web-related skills can be added via the plugin system.

### Memory Manager (`src/memory/manager.ts`)
Workflow-scoped conversation memory with:
- Ephemeral context + persistent storage
- Automatic summarization support
- Session clearing and forking

### Storage (`src/storage/sqlite.ts`)
SQLite-based storage with SQL injection protection. Implements the `StorageInterface` for easy swapping.

### Security
- **Vault** (`src/security/vault.ts`): AES-256-GCM encrypted secrets, never logged
- **Audit Logger** (`src/security/audit.ts`): JSONL audit trail for tool calls, policy decisions, plugin events
- Auth token for IPC, socket permissions `0600`

### Channels
All channel clients are separate processes that connect to the daemon via IPC:
- **TUI** (`src/channels/tui/client.ts`): Interactive terminal client via IPC
- **Telegram** (`src/channels/telegram/client.ts`): Bot API via Telegraf, connects to daemon via IPC
- Future channels (Discord, WhatsApp, etc.) follow the same pattern: connect to daemon via IPC

## Plugin Development

### Plugin Structure

```
my-plugin/
├── plugin.json   # Metadata
├── index.js      # Entry point (exports plugin class)
├── test.js       # Tests
└── README.md     # Documentation
```

### plugin.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "author": "You",
  "permissions": ["network"],
  "tools": ["my_tool"]
}
```

### Plugin Class

```javascript
class MyTool {
  constructor() {
    this.schema = {
      name: 'my_tool',
      description: 'Does something useful',
      parameters: [
        { name: 'input', type: 'string', description: 'Input value', required: true }
      ],
      returns: 'Result object',
      category: 'custom',
      permissions: [],
    };
  }

  async execute(params, context) {
    return { success: true, output: { result: params.input } };
  }
}

class MyPlugin {
  constructor() {
    this.metadata = { name: 'my-plugin', version: '1.0.0', description: 'My plugin', permissions: [], tools: ['my_tool'] };
    this.tool = new MyTool();
  }
  async initialize(context) { context.registerTool(this.tool); }
  async shutdown() {}
  getTools() { return [this.tool]; }
}

module.exports = MyPlugin;
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Type-check
npm run lint
```

## Security & Threat Model

### Threats Addressed
1. **Credential Theft**: Secrets encrypted at rest (AES-256-GCM), never logged, redacted in output
2. **Prompt Injection**: Web content treated as untrusted; policies enforce allow/deny regardless of LLM output
3. **Unauthorized Tool Execution**: Policy engine evaluates every tool call; deny rules cannot be bypassed
4. **IPC Hijacking**: Unix socket with `0600` permissions + auth token required
5. **Plugin Attacks**: Plugins sandboxed to registered tools; user approval required for self-generated plugins

### Security Controls
- Encrypted vault for all secrets
- Audit logging (JSONL) for all tool calls, policy decisions, plugin events
- Policy engine with deny-by-default option
- Dry-run mode for testing
- Input validation on all tool parameters
- SQL injection protection in storage layer

## Roadmap

### Phase 1 (Current) ✅
- Daemon + IPC + TUI architecture
- Policy engine with hierarchical rules
- Plugin system with hot-reload
- Telegram connector
- OpenRouter LLM integration
- Built-in tools (shell, datetime)
- Setup wizard
- Unit tests

### Phase 2
- Web UI channel (REST API + WebSocket, connects via IPC)
- Discord / Slack / WhatsApp connectors (same IPC-based pattern as Telegram)
- Playwright web automation tool
- Sub-agent support (orchestrator delegates tasks to specialized agents)
- Scheduler with cron-like expressions
- Multi-user support
- Streaming LLM responses in TUI

### Phase 3
- Distributed workers (Redis/NATS queue)
- Multi-tenant separation
- Advanced memory (vector search, RAG)
- Plugin marketplace
- Systemd service generation
- Health monitoring dashboard

## License

ISC