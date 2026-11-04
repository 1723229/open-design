// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignsTab } from '../../src/components/DesignsTab';
import { deleteLiveArtifact, fetchLiveArtifacts } from '../../src/providers/registry';
import type { LiveArtifactSummary, Project } from '../../src/types';

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: null, loading: false, failure: null }),
}));

vi.mock('../../src/providers/registry', () => ({
  deleteLiveArtifact: vi.fn(),
  fetchLiveArtifacts: vi.fn(async () => []),
  fetchProjectFiles: vi.fn(async () => []),
  liveArtifactPreviewUrl: (projectId: string, artifactId: string) =>
    `/api/projects/${projectId}/live-artifacts/${artifactId}/preview`,
  projectFileUrl: (projectId: string, name: string) => `/api/projects/${projectId}/files/${name}`,
}));

const project: Project = {
  id: 'project-1', name: 'Landing page', skillId: null, designSystemId: null,
  createdAt: 1, updatedAt: 2, status: { value: 'succeeded' },
};
const artifact: LiveArtifactSummary = {
  schemaVersion: 1, id: 'live-1', projectId: project.id, title: 'Sales dashboard', slug: 'sales',
  status: 'active', pinned: false, preview: { type: 'html', entry: 'index.html' },
  refreshStatus: 'never', hasDocument: true,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
};

function mount(projects: Project[] = [project]) {
  const props = {
    projects, skills: [], designSystems: [], onOpen: vi.fn(),
    onOpenLiveArtifact: vi.fn(), onDelete: vi.fn(),
  };
  return { ...render(<DesignsTab {...props} />), props };
}

describe('DesignsTab view consistency', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(fetchLiveArtifacts).mockReset().mockResolvedValue([]);
    vi.mocked(deleteLiveArtifact).mockReset().mockResolvedValue(true);
  });
  afterEach(cleanup);

  it('keeps project and live artifact cards when switching views and opens the artifact itself', async () => {
    vi.mocked(fetchLiveArtifacts).mockResolvedValue([artifact]);
    const { container, props } = mount();
    await screen.findByText('Sales dashboard');
    expect(container.querySelectorAll('.design-card')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('designs-view-kanban'));
    expect(container.querySelectorAll('.design-kanban-card')).toHaveLength(2);
    expect(screen.getByText('Landing page', { selector: '.design-kanban-card-name' })).toBeTruthy();
    const card = screen.getByText('Sales dashboard').closest('[role="button"]')!;
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(props.onOpenLiveArtifact).toHaveBeenNthCalledWith(1, 'project-1', 'live-1');
    expect(props.onOpenLiveArtifact).toHaveBeenNthCalledWith(2, 'project-1', 'live-1');
    expect(props.onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('designs-view-grid'));
    expect(container.querySelectorAll('.design-card')).toHaveLength(2);
  });

  it('preserves collapsed Orbit artifacts and title searches in kanban', async () => {
    vi.mocked(fetchLiveArtifacts).mockResolvedValue([artifact]);
    // Legacy Orbit metadata remains readable but is no longer a creatable ProjectKind.
    const metadata = { kind: 'orbit' } as unknown as Project['metadata'];
    const { container } = mount([{ ...project, skillId: 'live-artifact', metadata }]);
    await screen.findByText('Sales dashboard', { exact: false });
    expect(container.querySelectorAll('.design-card')).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Sales' } });

    fireEvent.click(screen.getByTestId('designs-view-kanban'));
    expect(container.querySelectorAll('.design-kanban-card')).toHaveLength(1);
    expect(screen.getByText('Landing page', { selector: '.design-kanban-card-name' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('designs-view-grid'));
    expect(container.querySelectorAll('.design-card')).toHaveLength(1);
  });

  it('labels queued and running projects separately within the running column', () => {
    const { container } = mount([
      { ...project, name: 'Waiting project', status: { value: 'queued' } },
      { ...project, id: 'project-2', name: 'Active project', status: { value: 'running' } },
    ]);
    fireEvent.click(screen.getByTestId('designs-view-kanban'));
    const queued = screen.getByText('Waiting project').closest('[role="button"]')!;
    const running = screen.getByText('Active project').closest('[role="button"]')!;
    expect(within(queued as HTMLElement).getByText('Queued')).toBeTruthy();
    expect(within(running as HTMLElement).getByText('Running')).toBeTruthy();
    expect(queued.closest('.design-kanban-col')).toBe(running.closest('.design-kanban-col'));
    expect(container.querySelector('.design-kanban-card.status-queued')).toBeTruthy();
  });

  it('keeps artifact refresh errors visible without changing the owning project status', async () => {
    vi.mocked(fetchLiveArtifacts).mockResolvedValue([{ ...artifact, refreshStatus: 'failed' }]);
    const { container } = mount();
    await screen.findByText('Sales dashboard');
    fireEvent.click(screen.getByTestId('designs-view-kanban'));
    await waitFor(() => expect(container.querySelectorAll('.design-kanban-card')).toHaveLength(2));
    const card = screen.getByText('Sales dashboard').closest('[role="button"]')!;
    expect(within(card as HTMLElement).getAllByText('Refresh failed').length).toBeGreaterThan(0);
    expect(card.closest('.design-kanban-col')?.querySelector('.design-kanban-count')?.textContent).toBe('2');
  });

  it('deletes an artifact through its existing confirmation without deleting or opening its project', async () => {
    vi.mocked(fetchLiveArtifacts).mockResolvedValue([artifact]);
    const { container, props } = mount();
    await screen.findByText('Sales dashboard');
    fireEvent.click(screen.getByTestId('designs-view-kanban'));
    const remove = screen.getByRole('button', { name: 'Delete Sales dashboard' });
    fireEvent.keyDown(remove, { key: 'Enter' });
    fireEvent.click(remove);
    expect(props.onOpenLiveArtifact).not.toHaveBeenCalled();
    expect(props.onOpen).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(container.querySelectorAll('.design-kanban-card')).toHaveLength(1));
    expect(deleteLiveArtifact).toHaveBeenCalledExactlyOnceWith('project-1', 'live-1', null);
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('allows viewers to open cards but disables deletion in kanban', async () => {
    vi.mocked(fetchLiveArtifacts).mockResolvedValue([artifact]);
    const { props } = mount([{ ...project, companyAccess: {
      canWrite: false, canComment: true, canManage: false, ownerUserId: 'owner-1',
    } }]);
    await screen.findByText('Sales dashboard');
    fireEvent.click(screen.getByTestId('designs-view-kanban'));
    expect(screen.getByRole('button', { name: 'Delete Sales dashboard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete project Landing page' })).toBeDisabled();
    fireEvent.click(screen.getByText('Sales dashboard'));
    expect(props.onOpenLiveArtifact).toHaveBeenCalledWith('project-1', 'live-1');
  });
});
