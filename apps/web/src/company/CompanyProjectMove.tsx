import {useEffect,useState} from 'react';
import type {CompanyTeam,CompanyTeamsResponse,Project} from '@open-design/contracts';
import {MoveToTeamConfirmDialog} from '../components/MoveToTeamConfirmDialog';
import {companyRequest,useCompany} from './CompanyProvider';
import {COMPANY_MEMBERS_CHANGED_EVENT} from './useCompanyProjectReadOnly';
import {useT} from '../i18n';
import {Icon} from '../components/Icon';

export const COMPANY_PROJECT_MOVED_EVENT='nexus:project-moved';

export function CompanyProjectMoveMenuItem({project,onRequest}:{project:Project;onRequest:(project:Project)=>void}) {
  const company=useCompany(),t=useT();
  if(!company.enabled || !company.teamsEnabled || !project.companyAccess?.canManage) return null;
  return <button type="button" role="menuitem" onClick={event=>{event.stopPropagation();onRequest(project);}}>
    <Icon name={project.companyTeamId?'close':'share'} size={14}/><span>{t(project.companyTeamId?'recentProjects.moveOutOfTeam':'recentProjects.moveToTeam')}</span>
  </button>;
}

/** Local ownership adapter around the original project-move confirmation. */
export function useCompanyProjectMove(onMoved?:()=>void|Promise<void>) {
  const company=useCompany();
  const [target,setTarget]=useState<Project|null>(null);
  return {
    request(project:Project) {
      if(company.enabled && company.teamsEnabled && project.companyAccess?.canManage) setTarget(project);
    },
    dialog:target ? <CompanyProjectMoveDialog project={target} onClose={()=>setTarget(null)} onMoved={()=>{
      setTarget(null);
      window.dispatchEvent(new Event(COMPANY_MEMBERS_CHANGED_EVENT));
      window.dispatchEvent(new Event(COMPANY_PROJECT_MOVED_EVENT));
      void onMoved?.();
    }}/> : null,
  };
}

function CompanyProjectMoveDialog({project,onClose,onMoved}:{project:Project;onClose:()=>void;onMoved:()=>void}) {
  const t=useT(),toTeam=!project.companyTeamId;
  const [teams,setTeams]=useState<CompanyTeam[]>([]),[teamId,setTeamId]=useState('');
  const [pending,setPending]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{
    if(!toTeam) return;
    let active=true;
    void companyRequest<CompanyTeamsResponse>('/api/company/teams').then(value=>{
      if(active) setTeams(value.teams.filter(team=>team.canWrite));
    }).catch(()=>{if(active)setError(t('company.loadError'));});
    return()=>{active=false;};
  },[toTeam,t]);
  async function confirm() {
    setPending(true);setError(null);
    try {
      await companyRequest(`/api/company/projects/${encodeURIComponent(project.id)}/move`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyTeamId:toTeam?teamId:null})});
      onMoved();
    } catch(error) {setError(error instanceof Error?error.message:t('company.loadError'));}
    finally {setPending(false);}
  }
  return <MoveToTeamConfirmDialog action={toTeam?'to-team':'to-personal'} onCancel={onClose} onConfirm={()=>void confirm()}
    pending={pending} confirmDisabled={toTeam && !teamId} error={error} allowSkip={false}
    description={t(toTeam?'company.moveToTeamDescription':'company.moveToPersonalDescription')}>
    {toTeam && <label>{t('recentProjects.moveToTeam')}<select value={teamId} disabled={pending} onChange={event=>setTeamId(event.target.value)}>
      <option value="">{t('company.teamName')}</option>{teams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}
    </select></label>}
  </MoveToTeamConfirmDialog>;
}
