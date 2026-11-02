import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface CompanyInputPathsOptions {
  /** The trusted, already resolved current project directory; never a request-supplied cwd. */
  projectRoot: string;
  imagePaths?: unknown;
  attachments?: unknown;
  commentAttachments?: unknown;
  /** Optional trusted roots for uploads owned by this user; never the shared upload directory. */
  permittedImageRoots?: readonly string[];
}

export interface CompanyInputPaths {
  imagePaths: string[];
  attachments: string[];
  commentAttachments: Record<string, unknown>[];
}

export class CompanyInputPathError extends Error {
  readonly code = 'COMPANY_INPUT_SCOPE_DENIED';
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CompanyInputPathError('Input attachments must be arrays');
  return value;
}

/** Validate every path before snapshots or copies can read host files for a company run. */
export function resolveCompanyInputPaths(options: CompanyInputPathsOptions): CompanyInputPaths {
  const images = array(options.imagePaths);
  const attachments = array(options.attachments);
  const comments = array(options.commentAttachments);
  if (!images.length && !attachments.length && !comments.length) {
    return { imagePaths: [], attachments: [], commentAttachments: [] };
  }
  const projectRoot = realpathSync(options.projectRoot);
  if (!statSync(projectRoot).isDirectory()) throw new CompanyInputPathError('Invalid current project directory');
  const imageRoots = [projectRoot, ...(options.permittedImageRoots ?? []).map((root) => realpathSync(root))];
  const resolve = (input: unknown, image = false): string => {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new CompanyInputPathError('Invalid input attachment path');
    const candidate = path.resolve(projectRoot, input);
    const roots = image ? imageRoots : [projectRoot];
    if (!roots.some((root) => within(root, candidate))) throw new CompanyInputPathError('Input attachments must stay inside the current project');
    let canonical: string;
    try { canonical = realpathSync(candidate); }
    catch { throw new CompanyInputPathError('Input attachment does not exist'); }
    if (!roots.some((root) => within(root, canonical))) throw new CompanyInputPathError('Input attachments must stay inside the current project');
    const stat = statSync(canonical);
    if (image) {
      if (!stat.isFile()) throw new CompanyInputPathError('Image attachment must be a file');
      if (stat.size > 1024 * 1024) throw new CompanyInputPathError('Image attachments must be 1 MB or smaller');
    } else if (!stat.isFile() && !stat.isDirectory()) throw new CompanyInputPathError('Invalid input attachment');
    return canonical;
  };
  const relative = (input: unknown, image = false): string => {
    const canonical = resolve(input, image);
    if (!within(projectRoot, canonical)) throw new CompanyInputPathError('Input attachments must stay inside the current project');
    return path.relative(projectRoot, canonical).split(path.sep).join('/');
  };
  const commentAttachments = comments.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CompanyInputPathError('Invalid comment attachment');
    const comment = { ...input as Record<string, unknown> };
    if (comment.filePath !== undefined) comment.filePath = relative(comment.filePath);
    if (comment.screenshotPath !== undefined) comment.screenshotPath = relative(comment.screenshotPath, true);
    if (comment.imageAttachments !== undefined) comment.imageAttachments = array(comment.imageAttachments).map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CompanyInputPathError('Invalid comment image attachment');
      const image = item as Record<string, unknown>;
      return { ...image, path: relative(image.path, true) };
    });
    return comment;
  });
  return {
    imagePaths: images.map((image) => resolve(image, true)),
    attachments: attachments.map((attachment) => relative(attachment)),
    commentAttachments,
  };
}
