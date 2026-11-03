import { useEffect, useState } from 'react';
import type { CompanyProjectMembersResponse } from '@open-design/contracts';
import { companyRequest, useCompany } from './CompanyProvider';

export const COMPANY_MEMBERS_CHANGED_EVENT = 'open-design:company-members-changed';

/** Reuse the workbench's read-only behavior for viewers and archived teams. */
export function useCompanyProjectAccess(projectId: string | null) {
  const company = useCompany();
  const userId = company.user?.id;
  const [access, setAccess] = useState<{ projectId: string; userId: string; readOnly: boolean; details: CompanyProjectMembersResponse | null } | null>(null);
  useEffect(() => {
    if (!company.enabled || !userId || !projectId) return;
    let active = true;
    let version = 0;
    const refresh = () => {
      const current = ++version;
      void companyRequest<CompanyProjectMembersResponse>(`/api/company/projects/${encodeURIComponent(projectId)}/members`)
        .then(value => {
          const role = value.members.find(member => member.userId === userId)?.role;
          if (active && current === version) setAccess({ projectId, userId, details:value, readOnly: value.canWrite !== undefined ? !value.canWrite : company.user?.role !== 'admin' && role !== 'owner' && role !== 'editor' });
        }).catch(() => {
          if (active && current === version) setAccess({ projectId, userId, readOnly: true, details:null });
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener(COMPANY_MEMBERS_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(COMPANY_MEMBERS_CHANGED_EVENT, refresh);
    };
  }, [company.enabled, company.user?.role, userId, projectId]);
  const current=access?.projectId===projectId && access?.userId===userId ? access : null;
  return {
    readOnly:company.enabled && Boolean(userId) && (!current || current.readOnly),
    canComment:current?.details?.canComment === true,
    canManage:Boolean(current?.details?.team ? current.details.team.canManage && !current.readOnly : current?.details?.canManage),
    ownerUserId:current?.details?.ownerUserId ?? null,
    team:current?.details?.team ?? null,
  };
}

export function useCompanyProjectReadOnly(projectId: string | null) {
  return useCompanyProjectAccess(projectId).readOnly;
}
