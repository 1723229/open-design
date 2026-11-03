import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { ensureRailOpen } from '@/playwright/rail';
import { T } from '@/timeouts';
import type { CompanySessionResponse, CompanyTeam } from '@open-design/contracts';

test('[P1] company team entry wins over an older identity cache on the first visit', async ({ page }, testInfo) => {
  await applyStandardMocks(page);
  const session: CompanySessionResponse = {
    enabled: true, teamsEnabled: true,
    user: { id: 'entry-user', username: 'Entry User', role: 'member', mustChangePassword: false },
    csrfToken: 'test-csrf',
    presentation: { showAgentIdentity: false, hiddenSettingsSections: ['labs', 'integrations'] },
  };
  const teams: CompanyTeam[] = ['alpha', 'beta'].map(id => ({
    id, name: `Team ${id}`, source: 'external', externalNamespace: 'cbrain', externalId: id,
    status: 'active', role: 'editor', canWrite: true, canManage: false,
    revision: 1, stale: false, createdAt: 1, updatedAt: 1,
  }));
  await page.route('**/api/company/session', route => route.fulfill({ json: session }));
  await page.route('**/api/company/teams', route => route.fulfill({ json: { teams } }));
  await page.route('**/api/company/resources/context*', route => {
    const teamId = new URL(route.request().url()).searchParams.get('teamId');
    return route.fulfill({ json: { context: {
      identitySource: 'company', workspaceId: teamId ?? 'personal:entry-user',
      workspaceMemberId: 'entry-user', workspaceType: teamId ? 'team' : 'personal',
      role: 'member', memberStatus: 'active', lifecycleState: 'active',
      permissions: { canShareProjects: true, canWriteSyncedFiles: true },
    } } });
  });
  await page.route('**/api/projects*', route => route.fulfill({ json: { projects: [] } }));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('company-entry-seeded')) return;
    sessionStorage.setItem('company-entry-seeded', 'true');
    localStorage.setItem('open-design:workspace-tabs:v1', JSON.stringify({
      scopeKey: 'anon::none', activeTabId: 'entry',
      tabs: [{ id: 'entry', kind: 'entry', view: 'home', createdAt: 1, lastActiveAt: 1 }],
    }));
  });

  await page.goto('/teams/alpha', { waitUntil: 'domcontentloaded' });
  await ensureRailOpen(page);
  const switcher = page.getByTestId('workspace-switcher');
  await expect(switcher).toHaveAccessibleName('Team alpha', { timeout: T.long });
  await expect(page).toHaveURL(/\/teams\/alpha$/);
  await testInfo.attach('first-entry', { body: await page.screenshot(), contentType: 'image/png' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(switcher).toHaveAccessibleName('Team alpha', { timeout: T.long });

  await switcher.click();
  await page.getByRole('menuitem', { name: 'Team beta', exact: true }).click();
  await expect(switcher).toHaveAccessibleName('Team beta');
  await expect(page).toHaveURL(/\/teams\/beta\/home$/);
  await testInfo.attach('team-switch', { body: await page.screenshot(), contentType: 'image/png' });
  await switcher.click();
  await page.getByRole('menuitem', { name: /Personal space|个人空间/ }).click();
  await expect(switcher).toHaveAccessibleName(/Personal space|个人空间/);
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/teams/alpha', { waitUntil: 'domcontentloaded' });
  await expect(switcher).toHaveAccessibleName('Team alpha', { timeout: T.long });
  await testInfo.attach('reenter-from-personal', { body: await page.screenshot(), contentType: 'image/png' });
});
