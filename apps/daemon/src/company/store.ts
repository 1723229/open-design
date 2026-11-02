import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CompanyProjectMember, CompanyProjectRole, CompanyUser, CompanyUserUpdateRequest, ProjectTabsState } from '@open-design/contracts';

export interface LdapIdentity { entryUUID: string; username: string; displayName?: string }
export interface CompanyRevocation {
  userId: string;
  projectId?: string;
  reason: 'logout' | 'disabled' | 'permissions' | 'password' | 'directory';
}
export interface CompanyStoredSession { user: CompanyUser; csrfToken: string; ldapCheckedAt: number; expiresAt: number }
interface UserRow {
  id: string; username: string; role: CompanyUser['role']; source: CompanyUser['source'];
  disabled: number; must_change_password: number; display_name: string | null;
  password_hash: string | null; entry_uuid: string | null;
}

function user(row: UserRow): CompanyUser {
  return {
    id: row.id, username: row.username, role: row.role, source: row.source,
    disabled: row.disabled === 1, mustChangePassword: row.must_change_password === 1,
    ...(row.display_name ? { displayName: row.display_name } : {}),
  };
}

function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

/** Additive tables in the same SQLite transaction domain as project persistence. */
export class CompanyStore {
  private readonly listeners = new Set<(event: CompanyRevocation) => void>();

  constructor(readonly database: Database.Database, private readonly now: () => number = Date.now) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS company_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS company_users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        source TEXT NOT NULL CHECK(source IN ('local','ldap')),
        entry_uuid TEXT UNIQUE, display_name TEXT,
        role TEXT NOT NULL CHECK(role IN ('admin','member')),
        disabled INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS company_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES company_users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, ldap_checked_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS company_sessions_user ON company_sessions(user_id);
      CREATE TABLE IF NOT EXISTS company_project_members (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES company_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(project_id,user_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS company_project_owner ON company_project_members(project_id) WHERE role='owner';
      CREATE TABLE IF NOT EXISTS company_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
        resource TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS company_project_preferences (
        project_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES company_users(id) ON DELETE CASCADE,
        tabs_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,user_id)
      );
    `);
  }

  wasEnabled(): boolean { return Boolean(this.database.prepare("SELECT 1 FROM company_state WHERE key='enabled'").get()); }
  markEnabled(): void { this.database.prepare("INSERT OR IGNORE INTO company_state VALUES ('enabled','true')").run(); }

  applyProviderFingerprint(fingerprint: string): void {
    const previous = this.database.prepare("SELECT value FROM company_state WHERE key='provider_fingerprint'").get() as { value: string } | undefined;
    if (previous?.value === fingerprint) return;
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM company_sessions').run();
      this.database.prepare("INSERT INTO company_state VALUES ('provider_fingerprint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fingerprint);
      if (previous) this.audit(null, 'authentication.provider.changed', 'authentication');
    })();
  }

  onRevoke(listener: (event: CompanyRevocation) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(event: CompanyRevocation): void { for (const listener of this.listeners) listener(event); }

  getUser(id: string): CompanyUser | null {
    const row = this.database.prepare('SELECT * FROM company_users WHERE id=?').get(id) as UserRow | undefined;
    return row ? user(row) : null;
  }

  findUser(username: string): CompanyUser | null {
    const row = this.database.prepare('SELECT * FROM company_users WHERE username=? COLLATE NOCASE').get(username) as UserRow | undefined;
    return row ? user(row) : null;
  }

  listUsers(): CompanyUser[] { return (this.database.prepare('SELECT * FROM company_users ORDER BY username').all() as UserRow[]).map(user); }

  createAdmin(password: string): CompanyUser {
    const id = randomUUID();
    this.database.prepare(`INSERT INTO company_users
      (id,username,source,role,must_change_password,password_hash,created_at) VALUES (?,'admin','local','admin',1,?,?)`)
      .run(id, passwordHash(password), this.now());
    return this.getUser(id)!;
  }

  createLocalUser(username: string, password: string, role: CompanyUser['role'], actorId: string): CompanyUser {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(username) || username.toLowerCase() === 'admin' || password.length < 12 || password.length > 4096) throw new Error('Invalid local user');
    const id = randomUUID();
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO company_users (id,username,source,role,must_change_password,password_hash,created_at) VALUES (?,?,'local',?,1,?,?)`)
        .run(id, username, role, passwordHash(password), this.now());
      this.audit(actorId, 'user.created', id);
    })();
    return this.getUser(id)!;
  }

  verifyPassword(id: string, password: string): boolean {
    const row = this.database.prepare('SELECT password_hash FROM company_users WHERE id=? AND disabled=0').get(id) as { password_hash: string | null } | undefined;
    if (!row?.password_hash) return false;
    const [salt, hex] = row.password_hash.split(':');
    if (!salt || !hex) return false;
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(hex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  changePassword(id: string, password: string): void {
    this.database.transaction(() => {
      this.database.prepare('UPDATE company_users SET password_hash=?,must_change_password=0 WHERE id=? AND source=\'local\'').run(passwordHash(password), id);
      this.revokeSessions(id, id, 'password');
      this.audit(id, 'password.changed', id);
    })();
  }

  upsertLdapUser(identity: LdapIdentity): CompanyUser {
    if (!identity.entryUUID || !identity.username || identity.username.toLowerCase() === 'admin') throw new Error('Invalid directory identity');
    const existing = this.database.prepare('SELECT * FROM company_users WHERE entry_uuid=? AND source=\'ldap\'').get(identity.entryUUID) as UserRow | undefined;
    if (existing) {
      this.database.prepare('UPDATE company_users SET username=?,display_name=? WHERE id=?').run(identity.username, identity.displayName ?? null, existing.id);
      return this.getUser(existing.id)!;
    }
    const id = randomUUID();
    this.database.prepare(`INSERT INTO company_users (id,username,source,entry_uuid,display_name,role,created_at) VALUES (?,?,'ldap',?,?,'member',?)`)
      .run(id, identity.username, identity.entryUUID, identity.displayName ?? null, this.now());
    return this.getUser(id)!;
  }

  getLdapIdentity(id: string): LdapIdentity | null {
    const row = this.database.prepare('SELECT * FROM company_users WHERE id=? AND source=\'ldap\'').get(id) as UserRow | undefined;
    return row?.entry_uuid ? { entryUUID: row.entry_uuid, username: row.username, ...(row.display_name ? { displayName: row.display_name } : {}) } : null;
  }

  updateUser(id: string, update: CompanyUserUpdateRequest, actorId: string): CompanyUser {
    const before = this.getUser(id);
    if (!before) throw new Error('Unknown user');
    if (before.username.toLowerCase() === 'admin' && (update.disabled === true || update.role === 'member')) throw new Error('Reserved admin cannot be disabled or demoted');
    this.database.transaction(() => {
      this.database.prepare('UPDATE company_users SET disabled=?,role=? WHERE id=?').run(update.disabled === undefined ? Number(before.disabled) : Number(update.disabled), update.role ?? before.role, id);
      this.database.prepare('DELETE FROM company_sessions WHERE user_id=?').run(id);
      this.audit(actorId, 'user.updated', id);
    })();
    this.notify({ userId: id, reason: update.disabled === true ? 'disabled' : 'permissions' });
    return this.getUser(id)!;
  }

  createSession(userId: string): { token: string; csrfToken: string } {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = this.now();
    this.database.prepare('DELETE FROM company_sessions WHERE expires_at<=?').run(now);
    this.database.prepare('INSERT INTO company_sessions VALUES (?,?,?,?,?)').run(tokenHash(token), userId, csrfToken, now + 8 * 60 * 60 * 1000, now);
    return { token, csrfToken };
  }

  getSession(token: string, now = this.now()): CompanyStoredSession | null {
    const row = this.database.prepare(`SELECT s.*,u.* FROM company_sessions s JOIN company_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(tokenHash(token), now) as (UserRow & { csrf_token: string; ldap_checked_at: number; expires_at: number }) | undefined;
    return row ? { user: user(row), csrfToken: row.csrf_token, ldapCheckedAt: row.ldap_checked_at, expiresAt: row.expires_at } : null;
  }

  touchLdapSession(token: string): void { this.database.prepare('UPDATE company_sessions SET ldap_checked_at=? WHERE token_hash=?').run(this.now(), tokenHash(token)); }
  deleteSession(token: string): void {
    const session = this.getSession(token);
    this.database.prepare('DELETE FROM company_sessions WHERE token_hash=?').run(tokenHash(token));
    if (session) this.notify({ userId: session.user.id, reason: 'logout' });
  }
  revokeSessions(userId: string, actorId: string, reason: CompanyRevocation['reason'] = 'permissions'): void {
    this.database.prepare('DELETE FROM company_sessions WHERE user_id=?').run(userId);
    this.audit(actorId, 'sessions.revoked', userId);
    this.notify({ userId, reason });
  }

  registerProjectOwner(projectId: string, owner: CompanyUser): void {
    this.database.prepare("INSERT INTO company_project_members (project_id,user_id,role) VALUES (?,?,'owner')").run(projectId, owner.id);
    this.audit(owner.id, 'project.created', projectId);
  }

  projectRole(projectId: string, userId: string): CompanyProjectRole | null {
    return (this.database.prepare('SELECT role FROM company_project_members WHERE project_id=? AND user_id=?').get(projectId, userId) as { role: CompanyProjectRole } | undefined)?.role ?? null;
  }

  canAccess(principal: Pick<CompanyUser, 'id'> | null, projectId: string, write = false): boolean {
    if (!principal) return false;
    const current = this.getUser(principal.id);
    if (!current || current.disabled || current.mustChangePassword) return false;
    if (current.role === 'admin') return true;
    const role = this.projectRole(projectId, current.id);
    return role !== null && (!write || role !== 'viewer');
  }

  canManage(principal: CompanyUser, projectId: string): boolean {
    return this.canAccess(principal, projectId, true) && (principal.role === 'admin' || this.projectRole(projectId, principal.id) === 'owner');
  }

  members(projectId: string): CompanyProjectMember[] {
    return this.database.prepare(`SELECT m.user_id AS userId,u.username,m.role FROM company_project_members m
      JOIN company_users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.username`).all(projectId) as CompanyProjectMember[];
  }

  setMember(projectId: string, userId: string, role: CompanyProjectRole, actorId: string): void {
    const before = this.projectRole(projectId, userId);
    this.database.transaction(() => {
      this.database.prepare('INSERT INTO company_project_members VALUES (?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(projectId, userId, role);
      this.audit(actorId, 'member.updated', `${projectId}/${userId}`);
    })();
    const rank = { viewer: 1, editor: 2, owner: 3 };
    if (before && rank[role] < rank[before]) this.notify({ userId, projectId, reason: 'permissions' });
  }

  removeMember(projectId: string, userId: string, actorId: string): void {
    this.database.prepare('DELETE FROM company_project_members WHERE project_id=? AND user_id=?').run(projectId, userId);
    this.audit(actorId, 'member.removed', `${projectId}/${userId}`);
    this.notify({ userId, projectId, reason: 'permissions' });
  }

  audit(actorId: string | null, action: string, resource: string): void {
    this.database.prepare('INSERT INTO company_audit (actor_id,action,resource,created_at) VALUES (?,?,?,?)').run(actorId, action, resource, this.now());
  }

  listAudit(): unknown[] { return this.database.prepare('SELECT * FROM company_audit ORDER BY id DESC LIMIT 200').all(); }

  getTabs(projectId: string, userId: string): ProjectTabsState {
    const row = this.database.prepare('SELECT tabs_json,updated_at FROM company_project_preferences WHERE project_id=? AND user_id=?').get(projectId, userId) as { tabs_json: string; updated_at: number } | undefined;
    return row ? { ...JSON.parse(row.tabs_json) as ProjectTabsState, hasSavedState: true, updatedAt: row.updated_at } : { tabs: [], active: null, hasSavedState: false };
  }

  setTabs(projectId: string, userId: string, state: ProjectTabsState): ProjectTabsState {
    this.database.prepare(`INSERT INTO company_project_preferences VALUES (?,?,?,?) ON CONFLICT(project_id,user_id)
      DO UPDATE SET tabs_json=excluded.tabs_json,updated_at=excluded.updated_at`).run(projectId, userId, JSON.stringify(state), this.now());
    return this.getTabs(projectId, userId);
  }
}
