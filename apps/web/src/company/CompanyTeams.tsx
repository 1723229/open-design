import { useEffect, useState } from 'react';
import { Button, Dialog } from '@open-design/components';
import type { CompanyTeam, CompanyTeamResponse, CompanyTeamRole, CompanyTeamsResponse, CompanyUsersResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import { navigate, useRoute } from '../router';
import { companyRequest, useCompany } from './CompanyProvider';
import { EntryWorkspaceSwitcher } from '../components/EntryWorkspaceSwitcher';
import { Icon } from '../components/Icon';
import styles from './company.module.css';

export function CompanyTeamsSwitcher({onTeamResolved}: {onTeamResolved?: (team: CompanyTeam | null) => void}) {
  const company = useCompany(), t = useT(), route = useRoute();
  const selected = route.kind === 'home' ? route.companyTeamId : undefined;
  const [teams,setTeams] = useState<CompanyTeam[]>([]);
  const [error,setError] = useState(false), [attempt,setAttempt] = useState(0);
  const [dialog,setDialog] = useState<'create'|'members'|null>(null);
  const [open,setOpen] = useState(false);
  const [loading,setLoading] = useState(true);
  const team = teams.find(item => item.id === selected) ?? null;
  useEffect(() => {
    if (!company.enabled || !company.teamsEnabled) return;
    let active = true;
    setLoading(true);
    onTeamResolved?.(null);
    const refresh = () => { void companyRequest<CompanyTeamsResponse>('/api/company/teams').then(value => {
      if (active) {setTeams(value.teams);setLoading(false);setError(false);onTeamResolved?.(value.teams.find(item => item.id === selected) ?? null);}
    }).catch(() => {if(active) {setLoading(false);setError(true);onTeamResolved?.(null);}}); };
    refresh(); const timer = window.setInterval(refresh,30_000);
    return () => {active=false;window.clearInterval(timer);};
  },[company.enabled,company.teamsEnabled,selected,attempt,onTeamResolved]);
  if (!company.enabled || !company.teamsEnabled) return null;
  return <>
    <EntryWorkspaceSwitcher name={selected ? team?.name ?? t(loading ? 'common.loading':'company.teamUnavailable') : t('company.personalSpace')}
      activeId={selected ?? ''} items={[{id:'',name:t('company.personalSpace')},...teams.map(item=>({id:item.id,name:item.name}))]}
      open={open} onOpenChange={setOpen} onSelect={id=>{setOpen(false);navigate({kind:'home',view:'home',...(id ? {companyTeamId:id} : {})});}}>
      {team && <button type="button" role="menuitem" className="entry-nav-rail__menu-item" onClick={()=>{setOpen(false);setDialog('members');}}><Icon name="users" size={15}/>{t('company.teamMembers')}</button>}
      <button type="button" role="menuitem" className="entry-nav-rail__menu-item" onClick={()=>{setOpen(false);setDialog('create');}}><Icon name="plus" size={15}/>{t('company.createTeam')}</button>
    </EntryWorkspaceSwitcher>
    {team && !team.canWrite && <p className={styles.spaceNotice} role="status">{t('company.teamReadOnly')}</p>}
    {(error || (!loading && selected && !team)) && <p className={styles.spaceNotice} role={error ? 'alert':'status'}>{t(error ? 'company.loadError':'company.teamUnavailable')} <Button variant="ghost" onClick={() => setAttempt(value=>value+1)}>{t('company.retry')}</Button></p>}
    {dialog && <CompanyTeamDialog teamId={dialog==='members' ? selected : undefined} onClose={() => {setDialog(null);setAttempt(value=>value+1);}} onCreated={created => {setTeams(value=>[...value,created]);setDialog(null);navigate({kind:'home',view:'projects',companyTeamId:created.id});}} />}
  </>;
}

function CompanyTeamDialog({teamId,onClose,onCreated}: {teamId?:string;onClose:()=>void;onCreated:(team:CompanyTeam)=>void}) {
  const t=useT();
  const [data,setData]=useState<CompanyTeamResponse|null>(null),[users,setUsers]=useState<CompanyUsersResponse['users']>([]);
  const [name,setName]=useState(''),[userId,setUserId]=useState(''),[role,setRole]=useState<Exclude<CompanyTeamRole,'owner'>>('editor');
  const [busy,setBusy]=useState(false),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  const path=`/api/company/teams/${encodeURIComponent(teamId ?? '')}`;
  const editable=data?.team.source==='local' && data.team.canManage;
  useEffect(()=>{
    if (!teamId) return;
    let active=true;
    void companyRequest<CompanyTeamResponse>(path).then(async value=>{
      if (!active) return;
      setData(value);setName(value.team.name);setError(false);
      if(value.team.source==='local' && value.team.canManage) {
        const directory=await companyRequest<CompanyUsersResponse>('/api/company/users');if(active)setUsers(directory.users);
      }
    }).catch(()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[teamId,path,attempt]);
  async function mutate(endpoint:string,method:string,body?:unknown) {
    setBusy(true);setError(false);
    try {
      const value=await companyRequest<CompanyTeamResponse>(endpoint,{method,headers:{'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)}:{})});
      if(!teamId) onCreated(value.team);else {setAttempt(value=>value+1);setUserId('');}
    } catch {setError(true);} finally {setBusy(false);}
  }
  const title=t(teamId ? 'company.teamMembers':'company.createTeam');
  return <Dialog className={styles.dialog} ariaLabel={title} onClose={onClose} closeOnEscape closeOnBackdrop>
    <div className={styles.toolbar}><h2>{title}</h2><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button></div>
    {error && <p role="alert">{t('company.loadError')} <Button onClick={()=>setAttempt(value=>value+1)}>{t('company.retry')}</Button></p>}
    {!teamId || editable ? <form className={styles.sharing} onSubmit={event=>{event.preventDefault();void mutate(teamId ? path:'/api/company/teams',teamId ? 'PATCH':'POST',{name});}}>
      <label>{t('company.teamName')}<input required maxLength={200} value={name} onChange={event=>setName(event.target.value)} /></label>
      <Button type="submit" disabled={busy || !name.trim()}>{t(teamId ? 'common.save':'company.createTeam')}</Button>
      {editable && <Button variant="ghost" disabled={busy} onClick={()=>{void mutate(path,'PATCH',{status:data.team.status==='active' ? 'archived':'active'});}}>{t(data.team.status==='active' ? 'company.archiveTeam':'company.restoreTeam')}</Button>}
    </form> : data ? <h3>{data.team.name}</h3> : <p role="status">{t('common.loading')}</p>}
    {data?.team.source==='external' && <p>{t('company.inheritedTeam')} {data.team.sourceUrl && <a href={data.team.sourceUrl} target="_blank" rel="noopener noreferrer">{t('company.manageAtSource')}</a>}</p>}
    <div className={styles.rows}>{data?.members.map(member=><div className={styles.row} key={member.userId}>
      <span>{member.username}</span>
      {editable && member.role!=='owner' ? <>
        <select aria-label={`${member.username} ${t('company.role')}`} value={member.role} disabled={busy} onChange={event=>{void mutate(`${path}/members`,'PUT',{userId:member.userId,role:event.target.value});}}>
          <option value="admin">{t('company.admin')}</option><option value="editor">{t('company.editor')}</option><option value="viewer">{t('company.viewer')}</option>
        </select>
        <Button variant="ghost" disabled={busy} onClick={()=>{void mutate(`${path}/members/${encodeURIComponent(member.userId)}`,'DELETE');}}>{t('company.removeMember')}</Button>
      </> : <span>{t(`company.${member.role}`)}</span>}
    </div>)}</div>
    {editable && <form className={styles.sharing} onSubmit={event=>{event.preventDefault();void mutate(`${path}/members`,'PUT',{userId,role});}}>
      <label>{t('company.member')}<select value={userId} required onChange={event=>setUserId(event.target.value)}><option value="">{t('company.selectUser')}</option>{users.filter(user=>!user.disabled && !data.members.some(member=>member.userId===user.id)).map(user=><option key={user.id} value={user.id}>{user.username}</option>)}</select></label>
      <label>{t('company.role')}<select value={role} onChange={event=>setRole(event.target.value as Exclude<CompanyTeamRole,'owner'>)}><option value="editor">{t('company.editor')}</option><option value="viewer">{t('company.viewer')}</option><option value="admin">{t('company.admin')}</option></select></label>
      <Button type="submit" disabled={busy || !userId}>{t('company.addMember')}</Button>
    </form>}
  </Dialog>;
}
