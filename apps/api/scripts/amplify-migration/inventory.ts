import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  AttachmentManifestEntry,
  LegacyReportAttachmentHint,
  SourceUploadEvidence,
  UploadInventory,
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
  beforeFinalTreeCheck?(): void | Promise<void>;
}

interface SourceFile extends InventoryFileContext {
  accessPath: string;
  canonicalParent: string;
  parentDevice: bigint;
  parentInode: bigint;
  initialStat: BigIntStats;
}

interface SourceDirectory {
  accessPath: string;
  canonicalPath: string;
  initialStat: BigIntStats;
  entryNames: string[];
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
  const declaredParent = dirname(sourceFile.accessPath);
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
      sourceFile.accessPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFileState(before, sourceFile.initialStat)) {
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

async function assertTreeStable(
  sourceDirectories: SourceDirectory[],
  sourceFiles: SourceFile[],
): Promise<void> {
  try {
    for (const directory of sourceDirectories) {
      const stat = await lstat(directory.accessPath, { bigint: true });
      const canonicalPath = await realpath(directory.accessPath);
      const entryNames = (await readdir(directory.accessPath))
        .sort(compareText);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        canonicalPath !== directory.canonicalPath ||
        !sameFileState(stat, directory.initialStat) ||
        entryNames.length !== directory.entryNames.length ||
        entryNames.some((name, index) => name !== directory.entryNames[index])
      ) {
        throw new Error('UPLOAD_TREE_CHANGED');
      }
    }
    for (const sourceFile of sourceFiles) {
      const stat = await lstat(sourceFile.accessPath, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (await realpath(sourceFile.accessPath)) !== sourceFile.canonicalPath ||
        !sameFileState(stat, sourceFile.initialStat)
      ) {
        throw new Error('UPLOAD_TREE_CHANGED');
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'UPLOAD_TREE_CHANGED') {
      throw error;
    }
    throw new Error('UPLOAD_TREE_CHANGED');
  }
}

function targetEntries(
  sourceFile: SourceFile,
  hash: { byteSize: number; sha256: string },
  reportKeys: string[],
): AttachmentManifestEntry[] {
  const fileName = safeFileName(sourceFile.sourceRelativeKey);
  if (reportKeys.length === 0) return [];
  return reportKeys.map((reportKey) => {
    assertSafeReportKey(reportKey);
    return {
      sourceRelativeKey: sourceFile.sourceRelativeKey,
      objectKey: `migration/daily-reports/${reportKey}/${hash.sha256}-${fileName}`,
      ...hash,
      reportKey,
    };
  });
}

async function inventoryUploadsFromRoot(
  rootAccessPath: string,
  reportHints: LegacyReportAttachmentHint[],
  hooks: InventorySafetyHooks = {},
): Promise<UploadInventory> {
  const declaredRoot = rootAccessPath;
  const rootStat = await lstat(declaredRoot, { bigint: true }).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('UPLOAD_ROOT_INVALID');
  }
  const canonicalRoot = await realpath(declaredRoot);
  const sourceFiles: SourceFile[] = [];
  const sourceDirectories: SourceDirectory[] = [];

  async function walk(
    directory: string,
    relativeSegments: string[],
  ): Promise<void> {
    const directoryStat = await lstat(directory, { bigint: true });
    const canonicalDirectory = await realpath(directory);
    if (
      directoryStat.isSymbolicLink() ||
      !directoryStat.isDirectory() ||
      isOutside(canonicalRoot, canonicalDirectory)
    ) {
      throw new Error('UPLOAD_PATH_NOT_CANONICAL');
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    sourceDirectories.push({
      accessPath: directory,
      canonicalPath: canonicalDirectory,
      initialStat: directoryStat,
      entryNames: entries.map((entry) => entry.name),
    });
    for (const entry of entries) {
      const declaredPath = join(directory, entry.name);
      const entryStat = await lstat(declaredPath, { bigint: true });
      if (entryStat.isSymbolicLink()) {
        throw new Error('UPLOAD_PATH_NOT_CANONICAL');
      }
      const canonicalPath = await realpath(declaredPath);
      if (isOutside(canonicalRoot, canonicalPath)) {
        throw new Error('UPLOAD_PATH_NOT_CANONICAL');
      }
      if (entryStat.isDirectory()) {
        await walk(declaredPath, [...relativeSegments, entry.name]);
      } else if (entryStat.isFile()) {
        const sourceRelativeKey = [...relativeSegments, entry.name]
          .join('/')
          .replaceAll('\\', '/')
          .normalize('NFC');
        canonicalRelativeKey(canonicalRoot, canonicalPath);
        sourceFiles.push({
          accessPath: declaredPath,
          declaredPath,
          canonicalPath,
          sourceRelativeKey,
          canonicalParent: canonicalDirectory,
          parentDevice: directoryStat.dev,
          parentInode: directoryStat.ino,
          initialStat: entryStat,
        });
      } else {
        throw new Error('UPLOAD_PATH_NOT_CANONICAL');
      }
    }
  }

  await walk(declaredRoot, []);
  const sourceKeys = new Set<string>();
  const targetKeys = new Set<string>();
  const sourceInventory: SourceUploadEvidence[] = [];
  const targetAttachments: AttachmentManifestEntry[] = [];
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
    sourceInventory.push({
      sourceRelativeKey: sourceFile.sourceRelativeKey,
      ...hash,
      linkedReportKeys,
    });
    for (const entry of targetEntries(sourceFile, hash, linkedReportKeys)) {
      if (targetKeys.has(entry.objectKey)) {
        throw new Error('DUPLICATE_UPLOAD_KEY');
      }
      targetKeys.add(entry.objectKey);
      targetAttachments.push(entry);
    }
  }
  await hooks.beforeFinalTreeCheck?.();
  await assertTreeStable(sourceDirectories, sourceFiles);
  return {
    sourceFiles: sourceInventory.sort((left, right) =>
      compareText(left.sourceRelativeKey, right.sourceRelativeKey),
    ),
    targetAttachments: targetAttachments.sort((left, right) =>
      compareText(left.objectKey, right.objectKey),
    ),
  };
}

export async function inventoryUploads(
  uploadsPath: string,
  reportHints: LegacyReportAttachmentHint[],
  hooks: InventorySafetyHooks = {},
): Promise<UploadInventory> {
  return inventoryUploadsFromRoot(resolve(uploadsPath), reportHints, hooks);
}

export async function inventoryUploadsFromAnchoredCwd(
  reportHints: LegacyReportAttachmentHint[],
): Promise<UploadInventory> {
  return inventoryUploadsFromRoot('.', reportHints, {});
}
