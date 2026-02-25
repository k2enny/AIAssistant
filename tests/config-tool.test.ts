import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigTool, ConfigVault, ConfigNamespace } from '../src/tools/builtin/config';

// ---------------------------------------------------------------------------
// Simple in-memory Vault mock
// ---------------------------------------------------------------------------
class MockVault implements ConfigVault {
    private store: Map<string, string> = new Map();

    async initialize(): Promise<void> { }

    async getSecret(key: string): Promise<string | null> {
        return this.store.get(key) || null;
    }

    async setSecret(key: string, value: string): Promise<void> {
        this.store.set(key, value);
    }

    async deleteSecret(key: string): Promise<void> {
        this.store.delete(key);
    }

    async hasSecret(key: string): Promise<boolean> {
        return this.store.has(key);
    }
}

describe('ConfigTool', () => {
    let tmpDir: string;
    let vault: MockVault;
    let tool: ConfigTool;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiassistant-config-test-'));
        process.env.AIASSISTANT_HOME = tmpDir;
        fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });

        vault = new MockVault();
        tool = new ConfigTool(vault);
    });

    afterEach(() => {
        delete process.env.AIASSISTANT_HOME;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    });

    const ctx = { workflowId: 'w1', userId: 'u1', channelId: 'tui', dryRun: false };

    // ---------- list ----------
    test('list returns all registered namespaces', async () => {
        const result = await tool.execute({ action: 'list' }, ctx);
        expect(result.success).toBe(true);
        const namespaces = result.output.namespaces.map((n: any) => n.namespace);
        expect(namespaces).toContain('gmail');
        expect(namespaces).toContain('telegram');
        expect(namespaces).toContain('openrouter');
    });

    // ---------- set ----------
    test('set stores secret fields in vault', async () => {
        const result = await tool.execute({
            action: 'set',
            namespace: 'gmail',
            values: {
                client_id: 'cid-123',
                client_secret: 'csec-456',
                refresh_token: 'rt-789',
            },
        }, ctx);

        expect(result.success).toBe(true);
        expect(result.output.fieldsSet).toEqual(['client_id', 'client_secret', 'refresh_token']);

        // Verify secrets are in vault
        expect(await vault.getSecret('gmail_client_id')).toBe('cid-123');
        expect(await vault.getSecret('gmail_client_secret')).toBe('csec-456');
        expect(await vault.getSecret('gmail_refresh_token')).toBe('rt-789');
    });

    test('set stores non-secret fields in config file', async () => {
        const result = await tool.execute({
            action: 'set',
            namespace: 'openrouter',
            values: { model: 'openai/gpt-4o', temperature: 0.5 },
        }, ctx);

        expect(result.success).toBe(true);
        expect(result.output.fieldsSet).toContain('model');
        expect(result.output.fieldsSet).toContain('temperature');

        // Verify JSON config file
        const configFile = path.join(tmpDir, 'config', 'openrouter.json');
        expect(fs.existsSync(configFile)).toBe(true);
        const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        expect(data.model).toBe('openai/gpt-4o');
        expect(data.temperature).toBe(0.5);
    });

    test('set returns missing required fields warning', async () => {
        const result = await tool.execute({
            action: 'set',
            namespace: 'gmail',
            values: { client_id: 'cid-123' },
        }, ctx);

        expect(result.success).toBe(true);
        expect(result.output.warning).toBeDefined();
        expect(result.output.missingFields).toContain('client_secret');
        expect(result.output.missingFields).toContain('refresh_token');
    });

    test('set rejects unknown namespace', async () => {
        const result = await tool.execute({
            action: 'set',
            namespace: 'nonexistent',
            values: { foo: 'bar' },
        }, ctx);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown namespace');
    });

    // ---------- get ----------
    test('get returns config values (secrets masked)', async () => {
        await vault.setSecret('gmail_client_id', 'secret-value');

        const result = await tool.execute({
            action: 'get',
            namespace: 'gmail',
        }, ctx);

        expect(result.success).toBe(true);
        expect(result.output.config.client_id).toBe('***configured***');
        expect(result.output.config.client_secret).toBeNull();
    });

    test('get returns non-secret values directly', async () => {
        // Write config file
        fs.writeFileSync(
            path.join(tmpDir, 'config', 'openrouter.json'),
            JSON.stringify({ model: 'openai/gpt-4o' }),
        );

        const result = await tool.execute({
            action: 'get',
            namespace: 'openrouter',
        }, ctx);

        expect(result.success).toBe(true);
        expect(result.output.config.model).toBe('openai/gpt-4o');
    });

    // ---------- status ----------
    test('status shows configured vs unconfigured', async () => {
        // Configure gmail fully
        await vault.setSecret('gmail_client_id', 'a');
        await vault.setSecret('gmail_client_secret', 'b');
        await vault.setSecret('gmail_refresh_token', 'c');

        const result = await tool.execute({ action: 'status' }, ctx);
        expect(result.success).toBe(true);

        const gmailStatus = result.output.services.find((s: any) => s.namespace === 'gmail');
        expect(gmailStatus.configured).toBe(true);

        const telegramStatus = result.output.services.find((s: any) => s.namespace === 'telegram');
        expect(telegramStatus.configured).toBe(false);
        expect(telegramStatus.fieldsMissing).toContain('bot_token');
    });

    // ---------- delete ----------
    test('delete removes config', async () => {
        await vault.setSecret('gmail_client_id', 'a');
        await vault.setSecret('gmail_client_secret', 'b');

        const result = await tool.execute({
            action: 'delete',
            namespace: 'gmail',
            field: 'client_id',
        }, ctx);

        expect(result.success).toBe(true);
        expect(result.output.fieldsDeleted).toContain('client_id');
        expect(await vault.hasSecret('gmail_client_id')).toBe(false);
        expect(await vault.hasSecret('gmail_client_secret')).toBe(true);
    });

    // ---------- registerNamespace ----------
    test('custom namespace can be registered', async () => {
        const customNs: ConfigNamespace = {
            name: 'custom_service',
            description: 'A custom service',
            fields: [
                { name: 'api_key', description: 'API key', required: true, secret: true },
                { name: 'endpoint', description: 'API endpoint', required: false, secret: false },
            ],
        };
        tool.registerNamespace(customNs);

        // Set values
        const result = await tool.execute({
            action: 'set',
            namespace: 'custom_service',
            values: { api_key: 'key123', endpoint: 'https://example.com' },
        }, ctx);

        expect(result.success).toBe(true);
        expect(await vault.getSecret('custom_service_api_key')).toBe('key123');

        const configFile = path.join(tmpDir, 'config', 'custom_service.json');
        const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        expect(data.endpoint).toBe('https://example.com');
    });

    // ---------- validation ----------
    test('validate rejects missing required params', () => {
        const v1 = tool.validate({ action: 'set' });
        expect(v1.valid).toBe(false);

        const v2 = tool.validate({ action: 'set', namespace: 'gmail' });
        expect(v2.valid).toBe(false);

        const v3 = tool.validate({ action: 'bogus' });
        expect(v3.valid).toBe(false);
    });

    test('validate accepts valid params', () => {
        const v = tool.validate({ action: 'set', namespace: 'gmail', values: { client_id: 'x' } });
        expect(v.valid).toBe(true);
    });

    // ---------- legacy gmail compat ----------
    test('set gmail writes legacy gmail-credentials.json', async () => {
        await tool.execute({
            action: 'set',
            namespace: 'gmail',
            values: {
                client_id: 'cid',
                client_secret: 'csec',
                refresh_token: 'rt',
            },
        }, ctx);

        const legacyPath = path.join(tmpDir, 'config', 'gmail-credentials.json');
        expect(fs.existsSync(legacyPath)).toBe(true);
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        expect(data.client_id).toBe('cid');
        expect(data.client_secret).toBe('csec');
        expect(data.refresh_token).toBe('rt');
    });
});
