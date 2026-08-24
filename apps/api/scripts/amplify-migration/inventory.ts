import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AttachmentManifestEntry,
  LegacyReportAttachmentHint,
} from './contracts';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isOutside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  );
}

function canonicalRelativeKey(root: string, candidate: string): string {
  const pathFromRoot = relative(root, candidate);
  if (!pathFromRoot || isOutside(root, candidate)) {
    throw new Error('UPLOAD_PATH_NOT_CANONICAL');
  }
  const normalized = pathFromRoot
    .replaceAll('\\', '/')
    .normalize('NFC');
  const segments = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\0') ||
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw new Error('UPLOAD_PATH_NOT_CANONICAL');
  }
  return normalized;
}

async function readFileForHash(path: string): Promise<{
  byteSize: number;
  sha256: string;
}> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) throw new Error('file changed while hashing');
    return {
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new Error('UPLOAD_HASH_FAILED');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function inventoryUploads(
  uploadsPath: string,
  reportHints: LegacyReportAttachmentHint[],
): Promise<AttachmentManifestEntry[]> {
  const declaredRoot = resolve(uploadsPath);
  const rootStat = await lstat(declaredRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('UPLOAD_ROOT_INVALID');
  }
  const canonicalRoot = await realpath(declaredRoot);
  const sourceFiles: Array<{ declaredPath: string; canonicalPath: string }> = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const declaredPath = resolve(directory, entry.name);
      const entryStat = await lstat(declaredPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error('UPLOAD_PATH_NOT_CANONICAL');
      }
      const canonicalPath = await realpath(declaredPath);
      if (isOutside(canonicalRoot, canonicalPath)) {
        throw new Error('UPLOAD_PATH_NOT_CANONICAL');
      }
      if (entryStat.isDirectory()) {
        await walk(declaredPath);
      } else if (entryStat.isFile()) {
        sourceFiles.push({ declaredPath, canonicalPath });
      } else {
        throw new Error('UPLOAD_PATH_NOT_CANONICAL');
      }
    }
  }

  await walk(declaredRoot);
  const keys = new Set<string>();
  const inventory: AttachmentManifestEntry[] = [];
  const sortedHints = [...reportHints].sort((left, right) =>
    compareText(left.reportKey, right.reportKey),
  );
  for (const sourceFile of sourceFiles) {
    const sourceRelativeKey = canonicalRelativeKey(
      canonicalRoot,
      sourceFile.canonicalPath,
    );
    const objectKey = `migration/uploads/${sourceRelativeKey}`;
    if (keys.has(objectKey)) throw new Error('DUPLICATE_UPLOAD_KEY');
    keys.add(objectKey);

    const pathSegments = sourceRelativeKey.split('/');
    const linkedReportKeys = sortedHints
      .filter((hint) => pathSegments.includes(hint.legacyReportId))
      .map((hint) => hint.reportKey);
    const hash = await readFileForHash(sourceFile.declaredPath);
    inventory.push({
      sourceRelativeKey,
      objectKey,
      ...hash,
      linkedReportKeys,
      orphan: linkedReportKeys.length === 0,
    });
  }
  return inventory.sort((left, right) =>
    compareText(left.objectKey, right.objectKey),
  );
}
