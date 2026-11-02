import { useEffect, useState } from 'react';
import type { CompanyProjectMembersResponse } from '@open-design/contracts';
import { companyRequest, useCompany } from './CompanyProvider';

export const COMPANY_MEMBERS_CHANGED_EVENT = 'open-design:company-members-changed';

/** Reuse the workbench's existing read-only behavior for company viewers. */
export function useCompanyProjectReadOnly(projectId: string | null) {
  const company = useCompany();
  const userId = company.user?.id;
  const [access, setAccess] = useState<{ projectId: string; userId: string; readOnly: boolean } | null>(null);
  useEffect(() => {
    if (!company.isMember || !userId || !projectId) return;
    let active = true;
    let version = 0;
    const refresh = () => {
      const current = ++version;
      void companyRequest<CompanyProjectMembersResponse>(`/api/company/projects/${encodeURIComponent(projectId)}/members`)
        .then(value => {
          const role = value.members.find(member => member.userId === userId)?.role;
          if (active && current === version) setAccess({ projectId, userId, readOnly: role !== 'owner' && role !== 'editor' });
        }).catch(() => {
          if (active && current === version) setAccess({ projectId, userId, readOnly: true });
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
  }, [company.isMember, userId, projectId]);
  return company.isMember && (!access || access.projectId !== projectId || access.userId !== userId || access.readOnly);
}
