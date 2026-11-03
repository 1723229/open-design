import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'ldapts';
import type { CompanyUser } from '@open-design/contracts';
import type { CompanyConfig, CompanyLdapConfig } from './config.js';
import { CompanyStore, type CompanyStoredSession, type LdapIdentity } from './store.js';

export interface CompanyLdap {
  authenticate(username: string, password: string): Promise<LdapIdentity | null>;
  recheck(identity: LdapIdentity): Promise<boolean>;
  lookup?(entryUUID: string): Promise<LdapIdentity | null>;
}

export function companyProviderFingerprint(config: CompanyConfig): string {
  const ldap = config.auth.mode === 'ldap'
    ? Object.entries(config.auth.ldap ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    : null;
  return createHash('sha256').update(JSON.stringify([config.enabled, config.auth.mode, ldap])).digest('hex');
}

interface DirectoryEntry { dn: string; [attribute: string]: unknown }
interface DirectoryClient {
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: { filter: string; scope: 'sub'; sizeLimit: number; attributes: string[] }): Promise<{ searchEntries: DirectoryEntry[] }>;
  startTLS(options: { rejectUnauthorized: boolean }): Promise<void>;
  unbind(): Promise<void>;
}

/** RFC 4515 escaping is required even when LDAP supplies a trusted DN. */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\u0000]/gu, (character) => `\\${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function attribute(entry: DirectoryEntry, name: string): string | null {
  const raw = Object.entries(entry).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : null;
}

export function createLdapDirectory(config: CompanyLdapConfig, clientFactory?: () => DirectoryClient): CompanyLdap {
  const factory = clientFactory ?? (() => new Client({
    url: config.url, timeout: config.searchTimeoutMs, connectTimeout: config.connectTimeoutMs,
    // ldapts treats populated tlsOptions as implicit TLS, including for ldap://.
    ...(new URL(config.url).protocol === 'ldaps:' ? { tlsOptions: { rejectUnauthorized: config.verifyTls } } : {}),
  }));
  const attributes = [...new Set([
    config.usernameAttribute, config.entryUUIDAttribute, config.displayNameAttribute,
    'pwdAccountLockedTime', 'nsAccountLock', 'userAccountControl', ...(config.disabledAttribute ? [config.disabledAttribute] : []),
  ])];
  const enabled = (entry: DirectoryEntry) => {
    if (attribute(entry, 'pwdAccountLockedTime')) return false;
    if (attribute(entry, 'nsAccountLock')?.toLowerCase() === 'true') return false;
    const uac = attribute(entry, 'userAccountControl');
    if (uac !== null && (Number(uac) & 2) !== 0) return false;
    return !config.disabledAttribute || attribute(entry, config.disabledAttribute) !== (config.disabledValue ?? 'true');
  };
  async function serviceSearch(filter: string, password?: string): Promise<LdapIdentity | null> {
    const client = factory();
    try {
      if (config.startTls) await client.startTLS({ rejectUnauthorized: config.verifyTls });
      await client.bind(config.bindDn, config.bindPassword);
      const { searchEntries } = await client.search(config.baseDn, { filter, scope: 'sub', sizeLimit: 2, attributes });
      if (searchEntries.length !== 1) return null;
      const entry = searchEntries[0]!;
      const username = attribute(entry, config.usernameAttribute);
      const entryUUID = attribute(entry, config.entryUUIDAttribute);
      if (!username || !entryUUID || username.toLowerCase() === 'admin' || !enabled(entry)) return null;
      // Bind with the DN returned by the directory, never by interpolating the login name.
      if (password !== undefined) await client.bind(entry.dn, password);
      const displayName = attribute(entry, config.displayNameAttribute);
      return { username, entryUUID, ...(displayName ? { displayName } : {}) };
    } finally {
      await client.unbind().catch(() => {});
    }
  }
  return {
    authenticate: async (username, password) => {
      if (!password || !username) return null;
      return serviceSearch(config.userFilter.replaceAll('{username}', escapeLdapFilter(username)), password);
    },
    recheck: async (identity) => Boolean(await serviceSearch(`(&(${config.entryUUIDAttribute}=${escapeLdapFilter(identity.entryUUID)})${config.userFilter.replaceAll('{username}', escapeLdapFilter(identity.username))})`)),
    lookup: async (entryUUID) => serviceSearch(`(&(${config.entryUUIDAttribute}=${escapeLdapFilter(entryUUID)})${config.userFilter.replaceAll('{username}', '*')})`),
  };
}

export class CompanyAuth {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly eligibility = new Map<string, { checkedAt: number; eligible: boolean }>();
  private readonly eligibilityChecks = new Map<string, Promise<boolean>>();

  constructor(
    readonly store: CompanyStore,
    private readonly config: CompanyConfig,
    private readonly dataRoot: string,
    private readonly ldap: CompanyLdap | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  bootstrap(): void {
    if (!this.config.enabled || this.store.findUser('admin')) return;
    mkdirSync(this.dataRoot, { recursive: true });
    const password = randomBytes(24).toString('base64url');
    this.store.database.transaction(() => {
      this.store.createAdmin(password);
      writeFileSync(path.join(this.dataRoot, 'company-admin-bootstrap.txt'), `${password}\n`, { mode: 0o600, flag: 'wx' });
    })();
  }

  async login(username: string, password: string, remoteAddress: string): Promise<CompanyUser | null> {
    if (!username || username.length > 256 || !password || password.length > 4096) return null;
    const key = `${remoteAddress}\0${username.toLowerCase()}`;
    const now = this.now();
    for (const [entry, attempt] of this.attempts) if (attempt.resetAt <= now) this.attempts.delete(entry);
    const attempt = this.attempts.get(key) ?? { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (attempt.count >= 10) return null;
    if (this.attempts.size >= 10_000 && !this.attempts.has(key)) return null;
    attempt.count += 1;
    this.attempts.set(key, attempt);
    let principal: CompanyUser | null = null;
    try {
      if (username.toLowerCase() === 'admin') {
        const admin = this.store.findUser('admin');
        if (admin && this.store.verifyPassword(admin.id, password)) principal = admin;
      } else if (this.config.auth.mode === 'local') {
        const local = this.store.findUser(username);
        if (local?.source === 'local' && this.store.verifyPassword(local.id, password)) principal = local;
      } else if (this.config.auth.mode === 'ldap' && this.ldap) {
        const identity = await this.ldap.authenticate(username, password);
        if (identity && (this.config.auth.ldap?.autoCreate !== false || this.store.listUsers().some((item) => this.store.getLdapIdentity(item.id)?.entryUUID === identity.entryUUID))) {
          principal = this.store.upsertLdapUser(identity);
        }
      }
    } catch {
      // LDAP bind/search failures and user failures share the same public result.
    }
    if (!principal || principal.disabled) {
      this.store.audit(null, 'login.failed', 'authentication');
      return null;
    }
    this.attempts.delete(key);
    if (principal.source === 'ldap') this.eligibility.set(principal.id, { checkedAt: this.now(), eligible: true });
    this.store.audit(principal.id, 'login.succeeded', principal.id);
    return principal;
  }

  createSession(principal: CompanyUser): { token: string; csrfToken: string } {
    if (this.store.getUser(principal.id)?.disabled !== false) throw new Error('User is disabled');
    return this.store.createSession(principal.id);
  }

  async loginFederated(entryUUID: string): Promise<CompanyUser | null> {
    if (this.config.auth.mode !== 'ldap' || !this.ldap?.lookup) return null;
    try {
      const identity = await this.ldap.lookup(entryUUID);
      if (!identity || identity.entryUUID !== entryUUID) return null;
      const principal = this.store.upsertLdapUser(identity);
      if (principal.disabled) return null;
      this.eligibility.set(principal.id, {checkedAt: this.now(), eligible: true});
      this.store.audit(principal.id, 'login.federated', principal.id);
      return principal;
    } catch { return null; }
  }

  async session(token: string): Promise<CompanyStoredSession | null> {
    const current = this.store.getSession(token, this.now());
    if (!current) return null;
    if (!await this.userEligible(current.user.id)) return null;
    // Re-read after the asynchronous directory operation so a concurrent revocation wins.
    return this.store.getSession(token, this.now());
  }

  /** Background jobs and signed tasks must not depend on a browser session remaining open. */
  async userEligible(userId: string): Promise<boolean> {
    const principal = this.store.getUser(userId);
    if (!principal || principal.disabled) return false;
    if (principal.source === 'local') return principal.username.toLowerCase() === 'admin' || this.config.auth.mode === 'local';
    if (this.config.auth.mode !== 'ldap' || !this.ldap) return false;
    const cached = this.eligibility.get(userId);
    if (cached && this.now() - cached.checkedAt < 5 * 60 * 1000) return cached.eligible;
    const pending = this.eligibilityChecks.get(userId);
    if (pending) return pending;
    const check = (async () => {
      const identity = this.store.getLdapIdentity(userId);
      let eligible = false;
      try { eligible = Boolean(identity && this.ldap && await this.ldap.recheck(identity)); } catch { /* fail closed */ }
      this.eligibility.set(userId, { checkedAt: this.now(), eligible });
      if (!eligible) this.store.revokeSessions(userId, userId, 'directory');
      return eligible && this.store.getUser(userId)?.disabled === false;
    })();
    this.eligibilityChecks.set(userId, check);
    try { return await check; }
    finally { this.eligibilityChecks.delete(userId); }
  }

  changePassword(principal: CompanyUser, currentPassword: string, newPassword: string): boolean {
    if (principal.source !== 'local' || newPassword.length < 12 || newPassword.length > 4096 || newPassword === currentPassword || !this.store.verifyPassword(principal.id, currentPassword)) return false;
    this.store.changePassword(principal.id, newPassword);
    const bootstrapFile = path.join(this.dataRoot, 'company-admin-bootstrap.txt');
    if (existsSync(bootstrapFile)) unlinkSync(bootstrapFile);
    return true;
  }
}

export function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
