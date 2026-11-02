import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCompanyInputPaths } from '../../src/company/input-paths.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'company-input-')); roots.push(root);
  const projectRoot = path.join(root, 'project'); const outside = path.join(root, 'other-project');
  mkdirSync(projectRoot); mkdirSync(outside);
  writeFileSync(path.join(projectRoot, 'reference.png'), 'project-owned-image');
  writeFileSync(path.join(projectRoot, 'brief.txt'), 'project brief');
  writeFileSync(path.join(outside, 'secret.png'), 'other project secret');
  return { root, projectRoot, outside };
}

describe('company prompt input containment', () => {
  it('accepts an empty first-turn attachment list before the project directory is materialized', () => {
    const { root } = fixture();
    const projectRoot = path.join(root, 'new-project');
    expect(resolveCompanyInputPaths({ projectRoot, imagePaths: [], attachments: [], commentAttachments: [] }))
      .toEqual({ imagePaths: [], attachments: [], commentAttachments: [] });
    expect(() => resolveCompanyInputPaths({ projectRoot, attachments: 'invalid' })).toThrow(/arrays/);
  });

  it('normalizes project image and file references without using the process cwd', () => {
    const { projectRoot } = fixture();
    const result = resolveCompanyInputPaths({ projectRoot, imagePaths: ['reference.png'], attachments: ['brief.txt'] });
    expect(result.imagePaths).toEqual([path.join(projectRoot, 'reference.png')]);
    expect(result.attachments).toEqual(['brief.txt']);
  });

  it('rejects another project, a global upload, traversal, and an escaping directory symlink', () => {
    const { projectRoot, outside } = fixture();
    symlinkSync(outside, path.join(projectRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of [path.join(outside, 'secret.png'), '../other-project/secret.png', 'linked/secret.png']) {
      expect(() => resolveCompanyInputPaths({ projectRoot, imagePaths: [file] })).toThrow(/current project/);
      expect(() => resolveCompanyInputPaths({ projectRoot, attachments: [file] })).toThrow(/current project/);
    }
  });

  it('accepts a separate image root only when the trusted caller explicitly permits it', () => {
    const { projectRoot, outside } = fixture();
    const file = path.join(outside, 'secret.png');
    expect(() => resolveCompanyInputPaths({ projectRoot, imagePaths: [file] })).toThrow();
    expect(resolveCompanyInputPaths({ projectRoot, imagePaths: [file], permittedImageRoots: [outside] }).imagePaths).toEqual([file]);
    expect(() => resolveCompanyInputPaths({ projectRoot, attachments: [file], permittedImageRoots: [outside] })).toThrow();
  });

  it('checks comment screenshot and image paths instead of trusting nested attachment fields', () => {
    const { projectRoot, outside } = fixture();
    expect(() => resolveCompanyInputPaths({ projectRoot, commentAttachments: [{ filePath: 'brief.txt', screenshotPath: path.join(outside, 'secret.png') }] })).toThrow();
    expect(() => resolveCompanyInputPaths({ projectRoot, commentAttachments: [{ filePath: 'brief.txt', imageAttachments: [{ path: '../other-project/secret.png', name: 'secret' }] }] })).toThrow();
    expect(resolveCompanyInputPaths({ projectRoot, commentAttachments: [{ filePath: 'brief.txt', screenshotPath: 'reference.png', imageAttachments: [{ path: 'reference.png', name: 'reference' }] }] }).commentAttachments).toEqual([{ filePath: 'brief.txt', screenshotPath: 'reference.png', imageAttachments: [{ path: 'reference.png', name: 'reference' }] }]);
  });

  it('rejects oversized, missing, and non-file image inputs', () => {
    const { projectRoot } = fixture();
    writeFileSync(path.join(projectRoot, 'large.png'), Buffer.alloc(1024 * 1024 + 1));
    for (const file of ['large.png', 'missing.png', '.']) expect(() => resolveCompanyInputPaths({ projectRoot, imagePaths: [file] })).toThrow();
  });
});
