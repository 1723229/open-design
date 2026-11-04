/** Company authentication and project sharing contracts. */
import type {WorkspaceCollabContext} from './collab.js';
export type CompanyRole = 'admin' | 'member';
export type CompanyProjectRole = 'owner' | 'editor' | 'viewer';

export interface CompanySessionUser {
  id: string;
  username: string;
  displayName?: string;
  role: CompanyRole;
  mustChangePassword: boolean;
}

export interface CompanyUser extends CompanySessionUser {
  source: 'local' | 'ldap';
  disabled: boolean;
}

export interface CompanyPresentation {
  showAgentIdentity: boolean;
  hiddenSettingsSections: string[];
}

export interface CompanySessionResponse {
  enabled: boolean;
  teamsEnabled?: boolean;
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
export interface CompanyProjectMember { userId: string; username: string; displayName?: string; role: CompanyProjectRole }
export interface CompanyProjectAccess { canWrite: boolean; canComment: boolean; canManage: boolean; ownerUserId: string | null }
export interface CompanyProjectMembersResponse { members: CompanyProjectMember[]; canManage: boolean; team?: CompanyTeam; canWrite?: boolean; canComment?: boolean; ownerUserId?: string | null }
export interface CompanyProjectMemberRequest { userId: string; role: CompanyProjectRole }
export interface CompanyProjectMoveRequest { companyTeamId: string | null }
export interface CompanyProjectMoveResponse { projectId: string; companyTeamId: string | null }
export interface CompanyResourceContextResponse { context: WorkspaceCollabContext }
export interface CompanyTaskStatusResponse {
  limits: {global:number;perUser:number;perProject:1};
  usage: {globalRunning:number;userRunning:number;userQueued:number};
  tasks: Array<{jobId:string;projectId:string;projectName?:string;runId:string|null;state:'queued'|'running';createdAt:number}>;
}

export type CompanyTeamRole = 'owner' | 'admin' | 'editor' | 'viewer';
export interface CompanyTeam {
  id: string;
  name: string;
  status: 'active' | 'archived' | 'disabled';
  source: 'local' | 'external';
  revision: number;
  role: CompanyTeamRole | null;
  canManage: boolean;
  canWrite: boolean;
  stale: boolean;
  sourceUrl?: string;
  confirmedAt?: number;
}
export interface CompanyTeamMember { userId: string; username: string; displayName?: string; role: CompanyTeamRole }
export interface CompanyTeamsResponse { teams: CompanyTeam[] }
export interface CompanyTeamResponse { team: CompanyTeam; members: CompanyTeamMember[] }
export interface CompanyTeamCreateRequest { name: string }
export interface CompanyTeamUpdateRequest { name?: string; status?: 'active' | 'archived' }
export interface CompanyTeamMemberRequest { userId: string; role: Exclude<CompanyTeamRole, 'owner'> }
/** Server-to-server v1 snapshot. Source-local accounts never become LDAP identities. */
export interface CompanyTeamSnapshot {
  name: string;
  status: 'active' | 'archived' | 'disabled';
  complete: true;
  sourceUrl?: string;
  members: Array<{ entryUUID: string; username: string; displayName?: string; role: CompanyTeamRole }>;
}
export interface CompanyTeamMapping {
  teamId: string; namespace: string; externalId: string; revision: number;
}
export interface CompanyTeamSyncRequest extends CompanyTeamSnapshot {
  namespace: string; externalId: string; expectedRevision: number;
}
export interface CompanyIntegrationCodeRequest {
  state: string; teamId: string; entryUUID: string;
}
