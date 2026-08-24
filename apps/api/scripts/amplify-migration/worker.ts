import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LegacyReportAttachmentHint } from './contracts';
import { inventoryUploadsFromAnchoredCwd } from './inventory';

type OutputFileKind = 'bundle' | 'report' | 'status';

interface OutputFileRequest {
  kind: OutputFileKind;
  name: string;
  content: string;
}

interface HeldOutputFile {
  closed: boolean;
  fd: number;
  identity: { device: bigint; inode: bigint };
  kind: OutputFileKind;
  name: string;
  relativePath: string;
}

interface WorkerMessage {
  type: string;
  reportHints?: LegacyReportAttachmentHint[];
  files?: OutputFileRequest[];
}

function send(message: Record<string, unknown>): void {
  if (!process.send) throw new Error('MIGRATION_WORKER_IPC_REQUIRED');
  process.send(message);
}

function waitForMessage(type: string): Promise<WorkerMessage> {
  return waitForOneOf([type]);
}

function waitForOneOf(types: string[]): Promise<WorkerMessage> {
  return new Promise((resolveMessage, rejectMessage) => {
    const onMessage = (message: WorkerMessage) => {
      if (!types.includes(message.type)) return;
      cleanup();
      resolveMessage(message);
    };
    const onDisconnect = () => {
      cleanup();
      rejectMessage(new Error('MIGRATION_WORKER_DISCONNECTED'));
    };
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    process.on('message', onMessage);
    process.on('disconnect', onDisconnect);
  });
}

function waitForDecision(): Promise<'accept' | 'cleanup'> {
  return new Promise((resolveDecision, rejectDecision) => {
    const onMessage = (message: WorkerMessage) => {
      if (message.type !== 'accept' && message.type !== 'cleanup') return;
      cleanup();
      resolveDecision(message.type);
    };
    const onDisconnect = () => {
      cleanup();
      rejectDecision(new Error('MIGRATION_WORKER_DISCONNECTED'));
    };
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    process.on('message', onMessage);
    process.on('disconnect', onDisconnect);
  });
}

function assertDirectoryIdentity(device: bigint, inode: bigint): void {
  const stat = lstatSync('.', { bigint: true });
  if (!stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
}

function assertHeldRegularFile(
  fd: number,
  identity: { device: bigint; inode: bigint },
  expectedSize?: bigint,
): void {
  const stat = fstatSync(fd, { bigint: true });
  if (
    !stat.isFile() ||
    stat.dev !== identity.device ||
    stat.ino !== identity.inode ||
    stat.nlink !== 1n ||
    (expectedSize !== undefined && stat.size !== expectedSize)
  ) {
    throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
  }
}

function pathMatchesDirectory(
  path: string,
  identity: { dev: bigint; ino: bigint },
): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch {
    return false;
  }
}

async function inventoryWorker(): Promise<void> {
  const expectedDevice = BigInt(process.argv[3]);
  const expectedInode = BigInt(process.argv[4]);
  const root = lstatSync('.', { bigint: true });
  if (
    !root.isDirectory() ||
    root.dev !== expectedDevice ||
    root.ino !== expectedInode
  ) {
    throw new Error('UPLOAD_ROOT_IDENTITY_CHANGED');
  }
  send({
    type: 'ready',
    device: root.dev.toString(),
    inode: root.ino.toString(),
  });
  const request = await waitForMessage('inventory');
  const inventory = await inventoryUploadsFromAnchoredCwd(
    request.reportHints ?? [],
  );
  const finalRoot = lstatSync('.', { bigint: true });
  if (
    !finalRoot.isDirectory() ||
    finalRoot.dev !== expectedDevice ||
    finalRoot.ino !== expectedInode
  ) {
    throw new Error('UPLOAD_ROOT_IDENTITY_CHANGED');
  }
  send({ type: 'inventory', inventory });
}

async function outputWorker(): Promise<void> {
  const outputName = process.argv[3];
  const expectedDevice = BigInt(process.argv[4]);
  const expectedInode = BigInt(process.argv[5]);
  assertDirectoryIdentity(expectedDevice, expectedInode);

  const stageName = mkdtempSync('.fsk-migration-output-');
  const stageFd = openSync(
    stageName,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stageStat = fstatSync(stageFd, { bigint: true });
  if (!stageStat.isDirectory() || (stageStat.mode & 0o777n) !== 0o700n) {
    throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
  }
  let materialized = false;
  const heldFiles = new Map<OutputFileKind, HeldOutputFile>();
  try {
    for (const [kind, name] of [
      ['bundle', 'migration-bundle.json'],
      ['report', 'migration-report.json'],
      ['status', 'migration-status.json'],
    ] as const) {
      if (!pathMatchesDirectory(stageName, stageStat)) {
        throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
      }
      const relativePath = join(stageName, name);
      const fd = openSync(
        relativePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      const initial = fstatSync(fd, { bigint: true });
      const held = {
        closed: false,
        fd,
        identity: { device: initial.dev, inode: initial.ino },
        kind,
        name,
        relativePath,
      };
      if (!pathMatchesDirectory(stageName, stageStat)) {
        closeSync(fd);
        throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
      }
      assertHeldRegularFile(fd, held.identity, 0n);
      heldFiles.set(kind, held);
    }
    send({ type: 'ready', stageName });
    const request = await waitForOneOf(['write', 'cleanup']);
    if (request.type === 'cleanup') return;
    const requestedKinds = new Set<OutputFileKind>();
    for (const file of request.files ?? []) {
      const held = heldFiles.get(file.kind);
      if (
        !held ||
        held.name !== file.name ||
        requestedKinds.has(file.kind)
      ) {
        throw new Error('MIGRATION_OUTPUT_FILE_INVALID');
      }
      requestedKinds.add(file.kind);
      assertHeldRegularFile(held.fd, held.identity, 0n);
      send({
        type: 'beforeWrite',
        fileKind: file.kind,
        stageName,
        fileName: file.name,
      });
      await waitForMessage('continue');
      assertHeldRegularFile(held.fd, held.identity, 0n);
      writeFileSync(held.fd, file.content, { encoding: 'utf8' });
      fsyncSync(held.fd);
      send({
        type: 'afterWrite',
        fileKind: file.kind,
        stageName,
        fileName: file.name,
      });
      await waitForMessage('continue');
      assertHeldRegularFile(
        held.fd,
        held.identity,
        BigInt(Buffer.byteLength(file.content, 'utf8')),
      );
    }
    if (!pathMatchesDirectory(stageName, stageStat)) {
      throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
    }
    for (const held of heldFiles.values()) {
      closeSync(held.fd);
      held.closed = true;
      if (!requestedKinds.has(held.kind)) unlinkSync(held.relativePath);
    }
    fsyncSync(stageFd);
    assertDirectoryIdentity(expectedDevice, expectedInode);
    try {
      lstatSync(outputName);
      throw new Error('MIGRATION_OUTPUT_ALREADY_EXISTS');
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'MIGRATION_OUTPUT_ALREADY_EXISTS'
      ) {
        throw error;
      }
    }
    const heldStage = fstatSync(stageFd, { bigint: true });
    if (
      !heldStage.isDirectory() ||
      heldStage.dev !== stageStat.dev ||
      heldStage.ino !== stageStat.ino ||
      !pathMatchesDirectory(stageName, stageStat)
    ) {
      throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
    }
    renameSync(stageName, outputName);
    materialized = true;
    const parentFd = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
    const published = lstatSync(outputName, { bigint: true });
    if (
      !published.isDirectory() ||
      published.dev !== stageStat.dev ||
      published.ino !== stageStat.ino
    ) {
      throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
    }
    send({
      type: 'materialized',
      device: published.dev.toString(),
      inode: published.ino.toString(),
    });
    const decision = await waitForDecision();
    if (decision === 'cleanup') {
      if (!pathMatchesDirectory(outputName, stageStat)) return;
      for (const file of request.files ?? []) {
        unlinkSync(join(outputName, file.name));
      }
      rmdirSync(outputName);
    }
  } finally {
    for (const held of heldFiles.values()) {
      if (held.closed) continue;
      try {
        closeSync(held.fd);
        held.closed = true;
      } catch {
        // Preserve the authoritative worker failure.
      }
    }
    closeSync(stageFd);
    if (!materialized && pathMatchesDirectory(stageName, stageStat)) {
      for (const held of [...heldFiles.values()].reverse()) {
        try {
          unlinkSync(held.relativePath);
        } catch {
          // The private stage remains isolated if an attacker changed it.
        }
      }
      try {
        rmdirSync(stageName);
      } catch {
        // A private orphan is safer than pathname-based cleanup outside it.
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'inventory') await inventoryWorker();
  else if (process.argv[2] === 'output') await outputWorker();
  else throw new Error('MIGRATION_WORKER_MODE_INVALID');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    send({
      type: 'error',
      errorCode: error instanceof Error ? error.message : 'MIGRATION_WORKER_FAILED',
    });
    process.exit(1);
  });
