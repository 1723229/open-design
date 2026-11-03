import { randomUUID } from 'node:crypto';
import type { CompanyTeam, CompanyTeamMapping, CompanyTeamMember, CompanyTeamRole, CompanyTeamSnapshot, CompanyTeamUpdateRequest, CompanyUser } from '@open-design/contracts';
import type { CompanyRevocation, CompanyStore } from './store.js';

interface TeamRow {
  id: string; name: string; status: CompanyTeam['status']; client_id: string | null;
  namespace: string | null; external_id: string | null; source_url: string | null;
  revision: number; confirmed_at: number | null; expired: number;
}
const roles = new Set(['owner', 'admin', 'editor', 'viewer']);
const MAX_AGE = 300_000;

/** Local team policy and external snapshots share one permission projection. */
export class CompanyTeams {
  constructor(private readonly store: CompanyStore, private readonly notify: (event: CompanyRevocation) => void, private readonly now: () => number) {
    store.database.exec(`
      CREATE TABLE IF NOT EXISTS company_teams (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','archived','disabled')),
        client_id TEXT, namespace TEXT, external_id TEXT, source_url TEXT,
        revision INTEGER NOT NULL DEFAULT 1, confirmed_at INTEGER, expired INTEGER NOT NULL DEFAULT 0,
        UNIQUE(client_id,namespace,external_id)
      );
      CREATE TABLE IF NOT EXISTS company_team_members (
        team_id TEXT NOT NULL REFERENCES company_teams(id), user_id TEXT NOT NULL REFERENCES company_users(id),
        role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')), PRIMARY KEY(team_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS company_project_teams (
        project_id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES company_teams(id)
      );
      CREATE INDEX IF NOT EXISTS company_project_teams_team ON company_project_teams(team_id);
      CREATE TABLE IF NOT EXISTS company_project_origins (
        project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES company_users(id)
      );
      INSERT OR IGNORE INTO company_project_origins
        SELECT project_id,user_id FROM company_project_members WHERE role='owner';
      INSERT OR IGNORE INTO company_project_origins
        SELECT p.project_id,a.actor_id FROM company_project_teams p JOIN company_audit a
          ON a.resource=p.team_id || '/' || p.project_id AND a.action='team.design.created'
        JOIN company_users u ON u.id=a.actor_id ORDER BY a.id;
    `);
    if (store.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()) {
      store.database.exec(`
        CREATE TRIGGER IF NOT EXISTS company_design_deleted AFTER DELETE ON projects
        BEGIN DELETE FROM company_project_teams WHERE project_id=OLD.id; END;
        DELETE FROM company_project_teams WHERE NOT EXISTS (SELECT 1 FROM projects WHERE projects.id=company_project_teams.project_id);
        CREATE TRIGGER IF NOT EXISTS company_design_origin_deleted AFTER DELETE ON projects
        BEGIN DELETE FROM company_project_origins WHERE project_id=OLD.id; END;
        DELETE FROM company_project_origins WHERE NOT EXISTS (SELECT 1 FROM projects WHERE projects.id=company_project_origins.project_id);
      `);
    }
  }
  private row(id: string): TeamRow | undefined { return this.store.database.prepare('SELECT * FROM company_teams WHERE id=?').get(id) as TeamRow | undefined; }
  private active(actor: Pick<CompanyUser, 'id'>): CompanyUser | null {
    const user = this.store.getUser(actor.id);
    return user && !user.disabled && !user.mustChangePassword ? user : null;
  }
  private stale(row: TeamRow): boolean { return row.client_id !== null && (row.confirmed_at === null || this.now() - row.confirmed_at >= MAX_AGE); }
  role(teamId: string, userId: string): CompanyTeamRole | null {
    return (this.store.database.prepare('SELECT role FROM company_team_members WHERE team_id=? AND user_id=?').get(teamId, userId) as {role: CompanyTeamRole} | undefined)?.role ?? null;
  }
  canAccess(actor: Pick<CompanyUser, 'id'>, teamId: string, write = false): boolean {
    const user = this.active(actor), row = this.row(teamId);
    if (!user || !row) return false;
    if (user.role === 'admin') return !write || (row.status === 'active' && !this.stale(row));
    const role = this.role(teamId, user.id);
    return role !== null && row.status !== 'disabled' && !this.stale(row) && (!write || (row.status === 'active' && role !== 'viewer'));
  }
  canManage(actor: Pick<CompanyUser, 'id'>, teamId: string): boolean {
    const user = this.active(actor);
    return Boolean(user && (user.role === 'admin' || (this.canAccess(user, teamId) && ['owner', 'admin'].includes(this.role(teamId, user.id) ?? ''))));
  }
  get(id: string, actor?: Pick<CompanyUser, 'id'>): CompanyTeam | null {
    const row = this.row(id);
    if (!row || (actor && !this.canAccess(actor, id))) return null;
    return { id, name: row.name, status: row.status, source: row.client_id ? 'external' : 'local', revision: row.revision,
      role: actor ? this.role(id, actor.id) : null, canManage: Boolean(actor && this.canManage(actor, id)),
      canWrite: Boolean(actor && this.canAccess(actor, id, true)), stale: this.stale(row),
      ...(row.source_url ? { sourceUrl: row.source_url } : {}), ...(row.confirmed_at !== null ? { confirmedAt: row.confirmed_at } : {}) };
  }
  list(actor: CompanyUser): CompanyTeam[] {
    return (this.store.database.prepare('SELECT id FROM company_teams ORDER BY name,id').all() as {id: string}[])
      .map(row => this.get(row.id, actor)).filter((team): team is CompanyTeam => team !== null);
  }
  create(name: string, actor: CompanyUser): CompanyTeam {
    if (!this.active(actor) || typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Invalid team');
    const id = randomUUID();
    this.store.database.transaction(() => {
      this.store.database.prepare("INSERT INTO company_teams (id,name,status) VALUES (?,?,'active')").run(id, name.trim());
      this.store.database.prepare("INSERT INTO company_team_members VALUES (?,?,'owner')").run(id, actor.id);
      this.store.audit(actor.id, 'team.created', id);
    })();
    return this.get(id, actor)!;
  }
  update(id: string, changes: CompanyTeamUpdateRequest, actor: CompanyUser): CompanyTeam {
    const row = this.editable(id, actor);
    if ((changes.name !== undefined && (typeof changes.name !== 'string' || !changes.name.trim() || changes.name.length > 200))
      || (changes.status !== undefined && !['active', 'archived'].includes(changes.status))) throw new Error('Invalid team update');
    this.store.database.prepare('UPDATE company_teams SET name=?,status=?,revision=revision+1 WHERE id=?')
      .run(changes.name?.trim() ?? row.name, changes.status ?? row.status, id);
    this.store.audit(actor.id, 'team.updated', id);
    this.revokeTeam(id);
    return this.get(id, actor)!;
  }
  private editable(id: string, actor: CompanyUser): TeamRow {
    const row = this.row(id);
    if (!row || row.client_id || !this.canManage(actor, id)) throw new Error('Team is managed externally or access denied');
    return row;
  }
  members(id: string): CompanyTeamMember[] {
    return this.store.database.prepare(`SELECT m.user_id AS userId,u.username,m.role FROM company_team_members m
      JOIN company_users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.username`).all(id) as CompanyTeamMember[];
  }
  setMember(id: string, userId: string, role: Exclude<CompanyTeamRole, 'owner'>, actor: CompanyUser): void {
    this.editable(id, actor);
    if (!['admin','editor','viewer'].includes(role) || !this.store.getUser(userId) || this.role(id, userId) === 'owner') throw new Error('Invalid team member');
    this.store.database.prepare('INSERT INTO company_team_members VALUES (?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role').run(id, userId, role);
    this.store.audit(actor.id, 'team.member.updated', `${id}/${userId}`);
    this.revokeTeam(id, [userId]);
  }
  removeMember(id: string, userId: string, actor: CompanyUser): void {
    this.editable(id, actor);
    if (this.role(id, userId) === 'owner') throw new Error('Team owner cannot be removed');
    this.store.database.prepare('DELETE FROM company_team_members WHERE team_id=? AND user_id=?').run(id, userId);
    this.store.audit(actor.id, 'team.member.removed', `${id}/${userId}`);
    this.revokeTeam(id, [userId]);
  }
  projectTeamId(projectId: string): string | null {
    return (this.store.database.prepare('SELECT team_id FROM company_project_teams WHERE project_id=?').get(projectId) as {team_id: string} | undefined)?.team_id ?? null;
  }
  attach(projectId: string, teamId: string, actor: CompanyUser): void {
    if (!this.canAccess(actor, teamId, true) || this.projectTeamId(projectId)
      || this.store.database.prepare('SELECT 1 FROM company_project_members WHERE project_id=?').get(projectId)) throw new Error('Cannot assign team');
    this.store.database.prepare('INSERT INTO company_project_teams VALUES (?,?)').run(projectId, teamId);
    this.store.database.prepare('INSERT OR IGNORE INTO company_project_origins VALUES (?,?)').run(projectId, actor.id);
    this.store.audit(actor.id, 'team.design.created', `${teamId}/${projectId}`);
  }
  projectOwnerId(projectId: string): string | null {
    const personal = this.store.database.prepare("SELECT user_id AS id FROM company_project_members WHERE project_id=? AND role='owner'").get(projectId) as {id:string} | undefined;
    const origin = this.store.database.prepare('SELECT owner_id AS id FROM company_project_origins WHERE project_id=?').get(projectId) as {id:string} | undefined;
    return personal?.id ?? origin?.id ?? null;
  }
  moveProject(projectId: string, teamId: string | null, actor: CompanyUser): void {
    const before = this.store.members(projectId);
    this.store.database.transaction(() => {
      const currentTeamId = this.projectTeamId(projectId);
      if (!this.store.canManage(actor, projectId)) throw new Error('Project owner or team administrator required');
      if (currentTeamId === teamId) return;
      if (teamId !== null && (currentTeamId || !this.canAccess(actor, teamId, true))) throw new Error('Cannot transfer to this team');
      const ownerId = this.projectOwnerId(projectId);
      if (!ownerId) throw new Error('Original project owner is unavailable');
      if (teamId) {
        this.store.database.prepare('INSERT INTO company_project_origins VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET owner_id=excluded.owner_id').run(projectId, ownerId);
        this.store.database.prepare('DELETE FROM company_project_members WHERE project_id=?').run(projectId);
        this.store.database.prepare('INSERT INTO company_project_teams VALUES (?,?)').run(projectId, teamId);
      } else {
        this.store.database.prepare('DELETE FROM company_project_teams WHERE project_id=?').run(projectId);
        this.store.database.prepare("INSERT INTO company_project_members VALUES (?,?,'owner')").run(projectId, ownerId);
      }
      this.store.audit(actor.id, teamId ? 'project.moved.to-team' : 'project.moved.to-personal', projectId);
    })();
    for (const member of before) this.notify({userId:member.userId,projectId,reason:'permissions'});
  }
  mappings(clientId: string): CompanyTeamMapping[] {
    return this.store.database.prepare('SELECT id AS teamId,namespace,external_id AS externalId,revision FROM company_teams WHERE client_id=? ORDER BY id').all(clientId) as CompanyTeamMapping[];
  }
  sync(clientId: string, namespace: string, externalId: string, snapshot: CompanyTeamSnapshot, expectedRevision: number): CompanyTeam {
    if (!clientId || !namespace || namespace.length > 200 || !externalId || externalId.length > 200 || snapshot.complete !== true
      || typeof snapshot.name !== 'string' || !snapshot.name.trim() || snapshot.name.length > 200 || !['active','archived','disabled'].includes(snapshot.status)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(snapshot.members) || snapshot.members.length > 10_000) throw new Error('Invalid complete snapshot');
    if (snapshot.sourceUrl) { const url = new URL(snapshot.sourceUrl); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source URL'); }
    const seen = new Set<string>();
    for (const member of snapshot.members) {
      if (!member || typeof member.entryUUID !== 'string' || !member.entryUUID || member.entryUUID.length > 200 || seen.has(member.entryUUID)
        || typeof member.username !== 'string' || !member.username || member.username.length > 128 || member.username.toLowerCase() === 'admin' || !roles.has(member.role)) throw new Error('Invalid LDAP member');
      seen.add(member.entryUUID);
    }
    const row = this.store.database.prepare('SELECT * FROM company_teams WHERE client_id=? AND namespace=? AND external_id=?').get(clientId, namespace, externalId) as TeamRow | undefined;
    if ((row?.revision ?? 0) !== expectedRevision) throw new Error('Team revision conflict');
    const id = row?.id ?? randomUUID();
    const before = row ? this.members(id).map(member => member.userId) : [];
    this.store.database.transaction(() => {
      this.store.database.prepare(`INSERT INTO company_teams (id,name,status,client_id,namespace,external_id,source_url,revision,confirmed_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,source_url=excluded.source_url,
        revision=excluded.revision,confirmed_at=excluded.confirmed_at,expired=0`)
        .run(id, snapshot.name.trim(), snapshot.status, clientId, namespace, externalId, snapshot.sourceUrl ?? null, expectedRevision + 1, this.now());
      this.store.database.prepare('DELETE FROM company_team_members WHERE team_id=?').run(id);
      for (const member of snapshot.members) {
        const user = this.store.upsertLdapUser(member);
        this.store.database.prepare('INSERT INTO company_team_members VALUES (?,?,?)').run(id, user.id, member.role);
      }
      this.store.audit(null, 'team.synchronized', id);
    })();
    this.revokeTeam(id, before);
    return this.get(id)!;
  }
  expire(): void {
    const expired = this.store.database.prepare('SELECT id FROM company_teams WHERE client_id IS NOT NULL AND expired=0 AND confirmed_at<=?').all(this.now() - MAX_AGE) as {id: string}[];
    for (const row of expired) {
      this.store.database.prepare('UPDATE company_teams SET expired=1 WHERE id=?').run(row.id);
      this.revokeTeam(row.id);
    }
  }
  private revokeTeam(id: string, users = this.members(id).map(member => member.userId)): void {
    const projects = this.store.database.prepare('SELECT project_id FROM company_project_teams WHERE team_id=?').all(id) as {project_id: string}[];
    for (const userId of users) for (const project of projects) this.notify({userId, projectId: project.project_id, reason: 'permissions'});
  }
}
