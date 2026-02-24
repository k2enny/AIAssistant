/**
 * Setup wizard - first-run configuration
 */
import * as fs from 'fs';
import * as path from 'path';
import inquirer from 'inquirer';
import { Vault } from '../security/vault';

export class SetupWizard {
  private homeDir: string;
  private vault: Vault;

  constructor() {
    this.homeDir = process.env.AIASSISTANT_HOME || path.join(process.env.HOME || '~', '.aiassistant');
    this.vault = new Vault(this.homeDir);
  }

  async run(): Promise<void> {
    console.log('\n🤖 AIAssistant Setup Wizard\n');
    console.log('═'.repeat(50));
    console.log('This wizard will configure your AIAssistant installation.');
    console.log('');

    // Create directories
    this.ensureDirectories();
    console.log('✅ Directories created');

    // Initialize vault
    await this.vault.initialize();
    console.log('✅ Vault initialized');

    // Collect API keys
    await this.collectAPIKeys();

    // Create default config
    await this.createDefaultConfig();

    console.log('\n═'.repeat(50));
    console.log('✅ Setup complete!\n');
  }

  private ensureDirectories(): void {
    const dirs = ['logs', 'data', 'plugins', 'config'];
    for (const dir of dirs) {
      const p = path.join(this.homeDir, dir);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
      }
    }
  }

  private async collectAPIKeys(): Promise<void> {
    console.log('\n📝 API Configuration\n');

    // OpenRouter API key
    const existingOpenRouter = await this.vault.getSecret('openrouter_api_key');
    const openRouterMsg = existingOpenRouter 
      ? 'OpenRouter API key (press enter to keep existing)' 
      : 'OpenRouter API key (required for LLM features)';
    
    const { openRouterKey } = await inquirer.prompt([{
      type: 'password',
      name: 'openRouterKey',
      message: openRouterMsg,
      mask: '*',
    }]);

    if (openRouterKey) {
      await this.vault.setSecret('openrouter_api_key', openRouterKey);
      console.log('  ✅ OpenRouter API key saved');
    } else if (existingOpenRouter) {
      console.log('  ✅ Keeping existing OpenRouter API key');
    } else {
      console.log('  ⚠️  No OpenRouter API key. LLM features will be disabled.');
    }

    // Telegram bot token
    const existingTelegram = await this.vault.getSecret('telegram_bot_token');
    const telegramMsg = existingTelegram 
      ? 'Telegram bot token (press enter to keep existing)' 
      : 'Telegram bot token (optional, press enter to skip)';
    
    const { telegramToken } = await inquirer.prompt([{
      type: 'password',
      name: 'telegramToken',
      message: telegramMsg,
      mask: '*',
    }]);

    if (telegramToken) {
      await this.vault.setSecret('telegram_bot_token', telegramToken);
      console.log('  ✅ Telegram bot token saved');
    } else if (existingTelegram) {
      console.log('  ✅ Keeping existing Telegram bot token');
    } else {
      console.log('  ℹ️  No Telegram token. Telegram integration disabled.');
    }
  }

  private async createDefaultConfig(): Promise<void> {
    const configPath = path.join(this.homeDir, 'config', 'config.json');
    
    if (fs.existsSync(configPath)) {
      console.log('  ℹ️  Config file already exists');
      return;
    }

    const config = {
      version: '1.0.0',
      daemon: {
        autoRestart: true,
        maxRestarts: 5,
        restartDelay: 3000,
      },
      llm: {
        model: 'openai/gpt-4o-mini',
        maxTokens: 4096,
        temperature: 0.7,
      },
      logging: {
        level: 'info',
        maxFileSize: '10MB',
        maxFiles: 5,
      },
      security: {
        dryRun: false,
        requireConfirmationForShell: true,
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('  ✅ Default configuration created');
  }
}
