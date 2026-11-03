import { afterEach, describe, expect, it } from 'vitest';
import { CompanyStore } from '../../src/company/store.js';
import { companyTestDatabase } from './database.js';

const databases: ReturnType<typeof companyTestDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = companyTestDatabase(); databases.push(db);
  let time = 1_000_000;
  const store = new CompanyStore(db, () => time);
  const owner = store.upsertLdapUser({ entryUUID: 'owner', username: 'owner' });
  const editor = store.upsertLdapUser({ entryUUID: 'editor', username: 'editor' });
  const viewer = store.upsertLdapUser({ entryUUID: 'viewer', username: 'viewer' });
  return { store, owner, editor, viewer, advance: (ms: number) => { time += ms; } };
}

describe('native and linked team ownership', () => {
  it('moves personal ownership into a team and restores the original owner without restoring old grants', () => {
    const {store, owner, editor, viewer} = fixture();
    const team = store.teams.create('Review team', owner);
    store.teams.setMember(team.id, editor.id, 'editor', owner);
    store.registerProjectOwner('design', editor);
    store.setMember('design', viewer.id, 'viewer', editor.id);
    const revoked: string[] = [];
    store.onRevoke(event => { if (event.projectId === 'design') revoked.push(event.userId); });
    store.teams.moveProject('design', team.id, editor);
    expect(store.teams.projectTeamId('design')).toBe(team.id);
    expect(store.canAccess(owner, 'design', true)).toBe(true);
    expect(store.canAccess(viewer, 'design')).toBe(false);
    expect(store.members('design').map(member => member.userId).sort()).toEqual([owner.id, editor.id].sort());
    expect(() => store.teams.moveProject('design', null, editor)).toThrow();
    store.teams.moveProject('design', null, owner);
    expect(store.teams.projectTeamId('design')).toBeNull();
    expect(store.projectRole('design', editor.id)).toBe('owner');
    expect(store.canAccess(owner, 'design')).toBe(false);
    expect(store.canAccess(viewer, 'design')).toBe(false);
    expect(revoked).toContain(viewer.id);
    expect(revoked).toContain(owner.id);
  });

  it('does not let a personal editor transfer ownership or attach it to an inaccessible team', () => {
    const {store, owner, editor, viewer} = fixture();
    const team = store.teams.create('Team', viewer);
    store.registerProjectOwner('design', owner);
    store.setMember('design', editor.id, 'editor', owner.id);
    expect(() => store.teams.moveProject('design', team.id, editor)).toThrow();
    expect(() => store.teams.moveProject('design', team.id, owner)).toThrow();
    expect(store.projectRole('design', owner.id)).toBe('owner');
    expect(store.teams.projectTeamId('design')).toBeNull();
  });

  it('allows an active viewer to comment without granting artifact writes and denies archived or revoked review', () => {
    const {store, owner, viewer} = fixture();
    const team = store.teams.create('Team', owner);
    store.teams.setMember(team.id, viewer.id, 'viewer', owner);
    store.teams.attach('design', team.id, owner);
    expect(store.canComment(viewer, 'design')).toBe(true);
    expect(store.canAccess(viewer, 'design', true)).toBe(false);
    store.teams.update(team.id, {status:'archived'}, owner);
    expect(store.canComment(viewer, 'design')).toBe(false);
    store.teams.update(team.id, {status:'active'}, owner);
    store.teams.removeMember(team.id, viewer.id, owner);
    expect(store.canComment(viewer, 'design')).toBe(false);
  });

  it('removes only the team association when its persisted design is deleted',()=>{
    const db=companyTestDatabase();databases.push(db);db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
    const store=new CompanyStore(db),owner=store.upsertLdapUser({entryUUID:'owner',username:'owner'});
    const team=store.teams.create('Team',owner);db.prepare('INSERT INTO projects VALUES (?)').run('design');
    store.teams.attach('design',team.id,owner);db.prepare('DELETE FROM projects WHERE id=?').run('design');
    expect(store.teams.projectTeamId('design')).toBeNull();
    expect(store.teams.get(team.id,owner)?.name).toBe('Team');
  });
  it('inherits team permissions without granting the design creator a personal bypass', () => {
    const { store, owner, editor, viewer } = fixture();
    const team = store.teams.create('Business project', owner);
    store.teams.setMember(team.id, editor.id, 'editor', owner);
    store.teams.setMember(team.id, viewer.id, 'viewer', owner);
    store.teams.attach('design-a', team.id, editor);
    store.teams.attach('design-b', team.id, editor);
    expect(store.canAccess(viewer, 'design-a')).toBe(true);
    expect(store.canAccess(viewer, 'design-a', true)).toBe(false);
    expect(store.canAccess(editor, 'design-b', true)).toBe(true);
    expect(store.canManage(editor, 'design-a')).toBe(false);
    expect(store.canManage(owner, 'design-a')).toBe(true);
    expect(store.projectRole('design-a', editor.id)).toBe('editor');
    expect(store.database.prepare('SELECT * FROM company_project_members WHERE project_id=?').all('design-a')).toEqual([]);
    const revoked: string[] = [];
    store.onRevoke(event => { if (event.userId === editor.id && event.projectId) revoked.push(event.projectId); });
    store.teams.removeMember(team.id, editor.id, owner);
    expect(store.canAccess(editor, 'design-a')).toBe(false);
    expect(revoked.sort()).toEqual(['design-a', 'design-b']);
    expect(() => store.setMember('design-a', editor.id, 'editor', owner.id)).toThrow();
  });
  it('keeps teams and personal projects separate and archives without deleting designs', () => {
    const { store, owner, editor } = fixture();
    const team = store.teams.create('A', owner);
    const other = store.teams.create('B', editor);
    store.teams.attach('team-design', team.id, owner);
    store.registerProjectOwner('personal', editor);
    expect(store.canAccess(editor, 'team-design')).toBe(false);
    expect(() => store.teams.attach('team-design', other.id, editor)).toThrow();
    store.teams.update(team.id, { status: 'archived' }, owner);
    expect(store.canAccess(owner, 'team-design')).toBe(true);
    expect(store.canAccess(owner, 'team-design', true)).toBe(false);
    expect(store.canAccess(editor, 'personal', true)).toBe(true);
    expect(store.teams.projectTeamId('team-design')).toBe(team.id);
  });
  it('accepts complete CAS snapshots, preserves reviewer roles and scopes external IDs', () => {
    const { store, owner, viewer } = fixture();
    const snapshot = { name: 'External', status: 'active' as const, complete: true as const,
      members: [{ entryUUID: 'owner', username: 'owner', role: 'owner' as const }, { entryUUID: 'viewer', username: 'viewer', role: 'viewer' as const }] };
    const team = store.teams.sync('cbrain', 'instance-a', '42', snapshot, 0);
    const other = store.teams.sync('cbrain', 'instance-b', '42', snapshot, 0);
    expect(other.id).not.toBe(team.id);
    expect(store.teams.role(team.id, viewer.id)).toBe('viewer');
    expect(() => store.teams.setMember(team.id, viewer.id, 'admin', owner)).toThrow();
    expect(() => store.teams.sync('cbrain', 'instance-a', '42', { ...snapshot, members: [] }, 0)).toThrow();
    expect(() => store.teams.sync('cbrain', 'instance-a', '42', { ...snapshot, complete: false } as never, team.revision)).toThrow();
    expect(store.teams.role(team.id, owner.id)).toBe('owner');
    expect(store.getUser(viewer.id)?.role).toBe('member');
  });
  it('fails closed after five minutes, revokes tasks, and recovers on a fresh snapshot', () => {
    const { store, owner, editor, advance } = fixture();
    const snapshot = { name: 'External', status: 'active' as const, complete: true as const,
      members: [{ entryUUID: 'owner', username: 'owner', role: 'owner' as const }, { entryUUID: 'editor', username: 'editor', role: 'editor' as const }] };
    let team = store.teams.sync('cbrain', 'a', '42', snapshot, 0);
    store.teams.attach('p', team.id, editor);
    const revoked: string[] = [];
    store.onRevoke(event => { if (event.projectId) revoked.push(event.projectId); });
    advance(300_001); store.teams.expire();
    expect(store.canAccess(editor, 'p')).toBe(false);
    const admin=store.createAdmin('temporary-admin-password');store.changePassword(admin.id,'changed-admin-password');
    expect(store.canAccess(store.getUser(admin.id)!, 'p')).toBe(true);
    expect(store.canAccess(store.getUser(admin.id)!, 'p',true)).toBe(false);
    expect(revoked).toContain('p');
    team = store.teams.sync('cbrain', 'a', '42', snapshot, team.revision);
    expect(store.canAccess(editor, 'p', true)).toBe(true);
    store.teams.sync('cbrain', 'a', '42', { ...snapshot, members: [snapshot.members[0]!] }, team.revision);
    expect(store.canAccess(editor, 'p')).toBe(false);
  });
});
