import {createContext,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
import type {CompanyResourceContextResponse} from '@open-design/contracts';
import {useRoute} from '../router';
import {useWorkspaceContext,type WorkspaceContextState} from '../collab/useWorkspaceContext';
import {workspaceIdentityCacheKey} from '../collab/workspace-identity';
import {companyRequest,useCompany} from './CompanyProvider';

const ResourceContext=createContext<WorkspaceContextState|null>(null);

/** Company identity is adapted only for resource components, independently of cloud login and billing. */
export function CompanyResourceProvider({children}:{children:ReactNode}) {
  const company=useCompany(),route=useRoute();
  const query=new URLSearchParams();
  if('companyTeamId' in route && route.companyTeamId) query.set('teamId',route.companyTeamId);
  if(route.kind==='project') query.set('projectId',route.projectId);
  if(route.kind==='design-system-detail') {query.set('kind','design_system');query.set('resourceId',route.designSystemId);}
  if(route.kind==='marketplace-detail') {query.set('kind','plugin');query.set('resourceId',route.pluginId);}
  const key=`${company.user?.id ?? ''}:${query}`;
  const endpoint=`/api/company/resources/context${query.size?`?${query}`:''}`;
  const [resolved,setResolved]=useState<{key:string;state:WorkspaceContextState}|null>(null);
  useEffect(()=>{
    if(!company.enabled || !company.user) return;
    let active=true;
    const refresh=()=>{void companyRequest<CompanyResourceContextResponse>(endpoint).then(value=>{
      if(!value.context || value.context.identitySource!=='company' || value.context.workspaceMemberId!==company.user!.id) throw new Error('Invalid resource context');
      if(active) setResolved({key,state:{context:value.context,loading:false,identityChangePending:false,
        resourceReadIdentity:{context:value.context,generation:`${key}:${workspaceIdentityCacheKey(value.context)}`}}});
    }).catch(()=>{if(active)setResolved({key,state:{context:null,loading:false,failure:'unavailable',resourceReadIdentity:null}});});};
    refresh();const timer=window.setInterval(refresh,30_000);window.addEventListener('focus',refresh);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[company.enabled,company.user?.id,key,endpoint]);
  const state=useMemo<WorkspaceContextState>(()=>resolved?.key===key?resolved.state:{context:null,loading:true,identityChangePending:true,resourceReadIdentity:null},[resolved,key]);
  return <ResourceContext.Provider value={company.enabled?state:null}>{children}</ResourceContext.Provider>;
}

export function useResourceWorkspaceContext():WorkspaceContextState {
  const cloud=useWorkspaceContext(),local=useContext(ResourceContext),company=useCompany();
  return company.enabled ? local ?? {context:null,loading:true,identityChangePending:true,resourceReadIdentity:null} : cloud;
}
