import { SHOW_LANGUAGE_SELECTOR } from '../product';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from '@open-design/components';
import type { CompanyProjectMembersResponse, CompanyUsersResponse, CompanyUserUpdateRequest } from '@open-design/contracts';
import { LOCALES, LOCALE_LABEL, useI18n, useT, type Locale } from '../i18n';
import { buildPath, useRoute } from '../router';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { companyRequest, useCompany } from './CompanyProvider';
import { COMPANY_MEMBERS_CHANGED_EVENT } from './useCompanyProjectReadOnly';
import { SharePanelHeader } from '../components/share/SharePanelHeader';
import { SharePublishedLinkControls } from '../components/share/ShareTab';
import { ShareNoticeRow } from '../components/share/ShareNoticeRow';
import { ShareErrorRow } from '../components/share/ShareErrorRow';
import { ShareButton } from '../components/share/ShareButton';
import styles from './company.module.css';
import {CompanyTasksDialog} from './CompanyTasksDialog';
import { companyUserLabel } from './user-label';

export function CompanyAccountMenu() {
  const company = useCompany();
  const t = useT();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'users' | 'sharing' | 'tasks' | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  if (!company.enabled || !company.user) return null;
  return <div className={styles.account} ref={ref}>
    <Button ref={trigger} variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>{companyUserLabel(company.user)}</Button>
    {open && <div className={styles.menu} role="menu" aria-label={companyUserLabel(company.user)}>
      <Button variant="ghost" role="menuitem" onClick={()=>{setDialog('tasks');setOpen(false);}}>{t('company.tasks')}</Button>
      {company.user.role === 'admin' && <Button variant="ghost" role="menuitem" onClick={() => { setDialog('users'); setOpen(false); }}>{t('company.users')}</Button>}
      {route.kind === 'project' && <Button variant="ghost" role="menuitem" onClick={() => { setDialog('sharing'); setOpen(false); }}>{t('company.sharing')}</Button>}
      <Button variant="ghost" role="menuitem" onClick={() => { setError(false); void company.logout().catch(() => setError(true)); }}>{t('company.logout')}</Button>
      {error && <p role="alert">{t('company.saveError')}</p>}
    </div>}
    {dialog === 'users' && <CompanyUsersDialog currentUserId={company.user.id} allowCreate={company.authMode === 'local'} onClose={() => setDialog(null)} />}
    {dialog === 'tasks' && <CompanyTasksDialog onClose={()=>setDialog(null)}/>}
    {dialog === 'sharing' && route.kind === 'project' && <CompanySharingDialog key={route.projectId} projectId={route.projectId} onClose={() => setDialog(null)} />}
  </div>;
}

function CompanyDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  return <Dialog className={styles.dialog} ariaLabel={title} onClose={onClose} closeOnEscape closeOnBackdrop>
    <div className={styles.toolbar}><h2>{title}</h2><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button></div>
    {children}
  </Dialog>;
}

export function CompanyUsersDialog({ currentUserId, onClose, allowCreate = false }: { currentUserId: string; onClose: () => void; allowCreate?: boolean }) {
  const t = useT();
  const [users, setUsers] = useState<CompanyUsersResponse['users'] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    let active = true;
    setError(false);
    void companyRequest<CompanyUsersResponse>('/api/company/users').then(value => { if (active) setUsers(value.users); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  async function updateUser(id: string, changes: CompanyUserUpdateRequest) {
    setBusy(true); setError(false);
    try {
      await companyRequest(`/api/company/users/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setUsers((await companyRequest<CompanyUsersResponse>('/api/company/users')).users);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  async function createUser() {
    setBusy(true); setError(false);
    try {
      await companyRequest('/api/company/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role: 'member' }) });
      setUsername(''); setPassword('');
      setUsers((await companyRequest<CompanyUsersResponse>('/api/company/users')).users);
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <CompanyDialog title={t('company.users')} onClose={onClose}>
    {error && <p role="alert">{t('company.loadError')} <Button onClick={() => setAttempt(value => value + 1)}>{t('company.retry')}</Button></p>}
    {!users && !error && <p role="status">{t('common.loading')}</p>}
    <div className={styles.rows}>{users?.map(user => <div className={styles.row} key={user.id}>
      <span>{companyUserLabel(user)}</span>
      {user.id === currentUserId || user.username.toLowerCase() === 'admin'
        ? <span>{t(user.role === 'admin' ? 'company.admin' : 'company.member')}</span>
        : <select aria-label={`${t('company.role')}: ${companyUserLabel(user)}`} value={user.role} disabled={busy} onChange={event => { void updateUser(user.id, { role: event.target.value as 'admin' | 'member' }); }}>
          <option value="member">{t('company.member')}</option><option value="admin">{t('company.admin')}</option>
        </select>}
      <span>{t(user.disabled ? 'company.disabled' : 'company.enabled')}</span>
      {user.id !== currentUserId && <Button variant="ghost" disabled={busy} onClick={() => { void updateUser(user.id, { disabled: !user.disabled }); }}>{t(user.disabled ? 'company.enable' : 'company.disable')}</Button>}
    </div>)}</div>
    {allowCreate && <form className={styles.sharing} onSubmit={event => { event.preventDefault(); void createUser(); }}>
      <label>{t('company.username')}<input value={username} onChange={event => setUsername(event.target.value)} required autoComplete="off" /></label>
      <label>{t('company.temporaryPassword')}<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="new-password" minLength={12} required /></label>
      <Button type="submit" disabled={busy || !username || password.length < 12}>{t('company.createUser')}</Button>
      <p>{t('company.localUserHint')}</p>
    </form>}
  </CompanyDialog>;
}

export function CompanySharingDialog({ projectId, fileName, onClose }: { projectId: string; fileName?: string; onClose: () => void }) {
  const t = useT();
  const route = useRoute();
  const currentRoute = route.kind === 'project' && route.projectId === projectId ? route : null;
  const shareUrl = `${typeof window === 'undefined' ? '' : window.location.origin}${buildPath({ kind: 'project', projectId, fileName: fileName ?? currentRoute?.fileName ?? null, conversationId: currentRoute?.conversationId })}`;
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);
  const copying = useRef(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [membership, setMembership] = useState<CompanyProjectMembersResponse | null>(null);
  const [users, setUsers] = useState<CompanyUsersResponse['users']>([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  const [error, setError] = useState<'load' | 'save' | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const path = `/api/company/projects/${encodeURIComponent(projectId)}/members`;
  const canManage = membership?.canManage && !membership.team;
  useEffect(() => {
    let active = true;
    setError(null);
    setMembership(null);
    setUsers([]);
    setUserId('');
    setCopyState(null);
    void (async () => {
      const value = await companyRequest<CompanyProjectMembersResponse>(path);
      if (!active) return;
      setMembership(value);
      if (value.canManage && !value.team) {
        const directory = await companyRequest<CompanyUsersResponse>('/api/company/users');
        if (active) setUsers(directory.users);
      }
    })().catch(() => { if (active) setError('load'); });
    return () => { active = false; };
  }, [path, attempt]);
  async function mutate(memberId: string, memberRole?: 'viewer' | 'editor') {
    if (!canManage || busy) return;
    setBusy(true); setError(null);
    try {
      await companyRequest(memberRole ? path : `${path}/${encodeURIComponent(memberId)}`, { method: memberRole ? 'PUT' : 'DELETE', headers: { 'Content-Type': 'application/json' }, ...(memberRole ? { body: JSON.stringify({ userId: memberId, role: memberRole }) } : {}) });
      setMembership(await companyRequest<CompanyProjectMembersResponse>(path));
      window.dispatchEvent(new Event(COMPANY_MEMBERS_CHANGED_EVENT));
      setUserId('');
    } catch { setError('save'); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    if (copying.current) return;
    copying.current = true;
    setCopyBusy(true);
    try { setCopyState(await copyToClipboard(shareUrl) ? 'copied' : 'failed'); }
    finally { copying.current = false; setCopyBusy(false); }
  }
  return <Dialog className={`chrome-unified-popover chrome-unified-popover--share ${styles.shareDialog}`} ariaLabel={t('company.sharing')} onClose={onClose} closeOnEscape closeOnBackdrop>
    <SharePanelHeader title={t('company.sharing')} closeLabel={t('common.close')} onClose={onClose} />
    {error && <div className={styles.shareError}>
      <ShareErrorRow message={t(error === 'load' ? 'company.loadError' : 'company.saveError')} role="alert" />
      {error === 'load' && <ShareButton variant="soft" onClick={() => setAttempt(value => value + 1)}>{t('company.retry')}</ShareButton>}
    </div>}
    {!membership && !error && <p role="status">{t('common.loading')}</p>}
    {membership && <>
      <ShareNoticeRow message={t('company.shareLinkHint')} />
      <SharePublishedLinkControls url={shareUrl} copying={copyBusy} feedback={copyState} onCopy={() => { void copyLink(); }} t={t} />
      <section className={styles.shareMembers} aria-label={t('company.member')}>
      {membership.team && <p className={styles.shareTeam}>{t('company.inheritedTeam')} <a href={buildPath({kind:'home',view:'projects',companyTeamId:membership.team.id})}>{membership.team.name}</a></p>}
      {membership.members.map(member => <div className={styles.shareMember} key={member.userId}>
      <span>{companyUserLabel(member)}</span>
      {canManage && member.role !== 'owner' ? <>
        <select aria-label={`${companyUserLabel(member)} ${t('company.role')}`} value={member.role} disabled={busy} onChange={event => { void mutate(member.userId, event.target.value as 'viewer' | 'editor'); }}>
          <option value="viewer">{t('company.viewer')}</option><option value="editor">{t('company.editor')}</option>
        </select>
        <Button variant="ghost" disabled={busy} onClick={() => { void mutate(member.userId); }}>{t('company.removeMember')}</Button>
      </> : <span>{t(member.role === 'owner' ? 'company.owner' : member.role === 'editor' ? 'company.editor' : 'company.viewer')}</span>}
      </div>)}
      </section>
      {canManage && <form className={styles.shareInvite} onSubmit={event => { event.preventDefault(); if (userId) void mutate(userId, role); }}>
        <label>{t('company.member')}<select value={userId} required disabled={busy} onChange={event => setUserId(event.target.value)}><option value="">{t('company.selectUser')}</option>{users.filter(user => !user.disabled && !membership.members.some(member => member.userId === user.id)).map(user => <option key={user.id} value={user.id}>{companyUserLabel(user)}</option>)}</select></label>
        <label>{t('company.role')}<select value={role} disabled={busy} onChange={event => setRole(event.target.value as 'viewer' | 'editor')}><option value="viewer">{t('company.viewer')}</option><option value="editor">{t('company.editor')}</option></select></label>
        <ShareButton variant="primary" hoverLighten={false} type="submit" disabled={busy || !userId} aria-busy={busy}>{t('company.addMember')}</ShareButton>
      </form>}
    </>}
  </Dialog>;
}

export function CompanyMemberSettings({ presentation = 'modal', onClose }: { presentation?: 'page' | 'modal'; onClose: () => void }) {
  const { t, locale, setLocale } = useI18n();
  const content = <><h2>{t('settings.general')}</h2><p>{t('company.managedSettings')}</p>{SHOW_LANGUAGE_SELECTOR ? <label>{t('settings.language')}<select value={locale} onChange={event => setLocale(event.target.value as Locale)}>{LOCALES.map(value => <option key={value} value={value}>{LOCALE_LABEL[value]}</option>)}</select></label> : null}<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button></>;
  return presentation === 'page' ? <section className={styles.panel} role="region" aria-label={t('settings.general')}>{content}</section> : <Dialog className={styles.panel} ariaLabel={t('settings.general')} onClose={onClose} closeOnEscape>{content}</Dialog>;
}
