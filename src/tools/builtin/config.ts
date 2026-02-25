/**
 * Centralized config tool - namespace-based configuration management
 *
 * Provides a single, scalable interface for configuring any tool or service.
 * Secrets are stored in the encrypted Vault; plain settings go to JSON config files.
 *
 * Actions:
 *   set    - Set config values for a namespace
 *   get    - Get config values for a namespace
 *   list   - List all configurable namespaces and their fields
 *   status - Show which namespaces are configured / unconfigured
 *   delete - Remove config for a namespace or specific field
 */
import { Tool, ToolSchema, ToolResult, ToolContext } from '../../core/interfaces';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface ConfigFieldSchema {
    name: string;
    description: string;
    required: boolean;
    /** When true the value is stored in the encrypted Vault instead of a JSON config file. */
    secret: boolean;
}

export interface ConfigNamespace {
    name: string;
    description: string;
    fields: ConfigFieldSchema[];
}

// ---------------------------------------------------------------------------
// Vault-like interface so the tool can be unit-tested without a real Vault.
// ---------------------------------------------------------------------------

export interface ConfigVault {
    initialize(): Promise<void>;
    getSecret(key: string): Promise<string | null>;
    setSecret(key: string, value: string): Promise<void>;
    deleteSecret(key: string): Promise<void>;
    hasSecret(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Config Tool
// ---------------------------------------------------------------------------

export class ConfigTool implements Tool {
    readonly schema: ToolSchema = {
        name: 'config',
        description:
            'Centralized configuration for all tools and services. Use this tool to configure Gmail, Telegram, LLM settings, and any other service. ' +
            'Supports set, get, list, status, and delete actions across namespaces.',
        parameters: [
            {
                name: 'action',
                type: 'string',
                description: 'Action to perform: "set", "get", "list", "status", "delete"',
                required: true,
            },
            {
                name: 'namespace',
                type: 'string',
                description:
                    'Config namespace / tool name, e.g. "gmail", "telegram", "openrouter". Required for set/get/delete.',
                required: false,
            },
            {
                name: 'values',
                type: 'object',
                description:
                    'Object of key-value pairs to set. All required fields for the namespace should be provided in a SINGLE call. Example: {"client_id":"...","client_secret":"...","refresh_token":"..."}',
                required: false,
            },
            {
                name: 'field',
                type: 'string',
                description: 'Specific field name (for "get" a single field or "delete" a single field)',
                required: false,
            },
        ],
        returns: 'Configuration data or operation result',
        category: 'system',
        permissions: ['config.read', 'config.write'],
    };

    private homeDir: string;
    private vault: ConfigVault;
    private namespaces: Map<string, ConfigNamespace> = new Map();

    constructor(vault: ConfigVault) {
        this.homeDir =
            process.env.AIASSISTANT_HOME ||
            path.join(process.env.HOME || '~', '.aiassistant');
        this.vault = vault;
        this.registerBuiltinNamespaces();
    }

    // ------------------------------------------------------------------
    // Public API for registering new namespaces (used by plugins / future tools)
    // ------------------------------------------------------------------

    registerNamespace(ns: ConfigNamespace): void {
        this.namespaces.set(ns.name, ns);
    } 

    getNamespace(name: string): ConfigNamespace | undefined {
        return this.namespaces.get(name);
    }

    getNamespaces(): ConfigNamespace[] {
        return Array.from(this.namespaces.values());
    }

    // ------------------------------------------------------------------
    // Tool interface
    // ------------------------------------------------------------------

    validate(params: Record<string, any>): { valid: boolean; errors?: string[] } {
        const errors: string[] = [];
        const validActions = ['set', 'get', 'list', 'status', 'delete'];

        if (!params.action || typeof params.action !== 'string') {
            errors.push('action is required and must be a string');
        } else if (!validActions.includes(params.action)) {
            errors.push(`action must be one of: ${validActions.join(', ')}`);
        }

        if (['set', 'get', 'delete'].includes(params.action) && !params.namespace) {
            errors.push('namespace is required for set/get/delete actions');
        }

        if (params.action === 'set') {
            if (!params.values || typeof params.values !== 'object') {
                errors.push('values (object) is required for set action');
            }
        }

        return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
    }

    async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
        if (context.dryRun) {
            return { success: true, output: `[DRY RUN] Would perform config action: ${params.action}` };
        }

        try {
            switch (params.action) {
                case 'set':
                    return await this.setConfig(params);
                case 'get':
                    return await this.getConfig(params);
                case 'list':
                    return this.listNamespaces();
                case 'status':
                    return await this.getStatus(params);
                case 'delete':
                    return await this.deleteConfig(params);
                default:
                    return { success: false, output: null, error: `Unknown action: ${params.action}` };
            }
        } catch (err: any) {
            return { success: false, output: null, error: err.message };
        }
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    private async setConfig(params: Record<string, any>): Promise<ToolResult> {
        const ns = this.namespaces.get(params.namespace);
        if (!ns) {
            return {
                success: false,
                output: null,
                error: `Unknown namespace: "${params.namespace}". Use config with action "list" to see available namespaces.`,
            };
        }

        const values: Record<string, any> = params.values || {};
        const secretFields: string[] = [];
        const plainFields: string[] = [];

        for (const field of ns.fields) {
            if (field.name in values) {
                if (field.secret) {
                    await this.vault.setSecret(`${params.namespace}_${field.name}`, String(values[field.name]));
                    secretFields.push(field.name);
                } else {
                    plainFields.push(field.name);
                }
            }
        }

        // Store any non-secret values in a JSON config file
        if (plainFields.length > 0) {
            const existing = this.loadConfigFile(params.namespace);
            for (const f of plainFields) {
                existing[f] = values[f];
            }
            this.saveConfigFile(params.namespace, existing);
        }

        // Also write a legacy-compatible file for Gmail so existing code keeps working
        if (params.namespace === 'gmail' && secretFields.length > 0) {
            this.writeLegacyGmailConfig(values, secretFields);
        }

        const allSet = [...secretFields, ...plainFields];
        // Check which required fields are still missing
        const missing = ns.fields
            .filter(f => f.required && !allSet.includes(f.name))
            .map(f => f.name);

        // Verify missing fields aren't already configured
        const trulyMissing: string[] = [];
        for (const m of missing) {
            const field = ns.fields.find(f => f.name === m)!;
            if (field.secret) {
                if (!(await this.vault.hasSecret(`${params.namespace}_${m}`))) {
                    trulyMissing.push(m);
                }
            } else {
                const existing = this.loadConfigFile(params.namespace);
                if (!(m in existing)) {
                    trulyMissing.push(m);
                }
            }
        }

        return {
            success: true,
            output: {
                message: `Configuration saved for "${params.namespace}": ${allSet.join(', ')}`,
                fieldsSet: allSet,
                ...(trulyMissing.length > 0 && {
                    warning: `Still missing required fields: ${trulyMissing.join(', ')}`,
                    missingFields: trulyMissing,
                }),
            },
        };
    }

    private async getConfig(params: Record<string, any>): Promise<ToolResult> {
        const ns = this.namespaces.get(params.namespace);
        if (!ns) {
            return {
                success: false,
                output: null,
                error: `Unknown namespace: "${params.namespace}". Use config with action "list" to see available namespaces.`,
            };
        }

        const result: Record<string, any> = {};
        const fieldsToGet = params.field
            ? ns.fields.filter(f => f.name === params.field)
            : ns.fields;

        for (const field of fieldsToGet) {
            if (field.secret) {
                const val = await this.vault.hasSecret(`${params.namespace}_${field.name}`);
                // Never expose secret values, just whether they are set
                result[field.name] = val ? '***configured***' : null;
            } else {
                const config = this.loadConfigFile(params.namespace);
                result[field.name] = config[field.name] ?? null;
            }
        }

        return { success: true, output: { namespace: params.namespace, config: result } };
    }

    private listNamespaces(): ToolResult {
        const list = Array.from(this.namespaces.values()).map(ns => ({
            namespace: ns.name,
            description: ns.description,
            fields: ns.fields.map(f => ({
                name: f.name,
                description: f.description,
                required: f.required,
                secret: f.secret,
            })),
        }));

        return { success: true, output: { namespaces: list } };
    }

    private async getStatus(params: Record<string, any>): Promise<ToolResult> {
        const namespacesToCheck = params.namespace
            ? [this.namespaces.get(params.namespace)].filter(Boolean) as ConfigNamespace[]
            : Array.from(this.namespaces.values());

        if (params.namespace && namespacesToCheck.length === 0) {
            return {
                success: false,
                output: null,
                error: `Unknown namespace: "${params.namespace}".`,
            };
        }

        const statuses: any[] = [];

        for (const ns of namespacesToCheck) {
            const configured: string[] = [];
            const missing: string[] = [];

            for (const field of ns.fields) {
                let hasValue = false;
                if (field.secret) {
                    hasValue = await this.vault.hasSecret(`${ns.name}_${field.name}`);
                } else {
                    const config = this.loadConfigFile(ns.name);
                    hasValue = field.name in config;
                }

                if (hasValue) {
                    configured.push(field.name);
                } else if (field.required) {
                    missing.push(field.name);
                }
            }

            statuses.push({
                namespace: ns.name,
                description: ns.description,
                configured: missing.length === 0,
                fieldsConfigured: configured,
                fieldsMissing: missing,
            });
        }

        return { success: true, output: { services: statuses } };
    }

    private async deleteConfig(params: Record<string, any>): Promise<ToolResult> {
        const ns = this.namespaces.get(params.namespace);
        if (!ns) {
            return {
                success: false,
                output: null,
                error: `Unknown namespace: "${params.namespace}".`,
            };
        }

        const fieldsToDelete = params.field
            ? ns.fields.filter(f => f.name === params.field)
            : ns.fields;

        const deleted: string[] = [];

        for (const field of fieldsToDelete) {
            if (field.secret) {
                if (await this.vault.hasSecret(`${params.namespace}_${field.name}`)) {
                    await this.vault.deleteSecret(`${params.namespace}_${field.name}`);
                    deleted.push(field.name);
                }
            } else {
                const config = this.loadConfigFile(params.namespace);
                if (field.name in config) {
                    delete config[field.name];
                    this.saveConfigFile(params.namespace, config);
                    deleted.push(field.name);
                }
            }
        }

        // Also remove legacy Gmail file if clearing the whole namespace
        if (params.namespace === 'gmail' && !params.field) {
            const legacyPath = path.join(this.homeDir, 'config', 'gmail-credentials.json');
            if (fs.existsSync(legacyPath)) {
                try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }
            }
        }

        return {
            success: true,
            output: {
                message: deleted.length > 0
                    ? `Deleted config for "${params.namespace}": ${deleted.join(', ')}`
                    : `No config found to delete for "${params.namespace}"`,
                fieldsDeleted: deleted,
            },
        };
    }

    // ------------------------------------------------------------------
    // Storage helpers
    // ------------------------------------------------------------------

    private getConfigFilePath(namespace: string): string {
        return path.join(this.homeDir, 'config', `${namespace}.json`);
    }

    private loadConfigFile(namespace: string): Record<string, any> {
        const filePath = this.getConfigFilePath(namespace);
        if (!fs.existsSync(filePath)) return {};
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return {};
        }
    }

    private saveConfigFile(namespace: string, data: Record<string, any>): void {
        const configDir = path.join(this.homeDir, 'config');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(this.getConfigFilePath(namespace), JSON.stringify(data, null, 2), { mode: 0o600 });
    }

    /**
     * Write a legacy gmail-credentials.json so the existing GmailTool can
     * read credentials without any changes.  This keeps backward compat.
     */
    private async writeLegacyGmailConfig(
        values: Record<string, any>,
        secretFieldsSet: string[],
    ): Promise<void> {
        const legacyPath = path.join(this.homeDir, 'config', 'gmail-credentials.json');
        let existing: Record<string, any> = {};
        if (fs.existsSync(legacyPath)) {
            try { existing = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')); } catch { /* ignore */ }
        }

        for (const f of secretFieldsSet) {
            if (f in values) existing[f] = values[f];
        }

        const configDir = path.join(this.homeDir, 'config');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(legacyPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    }

    // ------------------------------------------------------------------
    // Built-in namespace definitions
    // ------------------------------------------------------------------

    private registerBuiltinNamespaces(): void {
        this.registerNamespace({
            name: 'gmail',
            description: 'Gmail OAuth2 email integration',
            fields: [
                { name: 'client_id', description: 'Google OAuth2 client ID', required: true, secret: true },
                { name: 'client_secret', description: 'Google OAuth2 client secret', required: true, secret: true },
                { name: 'refresh_token', description: 'Google OAuth2 refresh token', required: true, secret: true },
            ],
        });

        this.registerNamespace({
            name: 'telegram',
            description: 'Telegram bot integration',
            fields: [
                { name: 'bot_token', description: 'Telegram bot token from @BotFather', required: true, secret: true },
            ],
        });

        this.registerNamespace({
            name: 'openrouter',
            description: 'OpenRouter LLM API configuration',
            fields: [
                { name: 'api_key', description: 'OpenRouter API key', required: true, secret: true },
                { name: 'model', description: 'LLM model name (e.g. openai/gpt-4o-mini)', required: false, secret: false },
                { name: 'max_tokens', description: 'Maximum response tokens', required: false, secret: false },
                { name: 'temperature', description: 'Sampling temperature (0-2)', required: false, secret: false },
            ],
        });
    }
}
