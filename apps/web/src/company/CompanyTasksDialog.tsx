import {useEffect,useState} from 'react';
import {Button,Dialog} from '@open-design/components';
import type {CompanyTaskStatusResponse} from '@open-design/contracts';
import {useT} from '../i18n';
import {buildPath,navigate} from '../router';
import {ProjectRunStatusIcon} from '../components/ProjectRunStatusIcon';
import {companyRequest} from './CompanyProvider';
import styles from './company.module.css';

/** Capacity for local execution; project status and stop controls stay on their original surfaces. */
export function CompanyTasksDialog({onClose}:{onClose:()=>void}) {
  const t=useT();
  const [status,setStatus]=useState<CompanyTaskStatusResponse|null>(null);
  const [error,setError]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;
    const refresh=()=>{void companyRequest<CompanyTaskStatusResponse>('/api/company/tasks').then(value=>{
      if(active) {setStatus(value);setError(false);}
    }).catch(()=>{if(active) {setStatus(null);setError(true);}});};
    refresh();const timer=window.setInterval(refresh,4000);window.addEventListener('focus',refresh);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[attempt]);
  return <Dialog className={styles.dialog} ariaLabel={t('company.tasks')} onClose={onClose} closeOnEscape closeOnBackdrop>
    <div className={styles.toolbar}><h2>{t('company.tasks')}</h2><Button variant="ghost" onClick={onClose}>{t('common.close')}</Button></div>
    {error?<p role="alert">{t('company.loadError')} <Button onClick={()=>setAttempt(value=>value+1)}>{t('company.retry')}</Button></p>
      :!status?<p role="status">{t('common.loading')}</p>:<>
        <p>{t('company.taskUserUsage',{running:status.usage.userRunning,limit:status.limits.perUser,queued:status.usage.userQueued})}</p>
        <p>{t('company.taskGlobalUsage',{running:status.usage.globalRunning,limit:status.limits.global})}</p>
        <p>{t('company.taskProjectLimit')}</p>
        <div className={styles.rows}>{status.tasks.map(task=>{
          const route={kind:'project' as const,projectId:task.projectId,fileName:null};
          return <div className={styles.row} key={task.jobId}>
            <ProjectRunStatusIcon status={task.state} label={t(task.state==='queued'?'designs.status.queued':'designs.status.running')}/>
            <a href={buildPath(route)} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(route);onClose();}}}>{task.projectName??task.projectId}</a>
            <span>{t(task.state==='queued'?'designs.status.queued':'designs.status.running')}</span>
          </div>;
        })}</div>
        {status.tasks.length===0&&<p>{t('company.noActiveTasks')}</p>}
      </>}
  </Dialog>;
}
