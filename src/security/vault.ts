/**
 * Encrypted secrets vault
 * Uses Node.js crypto for AES-256-GCM encryption
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

export class Vault {
  private vaultPath: string;
  private encryptionKey: Buffer | null = null;

  constructor(baseDir?: string) {
    const dir = baseDir || path.join(process.env.HOME || '~', '.aiassistant');
    this.vaultPath = path.join(dir, 'vault.enc');
  }

  async initialize(passphrase?: string): Promise<void> {
    const dir = path.dirname(this.vaultPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Derive key from passphrase or use machine-specific key
    const pass = passphrase || this.getMachineKey();
    const salt = this.getSalt();
    this.encryptionKey = crypto.pbkdf2Sync(pass, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  }

  async getSecret(key: string): Promise<string | null> {
    const secrets = await this.loadSecrets();
    return secrets[key] || null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const secrets = await this.loadSecrets();
    secrets[key] = value;
    await this.saveSecrets(secrets);
  }

  async deleteSecret(key: string): Promise<void> {
    const secrets = await this.loadSecrets();
    delete secrets[key];
    await this.saveSecrets(secrets);
  }

  async listKeys(): Promise<string[]> {
    const secrets = await this.loadSecrets();
    return Object.keys(secrets);
  }

  async hasSecret(key: string): Promise<boolean> {
    const secrets = await this.loadSecrets();
    return key in secrets;
  }

  private async loadSecrets(): Promise<Record<string, string>> {
    if (!this.encryptionKey) {
      throw new Error('Vault not initialized');
    }

    if (!fs.existsSync(this.vaultPath)) {
      return {};
    }

    try {
      const encrypted = fs.readFileSync(this.vaultPath);
      const iv = encrypted.subarray(0, IV_LENGTH);
      const tag = encrypted.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const ciphertext = encrypted.subarray(IV_LENGTH + TAG_LENGTH);

      const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf-8'));
    } catch (err) {
      // If decryption fails, return empty (vault may be corrupted or key changed)
      return {};
    }
  }

  private async saveSecrets(secrets: Record<string, string>): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Vault not initialized');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    
    const plaintext = Buffer.from(JSON.stringify(secrets), 'utf-8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const output = Buffer.concat([iv, tag, encrypted]);
    
    // Write atomically
    const tmpPath = this.vaultPath + '.tmp';
    fs.writeFileSync(tmpPath, output, { mode: 0o600 });
    fs.renameSync(tmpPath, this.vaultPath);
    fs.chmodSync(this.vaultPath, 0o600);
  }

  private getSalt(): Buffer {
    const saltPath = path.join(path.dirname(this.vaultPath), '.vault-salt');
    if (fs.existsSync(saltPath)) {
      return fs.readFileSync(saltPath);
    }
    const salt = crypto.randomBytes(SALT_LENGTH);
    fs.writeFileSync(saltPath, salt, { mode: 0o600 });
    return salt;
  }

  private getMachineKey(): string {
    // Use a combination of machine-specific identifiers
    const hostname = os.hostname();
    const user = process.env.USER || process.env.USERNAME || 'default';
    return `aiassistant-${hostname}-${user}`;
  }
}

/**
 * Redact sensitive values from strings (for logging)
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret && secret.length > 4) {
      redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '***REDACTED***');
    }
  }
  return redacted;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
