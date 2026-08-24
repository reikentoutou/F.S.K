import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AttachmentManifestEntry,
  LegacyReportAttachmentHint,
} from './contracts';

const UNSAFE_FORMAT_CONTROL_PATTERN =
  /[\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|\u{e0001}|[\u{e0020}-\u{e007f}]/u;

export interface InventoryFileContext {
  sourceRelativeKey: string;
  declaredPath: string;
  canonicalPath: string;
}

export interface InventorySafetyHooks {
  beforeOpen?(context: InventoryFileContext): void | Promise<void>;
  afterRead?(context: InventoryFileContext): void | Promise<void>;
}

interface SourceFile extends InventoryFileContext {
  canonicalParent: string;
  parentDevice: bigint;
  parentInode: bigint;
  fileDevice: bigint;
  fileInode: bigint;
}

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
  const normalized = pathFromRoot.replaceAll('\\', '/').normalize('NFC');
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

function safeFileName(sourceRelativeKey: string): string {
  const fileName = basename(sourceRelativeKey).normalize('NFC');
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    UNSAFE_FORMAT_CONTROL_PATTERN.test(fileName) ||
    /[\u0000-\u001f\u007f/\\]/u.test(fileName)
  ) {
    throw new Error('INVALID_STORAGE_FILE_NAME');
  }
  return fileName;
}

function assertSafeReportKey(reportKey: string): void {
  if (
    !reportKey ||
    /[\u0000-\u001f\u007f/\\]/u.test(reportKey) ||
    UNSAFE_FORMAT_CONTROL_PATTERN.test(reportKey)
  ) {
    throw new Error('INVALID_MIGRATION_REPORT_KEY');
  }
}

async function assertParentIdentity(sourceFile: SourceFile): Promise<void> {
  const declaredParent = dirname(sourceFile.declaredPath);
  const parentStat = await lstat(declaredParent, { bigint: true }).catch(
    () => null,
  );
  if (
    !parentStat?.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.dev !== sourceFile.parentDevice ||
    parentStat.ino !== sourceFile.parentInode ||
    (await realpath(declaredParent).catch(() => null)) !==
      sourceFile.canonicalParent
  ) {
    throw new Error('UPLOAD_PATH_NOT_CANONICAL');
  }
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readFileForHash(
  sourceFile: SourceFile,
  hooks: InventorySafetyHooks,
): Promise<{ byteSize: number; sha256: string }> {
  let handle;
  try {
    await hooks.beforeOpen?.(sourceFile);
    await assertParentIdentity(sourceFile);
    handle = await open(
      sourceFile.canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== sourceFile.fileDevice ||
      before.ino !== sourceFile.fileInode
    ) {
      throw new Error('UPLOAD_PATH_NOT_CANONICAL');
    }
    const bytes = await handle.readFile();
    await hooks.afterRead?.(sourceFile);
    const after = await handle.stat({ bigint: true });
    if (!sameFileState(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error('UPLOAD_FILE_CHANGED');
    }
    await assertParentIdentity(sourceFile);
    return {
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('UPLOAD_')) {
      throw error;
    }
    throw new Error('UPLOAD_HASH_FAILED');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function targetEntries(
  sourceFile: SourceFile,
  hash: { byteSize: number; sha256: string },
  reportKeys: string[],
): AttachmentManifestEntry[] {
  const fileName = safeFileName(sourceFile.sourceRelativeKey);
  if (reportKeys.length === 0) {
    return [
      {
        sourceRelativeKey: sourceFile.sourceRelativeKey,
        objectKey: `migration/orphans/${hash.sha256}-${fileName}`,
        ...hash,
        linkedReportKeys: [],
        orphan: true,
      },
    ];
  }
  return reportKeys.map((reportKey) => {
    assertSafeReportKey(reportKey);
    return {
      sourceRelativeKey: sourceFile.sourceRelativeKey,
      objectKey: `migration/daily-reports/${reportKey}/${hash.sha256}-${fileName}`,
      ...hash,
      linkedReportKeys: [reportKey],
      orphan: false,
    };
  });
}

export async function inventoryUploads(
  uploadsPath: string,
  reportHints: LegacyReportAttachmentHint[],
  hooks: InventorySafetyHooks = {},
): Promise<AttachmentManifestEntry[]> {
  const declaredRoot = resolve(uploadsPath);
  const rootStat = await lstat(declaredRoot, { bigint: true }).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('UPLOAD_ROOT_INVALID');
  }
  const canonicalRoot = await realpath(declaredRoot);
  const sourceFiles: SourceFile[] = [];

  async function walk(directory: string): Promise<void> {
    const directoryStat = await lstat(directory, { bigint: true });
    const canonicalDirectory = await realpath(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const declaredPath = resolve(directory, entry.name);
      const entryStat = await lstat(declaredPath, { bigint: true });
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
        sourceFiles.push({
          declaredPath,
          canonicalPath,
          sourceRelativeKey: canonicalRelativeKey(canonicalRoot, canonicalPath),
          canonicalParent: canonicalDirectory,
          parentDevice: directoryStat.dev,
          parentInode: directoryStat.ino,
          fileDevice: entryStat.dev,
          fileInode: entryStat.ino,
        });
      } else {
        throw new Error('UPLOAD_PATH_NOT_CANONICAL');
      }
    }
  }

  await walk(declaredRoot);
  const sourceKeys = new Set<string>();
  const targetKeys = new Set<string>();
  const inventory: AttachmentManifestEntry[] = [];
  const sortedHints = [...reportHints].sort((left, right) =>
    compareText(left.reportKey, right.reportKey),
  );
  for (const sourceFile of sourceFiles) {
    if (sourceKeys.has(sourceFile.sourceRelativeKey)) {
      throw new Error('DUPLICATE_UPLOAD_KEY');
    }
    sourceKeys.add(sourceFile.sourceRelativeKey);
    const pathSegments = sourceFile.sourceRelativeKey.split('/');
    const linkedReportKeys = [
      ...new Set(
        sortedHints
          .filter((hint) => pathSegments.includes(hint.legacyReportId))
          .map((hint) => hint.reportKey),
      ),
    ];
    const hash = await readFileForHash(sourceFile, hooks);
    for (const entry of targetEntries(sourceFile, hash, linkedReportKeys)) {
      if (targetKeys.has(entry.objectKey)) {
        throw new Error('DUPLICATE_UPLOAD_KEY');
      }
      targetKeys.add(entry.objectKey);
      inventory.push(entry);
    }
  }
  return inventory.sort((left, right) =>
    compareText(left.objectKey, right.objectKey),
  );
}
