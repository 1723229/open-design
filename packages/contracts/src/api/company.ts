/** Company authentication and project sharing contracts. */
export type CompanyRole = 'admin' | 'member';
export type CompanyProjectRole = 'owner' | 'editor' | 'viewer';

export interface CompanySessionUser {
  id: string;
  username: string;
  role: CompanyRole;
  mustChangePassword: boolean;
}

export interface CompanyUser extends CompanySessionUser {
  source: 'local' | 'ldap';
  disabled: boolean;
  displayName?: string;
}

export interface CompanyPresentation {
  showAgentIdentity: boolean;
  hiddenSettingsSections: string[];
}

export interface CompanySessionResponse {
  enabled: boolean;
  authMode?: 'local' | 'ldap';
  user: CompanySessionUser | null;
  presentation: CompanyPresentation;
  csrfToken?: string;
}

export interface CompanyLoginRequest { username: string; password: string }
export interface CompanyPasswordRequest { currentPassword: string; newPassword: string }
export interface CompanyUsersResponse { users: CompanyUser[] }
export interface CompanyUserUpdateRequest { role?: CompanyRole; disabled?: boolean }
export interface CompanyCreateLocalUserRequest { username: string; password: string; role?: CompanyRole }
export interface CompanyProjectMember { userId: string; username: string; role: CompanyProjectRole }
export interface CompanyProjectMembersResponse { members: CompanyProjectMember[]; canManage: boolean }
export interface CompanyProjectMemberRequest { userId: string; role: CompanyProjectRole }
