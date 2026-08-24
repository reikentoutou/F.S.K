import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMigrationBundle,
  normalizeLegacySubmittedAt,
  runDryRunCli,
  serializeMigrationBundle,
} from './transform';
import { inventoryUploads } from './inventory';
import {
  createWorkerClient,
  spawnWorkerClient,
  type WorkerClientProcess,
} from './worker-client';

const repositoryRoot = resolve(__dirname, '../../../..');
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fsk-migration-test-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createFixture(options: { conflictingReport?: boolean } = {}): {
  root: string;
  sqlitePath: string;
  uploadsPath: string;
} {
  const root = temporaryRoot();
  const sqlitePath = join(root, 'fixture.sqlite');
  const uploadsPath = join(root, 'uploads');
  mkdirSync(uploadsPath);

  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    CREATE TABLE "User" (
      "id" TEXT PRIMARY KEY,
      "username" TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL
    );
    CREATE TABLE "Shift" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "sortOrder" INTEGER NOT NULL,
      "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "ResponsiblePerson" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "AppSettings" (
      "id" TEXT PRIMARY KEY,
      "registerFloatAmount" INTEGER NOT NULL,
      "setupCompleted" BOOLEAN NOT NULL
    );
    CREATE TABLE "DailyReport" (
      "id" TEXT PRIMARY KEY,
      "reportDate" TEXT NOT NULL,
      "shiftId" TEXT NOT NULL,
      "shiftNameSnapshot" TEXT NOT NULL,
      "responsiblePersonId" TEXT NOT NULL,
      "responsiblePersonSnapshot" TEXT NOT NULL,
      "startMinuteOfDay" INTEGER NOT NULL,
      "endMinuteOfDay" INTEGER NOT NULL,
      "timeRangeLabelSnapshot" TEXT NOT NULL,
      "previousImosBalanceYen" INTEGER NOT NULL,
      "currentImosBalanceYen" INTEGER NOT NULL,
      "imosSalesYen" INTEGER NOT NULL,
      "newageYen" INTEGER NOT NULL,
      "cashTotalYen" INTEGER NOT NULL,
      "expenseYen" INTEGER NOT NULL,
      "expenseReason" TEXT,
      "staffMealCashYen" INTEGER NOT NULL,
      "staffMealAlipayYen" INTEGER NOT NULL,
      "totalSalesYen" INTEGER NOT NULL,
      "cashDepositYen" INTEGER NOT NULL,
      "deviationYen" INTEGER NOT NULL,
      "status" TEXT NOT NULL,
      "createdByUserId" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL
    );
  `);
  database.prepare(
    'INSERT INTO "User" VALUES (?, ?, ?, ?, ?)',
  ).run('user-kitchen', 'kitchen-old', '$2b$secret-hash', 'WEBMASTER', '2024-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO "Shift" VALUES (?, ?, ?, ?)').run(
    'shift-night',
    '夜班',
    20,
    1,
  );
  database.prepare('INSERT INTO "Shift" VALUES (?, ?, ?, ?)').run(
    'shift-day',
    '白班',
    10,
    0,
  );
  database.prepare('INSERT INTO "ResponsiblePerson" VALUES (?, ?, ?)').run(
    'person-2',
    '李四',
    0,
  );
  database.prepare('INSERT INTO "ResponsiblePerson" VALUES (?, ?, ?)').run(
    'person-1',
    '张三',
    1,
  );
  database.prepare('INSERT INTO "AppSettings" VALUES (?, ?, ?)').run(
    'default',
    5_000,
    1,
  );

  const insertReport = database.prepare(`
    INSERT INTO "DailyReport" VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  insertReport.run(
    'legacy-report-1',
    '2026-08-23',
    'shift-day',
    '历史白班',
    'person-1',
    '历史张三',
    600,
    900,
    '10:00 - 15:00',
    10_000,
    16_000,
    999_001,
    8_000,
    20_000,
    300,
    '买菜',
    1_200,
    800,
    999_002,
    999_003,
    999_004,
    'approved',
    'user-kitchen',
    '2026-08-23T15:01:02.000Z',
  );
  if (options.conflictingReport) {
    insertReport.run(
      'legacy-report-2',
      '2026-08-23',
      'shift-day',
      '白班',
      'person-2',
      '李四',
      610,
      910,
      '10:10 - 15:10',
      1,
      2,
      1,
      3,
      4,
      0,
      null,
      0,
      0,
      2,
      -4_996,
      1,
      'approved',
      'user-kitchen',
      '2026-08-23T15:02:00.000Z',
    );
  }
  database.close();

  mkdirSync(join(uploadsPath, 'legacy-report-1'));
  writeFileSync(join(uploadsPath, 'legacy-report-1', 'receipt.txt'), 'receipt-one');
  writeFileSync(join(uploadsPath, 'unlinked.txt'), 'orphan');
  return { root, sqlitePath, uploadsPath };
}

async function createPrismaFixture(): Promise<{
  root: string;
  sqlitePath: string;
  uploadsPath: string;
  updatedAtEpochMs: number;
}> {
  const root = temporaryRoot();
  const sqlitePath = join(root, 'prisma-fixture.sqlite');
  const uploadsPath = join(root, 'uploads');
  mkdirSync(uploadsPath);
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "User" (
      "id" TEXT PRIMARY KEY, "username" TEXT NOT NULL UNIQUE,
      "passwordHash" TEXT NOT NULL, "role" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL
    );
    CREATE TABLE "Shift" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL,
      "sortOrder" INTEGER NOT NULL, "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "ResponsiblePerson" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "AppSettings" (
      "id" TEXT PRIMARY KEY, "registerFloatAmount" INTEGER NOT NULL,
      "setupCompleted" BOOLEAN NOT NULL
    );
    CREATE TABLE "DailyReport" (
      "id" TEXT PRIMARY KEY, "reportDate" TEXT NOT NULL,
      "shiftId" TEXT NOT NULL REFERENCES "Shift"("id"),
      "shiftNameSnapshot" TEXT NOT NULL,
      "responsiblePersonId" TEXT NOT NULL REFERENCES "ResponsiblePerson"("id"),
      "responsiblePersonSnapshot" TEXT NOT NULL,
      "startMinuteOfDay" INTEGER NOT NULL, "endMinuteOfDay" INTEGER NOT NULL,
      "timeRangeLabelSnapshot" TEXT NOT NULL,
      "previousImosBalanceYen" INTEGER NOT NULL,
      "currentImosBalanceYen" INTEGER NOT NULL, "imosSalesYen" INTEGER NOT NULL,
      "newageYen" INTEGER NOT NULL, "cashTotalYen" INTEGER NOT NULL,
      "expenseYen" INTEGER NOT NULL, "expenseReason" TEXT,
      "staffMealCashYen" INTEGER NOT NULL,
      "staffMealAlipayYen" INTEGER NOT NULL,
      "totalSalesYen" INTEGER NOT NULL, "cashDepositYen" INTEGER NOT NULL,
      "deviationYen" INTEGER NOT NULL, "status" TEXT NOT NULL,
      "createdByUserId" TEXT NOT NULL REFERENCES "User"("id"),
      "updatedAt" DATETIME NOT NULL,
      UNIQUE("reportDate", "shiftId")
    );
  `);
  database.close();

  const prisma = new PrismaClient({ datasourceUrl: `file:${sqlitePath}` });
  const updatedAt = new Date('2026-08-23T15:01:02.345Z');
  try {
    await prisma.shift.create({
      data: { id: 'shift-day', name: '白班', sortOrder: 10, active: true },
    });
    await prisma.responsiblePerson.create({
      data: { id: 'person-1', name: '张三', active: true },
    });
    await prisma.appSettings.create({
      data: { id: 'default', registerFloatAmount: 5_000, setupCompleted: true },
    });
    await prisma.user.create({
      data: {
        id: 'user-kitchen',
        username: 'kitchen-old',
        passwordHash: '$2b$synthetic-only',
        role: 'WEBMASTER',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    });
    await prisma.dailyReport.create({
      data: {
        id: 'legacy-report-1',
        reportDate: '2026-08-23',
        shiftId: 'shift-day',
        shiftNameSnapshot: '白班',
        responsiblePersonId: 'person-1',
        responsiblePersonSnapshot: '张三',
        startMinuteOfDay: 600,
        endMinuteOfDay: 900,
        timeRangeLabelSnapshot: '10:00 - 15:00',
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 16_000,
        imosSalesYen: 6_000,
        newageYen: 8_000,
        cashTotalYen: 20_000,
        expenseYen: 300,
        expenseReason: '买菜',
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        totalSalesYen: 21_800,
        cashDepositYen: 15_000,
        deviationYen: 16_100,
        status: 'approved',
        createdByUserId: 'user-kitchen',
        updatedAt,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  return {
    root,
    sqlitePath,
    uploadsPath,
    updatedAtEpochMs: updatedAt.getTime(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

class FakeWorkerProcess extends EventEmitter implements WorkerClientProcess {
  autoExitOnKill = true;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  sendBehavior: (
    message: Record<string, unknown>,
    callback: (error: Error | null) => void,
  ) => void = (_message, callback) => queueMicrotask(() => callback(null));

  send(
    message: Record<string, unknown>,
    callback: (error: Error | null) => void,
  ): boolean {
    this.sendBehavior(message, callback);
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    if (
      this.autoExitOnKill &&
      this.exitCode === null &&
      this.signalCode === null
    ) {
      queueMicrotask(() => this.finish(null, signal ?? 'SIGTERM'));
    }
    return true;
  }

  disconnectUnexpectedly(): void {
    this.connected = false;
    this.emit('disconnect');
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  closeWithoutExit(code: number | null): void {
    this.connected = false;
    this.emit('close', code, null);
  }
}

describe('worker IPC client lifecycle', () => {
  const clientOptions = { timeoutMs: 20, terminateGraceMs: 20 };

  it('allows total work beyond fifteen minutes while progress resets inactivity', async () => {
    vi.useFakeTimers();
    const child = new FakeWorkerProcess();
    child.sendBehavior = (_message, callback) => callback(null);
    const client = createWorkerClient(child, {
      timeoutMs: 15 * 60 * 1_000,
      terminateGraceMs: 20,
    });
    const result = client.request({ type: 'inventory' }, ['inventory']);
    const outcome = result.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: Error) => ({ status: 'rejected' as const, reason }),
    );

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    child.emit('message', { type: 'progress', phase: 'chunk' });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    child.emit('message', { type: 'inventory', inventory: { synthetic: true } });

    expect(await outcome).toMatchObject({
      status: 'fulfilled',
      value: { type: 'inventory' },
    });
    expect(child.killSignals).toEqual([]);
    child.finish(0);
    await expect(client.waitForExit()).resolves.toBeUndefined();
  });

  it('times out a worker that never responds and reaps it', async () => {
    const child = new FakeWorkerProcess();
    const client = createWorkerClient(child, clientOptions);

    await expect(client.waitFor(['ready'])).rejects.toThrow(
      'MIGRATION_WORKER_TIMEOUT',
    );
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('fails closed on disconnect and reaps the worker once', async () => {
    const child = new FakeWorkerProcess();
    const client = createWorkerClient(child, clientOptions);
    const result = client.waitFor(['ready']);
    queueMicrotask(() => child.disconnectUnexpectedly());

    await expect(result).rejects.toThrow('MIGRATION_WORKER_DISCONNECTED');
    expect(child.signalCode).toBe('SIGTERM');
    expect(child.killSignals).toEqual(['SIGTERM']);
  });

  it('maps a synchronous spawn error to a controlled code', () => {
    expect(() =>
      spawnWorkerClient(() => {
        throw new Error('EACCES: synthetic spawn failure');
      }, clientOptions),
    ).toThrow('MIGRATION_WORKER_SPAWN_FAILED');
  });

  it('maps a child error event to a controlled code and reaps it', async () => {
    const child = new FakeWorkerProcess();
    child.autoExitOnKill = false;
    const client = createWorkerClient(child, clientOptions);
    const result = client.waitFor(['ready']);
    queueMicrotask(() => {
      child.emit('error', new Error('synthetic spawn error'));
      queueMicrotask(() => child.closeWithoutExit(-2));
    });

    await expect(result).rejects.toThrow('MIGRATION_WORKER_SPAWN_FAILED');
    expect(child.killSignals).toEqual(['SIGTERM']);
  });

  it('rejects a failed send callback without waiting for a response', async () => {
    const child = new FakeWorkerProcess();
    child.sendBehavior = (_message, callback) =>
      queueMicrotask(() => callback(new Error('synthetic send failure')));
    const client = createWorkerClient(child, clientOptions);

    await expect(
      client.request({ type: 'inventory' }, ['inventory']),
    ).rejects.toThrow('MIGRATION_WORKER_SEND_FAILED');
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('does not settle a one-way send before its callback acknowledges the flush', async () => {
    const child = new FakeWorkerProcess();
    let acknowledge: ((error: Error | null) => void) | undefined;
    child.sendBehavior = (_message, callback) => {
      acknowledge = callback;
    };
    const client = createWorkerClient(child, clientOptions);
    let settled = false;

    const sending = client.send({ type: 'accept' }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledge?.(null);
    await sending;
    expect(settled).toBe(true);
    await client.terminateAndReap();
  });

  it('rejects an early worker exit with a controlled code', async () => {
    const child = new FakeWorkerProcess();
    const client = createWorkerClient(child, clientOptions);
    const result = client.waitFor(['ready']);
    queueMicrotask(() => child.finish(7));

    await expect(result).rejects.toThrow('MIGRATION_WORKER_EXITED');
  });

  it('settles once and safely ignores late messages and errors', async () => {
    const child = new FakeWorkerProcess();
    const client = createWorkerClient(child, clientOptions);

    await expect(client.waitFor(['ready'])).rejects.toThrow(
      'MIGRATION_WORKER_TIMEOUT',
    );
    expect(() => {
      child.emit('message', { type: 'ready' });
      child.emit('error', new Error('late synthetic error'));
    }).not.toThrow();
    await expect(client.waitFor(['ready'])).rejects.toThrow(
      'MIGRATION_WORKER_CLOSED',
    );
    expect(child.killSignals).toEqual(['SIGTERM']);
  });

  it('rejects an unbounded timeout configuration', () => {
    const child = new FakeWorkerProcess();

    expect(() =>
      createWorkerClient(child, {
        timeoutMs: 60 * 60 * 1_000,
        terminateGraceMs: 20,
      }),
    ).toThrow('MIGRATION_WORKER_TIMEOUT_INVALID');
  });

  it('surfaces final reap failure after SIGTERM and SIGKILL both fail to stop the worker', async () => {
    vi.useFakeTimers();
    const child = new FakeWorkerProcess();
    child.autoExitOnKill = false;
    const client = createWorkerClient(child, clientOptions);
    const reaping = client.terminateAndReap();
    const outcome = reaping.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: Error) => ({ status: 'rejected' as const, reason }),
    );

    await vi.advanceTimersByTimeAsync(40);

    expect(await outcome).toMatchObject({
      status: 'rejected',
      reason: { message: 'MIGRATION_WORKER_REAP_FAILED' },
    });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

function forkMigrationWorker(
  mode: string,
  args: string[],
  cwd: string,
): ChildProcess {
  return fork(
    resolve(repositoryRoot, 'apps/api/scripts/amplify-migration/worker.ts'),
    [mode, ...args],
    {
      cwd,
      execArgv: ['--import', require.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
}

function waitForChildMessage(
  child: ChildProcess,
  type: string,
  predicate: (message: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectMessage(new Error(`TEST_WORKER_MESSAGE_TIMEOUT:${type}`));
    }, 2_000);
    const onMessage = (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== type
      ) {
        return;
      }
      const envelope = message as Record<string, unknown>;
      if (!predicate(envelope)) return;
      cleanup();
      resolveMessage(envelope);
    };
    const onExit = () => {
      cleanup();
      rejectMessage(new Error(`TEST_WORKER_EXIT_BEFORE_MESSAGE:${type}`));
    };
    const onError = (error: Error) => {
      cleanup();
      rejectMessage(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

function sendChildMessage(
  child: ChildProcess,
  message: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolveSend, rejectSend) => {
    child.send(message, (error) => {
      if (error) rejectSend(error);
      else resolveSend();
    });
  });
}

function waitForChildExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitForChildExitWithin(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForChildExit(child),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('TEST_WORKER_EXIT_TIMEOUT')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('worker IPC flush and signal cleanup', () => {
  function startOutputWorker(outputName: string) {
    const outputParent = temporaryRoot();
    const parent = lstatSync(outputParent, { bigint: true });
    const child = forkMigrationWorker(
      'output',
      [outputName, parent.dev.toString(), parent.ino.toString()],
      outputParent,
    );
    return { child, outputParent };
  }

  it('flushes the accepted result before a natural successful exit', async () => {
    const { child, outputParent } = startOutputWorker('accepted-output');
    const ready = await waitForChildMessage(child, 'ready');
    const beforeWrite = waitForChildMessage(child, 'beforeWrite');
    await sendChildMessage(child, {
      type: 'write',
      files: [
        {
          kind: 'status',
          name: 'migration-status.json',
          content: '{"status":"complete","errorCode":null}\n',
        },
      ],
    });
    await beforeWrite;
    const afterWrite = waitForChildMessage(child, 'afterWrite');
    await sendChildMessage(child, { type: 'continue' });
    await afterWrite;
    const materialized = waitForChildMessage(child, 'materialized');
    await sendChildMessage(child, { type: 'continue' });
    await materialized;

    const accepted = waitForChildMessage(child, 'accepted');
    const exited = waitForChildExit(child);
    await sendChildMessage(child, { type: 'accept' });

    await expect(accepted).resolves.toEqual({ type: 'accepted' });
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    expect(typeof ready.stageName).toBe('string');
    expect(
      JSON.parse(
        readFileSync(
          join(outputParent, 'accepted-output', 'migration-status.json'),
          'utf8',
        ),
      ),
    ).toEqual({ status: 'complete', errorCode: null });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'cleans private staging and exposes no payload after %s',
    async (signal) => {
      const outputName = `signal-${signal.toLowerCase()}-output`;
      const { child, outputParent } = startOutputWorker(outputName);
      const ready = await waitForChildMessage(child, 'ready');
      const stageName = ready.stageName;
      if (typeof stageName !== 'string') throw new Error('TEST_STAGE_NAME_MISSING');

      const beforeWrite = waitForChildMessage(child, 'beforeWrite');
      await sendChildMessage(child, {
        type: 'write',
        files: [
          {
            kind: 'bundle',
            name: 'migration-bundle.json',
            content: '{"synthetic":true}\n',
          },
          {
            kind: 'status',
            name: 'migration-status.json',
            content: '{"status":"complete","errorCode":null}\n',
          },
        ],
      });
      await beforeWrite;
      const afterWrite = waitForChildMessage(child, 'afterWrite');
      await sendChildMessage(child, { type: 'continue' });
      await afterWrite;
      const errorMessage = waitForChildMessage(child, 'error');
      const exited = waitForChildExit(child);

      child.kill(signal);

      await expect(errorMessage).resolves.toMatchObject({
        type: 'error',
        errorCode: `MIGRATION_WORKER_ABORTED:${signal}`,
      });
      await expect(exited).resolves.toMatchObject({ code: 1, signal: null });
      expect(existsSync(join(outputParent, stageName))).toBe(false);
      expect(existsSync(join(outputParent, outputName))).toBe(false);
    },
  );

  it('flushes a controlled error before natural failure exit', async () => {
    const root = temporaryRoot();
    const child = forkMigrationWorker('invalid-mode', [], root);
    const events: string[] = [];
    child.on('message', (message: { type?: string }) => {
      events.push(message.type ?? 'unknown');
    });
    child.on('exit', () => events.push('exit'));
    const errorMessage = waitForChildMessage(child, 'error');
    const exited = waitForChildExit(child);

    await expect(errorMessage).resolves.toEqual({
      type: 'error',
      errorCode: 'MIGRATION_WORKER_MODE_INVALID',
    });
    await expect(exited).resolves.toEqual({ code: 1, signal: null });
    expect(events).toEqual(['error', 'exit']);
  });

  it('aborts a real inventory worker promptly when its parent disconnects during a large-file hash', async () => {
    const uploadsPath = temporaryRoot();
    const largeFilePath = join(uploadsPath, 'large.bin');
    writeFileSync(largeFilePath, '');
    truncateSync(largeFilePath, 64 * 1024 * 1024);
    const root = lstatSync(uploadsPath, { bigint: true });
    const child = forkMigrationWorker(
      'inventory',
      [root.dev.toString(), root.ino.toString()],
      uploadsPath,
    );
    try {
      await waitForChildMessage(child, 'ready');
      const chunkProgress = waitForChildMessage(
        child,
        'progress',
        (message) => message.phase === 'chunk',
      );
      await sendChildMessage(child, { type: 'inventory', reportHints: [] });
      await chunkProgress;

      child.disconnect();

      await expect(waitForChildExitWithin(child, 2_000)).resolves.toEqual({
        code: 1,
        signal: null,
      });
      expect(readdirSync(uploadsPath)).toEqual(['large.bin']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }, 5_000);
});

describe('SQLite migration transform', () => {
  it('normalizes the current PrismaClient epoch-millisecond DateTime to UTC ISO', async () => {
    const fixture = await createPrismaFixture();
    const database = new DatabaseSync(fixture.sqlitePath, { readOnly: true });
    const stored = database
      .prepare('SELECT "updatedAt" FROM "DailyReport"')
      .get() as { updatedAt: unknown };
    database.close();

    expect(stored.updatedAt).toBe(fixture.updatedAtEpochMs);
    expect(
      (await createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath))
        .dailyReports[0].submittedAt,
    ).toBe('2026-08-23T15:01:02.345Z');
  });

  it.each([
    ['ambiguous local timestamp', '2026-08-23 15:01:02'],
    ['invalid calendar timestamp', '2026-02-30T15:01:02.000Z'],
    ['year zero timestamp', '0000-01-01T00:00:00.000Z'],
    ['offset crossing below target year one', '0001-01-01T00:00:00+00:01'],
    ['offset crossing above target year 9999', '9999-12-31T23:59:59-00:01'],
    ['fractional epoch milliseconds', 1.5],
    ['epoch milliseconds outside the Date range', 9_000_000_000_000_000],
    ['epoch milliseconds requiring an expanded UTC year', -8_640_000_000_000_000],
    ['non-finite epoch milliseconds', Number.NaN],
  ])('rejects %s', (_label, invalidTimestamp) => {
    expect(() => normalizeLegacySubmittedAt(invalidTimestamp)).toThrow(
      'INVALID_SQLITE_SOURCE_FIELD:DailyReport.updatedAt',
    );
  });

  it('normalizes an explicitly zoned ISO string to UTC', () => {
    expect(normalizeLegacySubmittedAt('2026-08-24T00:01:02+09:00')).toBe(
      '2026-08-23T15:01:02.000Z',
    );
  });

  it.each([
    [-62_135_596_800_000, '0001-01-01T00:00:00.000Z'],
    [-1, '1969-12-31T23:59:59.999Z'],
    [253_402_300_799_999, '9999-12-31T23:59:59.999Z'],
  ])('accepts target-safe epoch milliseconds %s', (timestamp, expected) => {
    expect(normalizeLegacySubmittedAt(timestamp)).toBe(expected);
  });

  it('fails when SQLite foreign_key_check reports a broken source relation', async () => {
    const fixture = await createPrismaFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('PRAGMA foreign_keys = OFF');
    database
      .prepare('UPDATE "DailyReport" SET "shiftId" = ?')
      .run('missing-shift');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('SQLITE_FOREIGN_KEY_CHECK_FAILED');
  });

  it.each([
    [
      'shift',
      'UPDATE "DailyReport" SET "shiftId" = \'missing-shift\'',
      'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.shiftId',
    ],
    [
      'responsible person',
      'UPDATE "DailyReport" SET "responsiblePersonId" = \'missing-person\'',
      'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.responsiblePersonId',
    ],
    [
      'created-by user',
      'UPDATE "DailyReport" SET "createdByUserId" = \'missing-user\'',
      'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.createdByUserId',
    ],
  ])('fails when a report references a missing %s without FK metadata', async (_label, sql, code) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(sql);
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow(code);
  });

  it('requires the single AppSetting source row to use id=default', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('UPDATE "AppSettings" SET "id" = \'other\'');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_APP_SETTING_ID');
  });

  it('validates register float even when the source has no reports', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(
      'DELETE FROM "DailyReport"; UPDATE "AppSettings" SET "registerFloatAmount" = -1',
    );
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_DAILY_REPORT_AMOUNT');
  });

  it.each([
    ['start minute below zero', '"startMinuteOfDay" = -1'],
    ['end minute above the final minute', '"endMinuteOfDay" = 1440'],
  ])('rejects %s', async (_label, assignment) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(`UPDATE "DailyReport" SET ${assignment}`);
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:DailyReport.minuteOfDay');
  });

  it('rejects an equal start and end minute', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(
      'UPDATE "DailyReport" SET "endMinuteOfDay" = "startMinuteOfDay"',
    );
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:DailyReport.timeRange');
  });

  it('rejects a source status outside the exact approved contract', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('UPDATE "DailyReport" SET "status" = \'draft\'');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:DailyReport.status');
  });

  it('requires a nonblank expense reason when expense is positive', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('UPDATE "DailyReport" SET "expenseReason" = \'   \'');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:DailyReport.expenseReason');
  });

  it('normalizes a blank zero-expense reason to null without fabricating one', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(
      'UPDATE "DailyReport" SET "expenseYen" = 0, "expenseReason" = \'   \'',
    );
    database.close();

    const report = (
      await createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath)
    ).dailyReports[0];
    expect(report.expenseReason).toBeNull();
  });

  it('rejects a negative shift sort order', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('UPDATE "Shift" SET "sortOrder" = -1 WHERE "id" = \'shift-day\'');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:Shift.sortOrder');
  });

  it('rejects a whitespace-only source id', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(
      'UPDATE "Shift" SET "id" = \'   \' WHERE "id" = \'shift-day\'; UPDATE "DailyReport" SET "shiftId" = \'   \'',
    );
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:Shift.id');
  });

  it.each([
    'previousImosBalanceYen',
    'currentImosBalanceYen',
    'newageYen',
    'cashTotalYen',
    'expenseYen',
    'staffMealCashYen',
    'staffMealAlipayYen',
  ])('domain-validates raw field %s', async (field) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(`UPDATE "DailyReport" SET "${field}" = -1`);
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_DAILY_REPORT_AMOUNT');
  });

  it('preserves source records and maps a legacy report to the DynamoDB contract', async () => {
    const fixture = createFixture();

    const bundle = await createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath);

    expect(bundle.shifts).toEqual([
      { id: 'shift-day', name: '白班', sortOrder: 10, active: false },
      { id: 'shift-night', name: '夜班', sortOrder: 20, active: true },
    ]);
    expect(bundle.responsiblePersons).toEqual([
      { id: 'person-1', name: '张三', active: true },
      { id: 'person-2', name: '李四', active: false },
    ]);
    expect(bundle.appSetting).toEqual({
      id: 'default',
      registerFloatAmount: 5_000,
      setupCompleted: true,
    });
    expect(bundle.dailyReports).toEqual([
      {
        reportKey: '2026-08-23#shift-day',
        businessDate: '2026-08-23',
        shiftId: 'shift-day',
        shiftNameSnapshot: '历史白班',
        responsiblePersonId: 'person-1',
        responsiblePersonSnapshot: '历史张三',
        startMinuteOfDay: 600,
        endMinuteOfDay: 900,
        timeRangeLabelSnapshot: '10:00 - 15:00',
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 16_000,
        newageYen: 8_000,
        cashTotalYen: 20_000,
        expenseYen: 300,
        expenseReason: '买菜',
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        attachmentKeys: [
          'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        ],
        submittedAt: '2026-08-23T15:01:02.000Z',
        legacySubmittedByUsername: 'kitchen-old',
      },
    ]);
    expect(bundle.sourceSummary.warnings).toEqual([
      {
        code: 'LEGACY_SUBMITTED_AT_FROM_UPDATED_AT',
        sourceId: 'legacy-report-1',
      },
    ]);
    expect(JSON.stringify(bundle)).not.toContain('$2b$secret-hash');
    expect(bundle.dailyReports[0]).not.toHaveProperty('owner');
    expect(bundle.dailyReports[0]).not.toHaveProperty('createdByUserId');
    expect(bundle.dailyReports[0]).not.toHaveProperty('role');
  });

  it('serializes identical source content byte-for-byte deterministically', async () => {
    const first = createFixture();
    const second = createFixture();

    const firstJson = serializeMigrationBundle(
      await createMigrationBundle(first.sqlitePath, first.uploadsPath),
    );
    const secondJson = serializeMigrationBundle(
      await createMigrationBundle(second.sqlitePath, second.uploadsPath),
    );

    expect(firstJson).toBe(secondJson);
  });

  it('fails closed and reports both source ids for a duplicate report key', async () => {
    const fixture = createFixture({ conflictingReport: true });

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toMatchObject({
      code: 'MIGRATION_REPORT_KEY_CONFLICT',
      conflicts: [
        {
          reportKey: '2026-08-23#shift-day',
          sourceIds: ['legacy-report-1', 'legacy-report-2'],
        },
      ],
      summary: {
        conflicts: [
          {
            reportKey: '2026-08-23#shift-day',
            sourceIds: ['legacy-report-1', 'legacy-report-2'],
          },
        ],
        orphans: [
          {
            sourceRelativeKey: 'unlinked.txt',
            byteSize: 6,
            sha256:
              '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
          },
        ],
      },
    });
  });

  it('reports exact raw and shared-domain-derived reconciliation totals', async () => {
    const fixture = createFixture();

    const summary = (await createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath))
      .sourceSummary;

    expect(summary.modelCounts).toEqual({
      shifts: 2,
      responsiblePersons: 2,
      appSettings: 1,
      dailyReports: 1,
      attachments: 1,
    });
    expect(summary.amounts).toEqual({
      byBusinessDate: {
        '2026-08-23': {
          raw: {
            previousImosBalanceYen: 10_000,
            currentImosBalanceYen: 16_000,
            newageYen: 8_000,
            cashTotalYen: 20_000,
            expenseYen: 300,
            staffMealCashYen: 1_200,
            staffMealAlipayYen: 800,
          },
          derived: {
            imosSalesYen: 6_000,
            cashDepositYen: 15_000,
            totalSalesYen: 21_800,
            deviationYen: 16_100,
            staffMealTotalYen: 2_000,
          },
        },
      },
      global: {
        raw: {
          previousImosBalanceYen: 10_000,
          currentImosBalanceYen: 16_000,
          newageYen: 8_000,
          cashTotalYen: 20_000,
          expenseYen: 300,
          staffMealCashYen: 1_200,
          staffMealAlipayYen: 800,
        },
        derived: {
          imosSalesYen: 6_000,
          cashDepositYen: 15_000,
          totalSalesYen: 21_800,
          deviationYen: 16_100,
          staffMealTotalYen: 2_000,
        },
      },
    });
    expect(summary.sourceUploadSummary).toEqual({
      count: 2,
      totalBytes: 17,
      hashes: [
        {
          sourceRelativeKey: 'legacy-report-1/receipt.txt',
          sha256: '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        },
        {
          sourceRelativeKey: 'unlinked.txt',
          sha256: '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
        },
      ],
    });
    expect(summary.targetAttachmentSummary).toEqual({
      count: 1,
      totalBytes: 11,
      hashes: [
        {
          objectKey:
            'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
          sha256:
            '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        },
      ],
    });
    expect(summary.orphans).toEqual([
      {
        sourceRelativeKey: 'unlinked.txt',
        byteSize: 6,
        sha256:
          '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
      },
    ]);
    expect(summary.conflicts).toEqual([]);
  });
});

describe('uploads inventory safety', () => {
  it('separates physical source evidence from linked target attachments', async () => {
    const fixture = createFixture();

    const inventory = await inventoryUploads(fixture.uploadsPath, [
      { legacyReportId: 'legacy-report-1', reportKey: '2026-08-23#shift-day' },
    ]);

    expect(inventory.sourceFiles).toEqual([
      {
        sourceRelativeKey: 'legacy-report-1/receipt.txt',
        byteSize: 11,
        sha256:
          '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        linkedReportKeys: ['2026-08-23#shift-day'],
      },
      {
        sourceRelativeKey: 'unlinked.txt',
        byteSize: 6,
        sha256:
          '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
        linkedReportKeys: [],
      },
    ]);
    expect(inventory.targetAttachments).toEqual([
      {
        sourceRelativeKey: 'legacy-report-1/receipt.txt',
        objectKey:
          'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        byteSize: 11,
        sha256:
          '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        reportKey: '2026-08-23#shift-day',
      },
    ]);
  });

  it('materializes one Task11-ready target entry per linked report', async () => {
    const fixture = createFixture();

    const inventory = await inventoryUploads(fixture.uploadsPath, [
      { legacyReportId: 'legacy-report-1', reportKey: '2026-08-23#shift-day' },
      { legacyReportId: 'legacy-report-1', reportKey: '2026-08-24#shift-day' },
    ]);

    expect(
      inventory.targetAttachments.map((entry) => ({
          objectKey: entry.objectKey,
          reportKey: entry.reportKey,
        })),
    ).toEqual([
      {
        objectKey:
          'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        reportKey: '2026-08-23#shift-day',
      },
      {
        objectKey:
          'migration/daily-reports/2026-08-24#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        reportKey: '2026-08-24#shift-day',
      },
    ]);
  });

  it('emits only linked entries that Task11 can consume unconditionally', async () => {
    const fixture = createFixture();
    const bundle = await createMigrationBundle(
      fixture.sqlitePath,
      fixture.uploadsPath,
    );

    expect(bundle.attachments).toHaveLength(1);
    for (const attachment of bundle.attachments) {
      expect(attachment.objectKey).toMatch(
        new RegExp(
          `^migration/daily-reports/${attachment.reportKey}/[0-9a-f]{64}-.+`,
          'u',
        ),
      );
      expect(
        bundle.dailyReports.find(
          (report) => report.reportKey === attachment.reportKey,
        )?.attachmentKeys,
      ).toContain(attachment.objectKey);
    }
    for (const report of bundle.dailyReports) {
      expect(report.attachmentKeys).toEqual(
        bundle.attachments
          .filter((entry) => entry.reportKey === report.reportKey)
          .map((entry) => entry.objectKey),
      );
      expect(report.attachmentKeys).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^migration/daily-reports/${report.reportKey}/[0-9a-f]{64}-.+`,
              'u',
            ),
          ),
        ]),
      );
    }
    expect(bundle.attachments).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectKey: expect.stringContaining('/orphans/') }),
      ]),
    );
  });

  it('rejects an unsafe bidi filename instead of embedding it in a target key', async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.uploadsPath, 'invoice\u202e.jpg'), 'unsafe');

    await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
      'INVALID_STORAGE_FILE_NAME',
    );
  });

  it('rejects a symlink that escapes the uploads root', async () => {
    const fixture = createFixture();
    const outside = join(fixture.root, 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(fixture.uploadsPath, 'escape.txt'));

    await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
      'UPLOAD_PATH_NOT_CANONICAL',
    );
  });

  it('rejects two source paths that normalize to the same object key', async () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.uploadsPath, 'duplicate'));
    writeFileSync(join(fixture.uploadsPath, 'duplicate', 'same.txt'), 'one');
    writeFileSync(join(fixture.uploadsPath, 'duplicate\\same.txt'), 'two');

    await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
      'DUPLICATE_UPLOAD_KEY',
    );
  });

  it('fails closed when a file cannot be hashed', async () => {
    const fixture = createFixture();
    const unreadable = join(fixture.uploadsPath, 'unreadable.txt');
    writeFileSync(unreadable, 'secret');
    chmodSync(unreadable, 0o000);
    try {
      await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
        'UPLOAD_HASH_FAILED',
      );
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });

  it('rejects a parent directory swapped to a symlink before file open', async () => {
    const fixture = createFixture();
    const declaredDirectory = join(fixture.uploadsPath, 'legacy-report-1');
    const movedDirectory = join(fixture.uploadsPath, 'legacy-report-1-moved');
    const outsideDirectory = join(fixture.root, 'outside-directory');
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'receipt.txt'), 'replacement');

    await expect(
      inventoryUploads(
        fixture.uploadsPath,
        [],
        {
          beforeOpen: ({ sourceRelativeKey }) => {
            if (sourceRelativeKey !== 'legacy-report-1/receipt.txt') return;
            renameSync(declaredDirectory, movedDirectory);
            symlinkSync(outsideDirectory, declaredDirectory);
          },
        },
      ),
    ).rejects.toThrow('UPLOAD_PATH_NOT_CANONICAL');
  });

  it('rejects a same-size file mutation between hash read and post-stat', async () => {
    const fixture = createFixture();

    await expect(
      inventoryUploads(
        fixture.uploadsPath,
        [],
        {
          afterRead: ({ sourceRelativeKey, canonicalPath }) => {
            if (sourceRelativeKey === 'unlinked.txt') {
              writeFileSync(canonicalPath, 'change');
            }
          },
        },
      ),
    ).rejects.toThrow('UPLOAD_FILE_CHANGED');
  });

  it.each([
    [
      'an added entry',
      (fixture: ReturnType<typeof createFixture>) => {
        writeFileSync(join(fixture.uploadsPath, 'added.txt'), 'added');
      },
    ],
    [
      'a deleted entry',
      (fixture: ReturnType<typeof createFixture>) => {
        rmSync(join(fixture.uploadsPath, 'unlinked.txt'));
      },
    ],
    [
      'a renamed entry',
      (fixture: ReturnType<typeof createFixture>) => {
        renameSync(
          join(fixture.uploadsPath, 'unlinked.txt'),
          join(fixture.uploadsPath, 'renamed.txt'),
        );
      },
    ],
    [
      'a directory replaced by a symlink',
      (fixture: ReturnType<typeof createFixture>) => {
        const directory = join(fixture.uploadsPath, 'legacy-report-1');
        const moved = join(fixture.root, 'moved-directory');
        const replacement = join(fixture.root, 'replacement-directory');
        mkdirSync(replacement);
        renameSync(directory, moved);
        symlinkSync(replacement, directory);
      },
    ],
    [
      'a file mutated after hashing',
      (fixture: ReturnType<typeof createFixture>) => {
        writeFileSync(join(fixture.uploadsPath, 'unlinked.txt'), 'change');
      },
    ],
  ])('rejects tree snapshot change from %s', async (_label, mutateTree) => {
    const fixture = createFixture();

    await expect(
      inventoryUploads(fixture.uploadsPath, [], {
        beforeFinalTreeCheck: () => mutateTree(fixture),
      }),
    ).rejects.toThrow('UPLOAD_TREE_CHANGED');
  });

  it('rejects a special filesystem entry', async () => {
    const fixture = createFixture();
    const socketPath = join(fixture.uploadsPath, 'inventory.sock');
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, resolveListen);
    });
    try {
      await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
        'UPLOAD_PATH_NOT_CANONICAL',
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe('dry-run CLI', () => {
  function runCli(args: string[]) {
    return spawnSync(
      'pnpm',
      ['exec', 'tsx', 'apps/api/scripts/amplify-migration/transform.ts', ...args],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
  }

  it('requires explicit sqlite, uploads and out arguments', () => {
    const result = runCli([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MIGRATION_ARGUMENT_REQUIRED');
  });

  it('rejects an output directory inside the repository', () => {
    const fixture = createFixture();
    const result = runCli([
      '--sqlite',
      fixture.sqlitePath,
      '--uploads',
      fixture.uploadsPath,
      '--out',
      join(repositoryRoot, 'forbidden-migration-output'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  });

  it('rejects output in the primary checkout that contains this linked worktree', () => {
    const primaryCheckout = resolve(repositoryRoot, '..', '..');
    const result = runCli([
      '--sqlite',
      join(primaryCheckout, 'missing-fixture.sqlite'),
      '--uploads',
      join(primaryCheckout, 'missing-uploads'),
      '--out',
      join(primaryCheckout, 'forbidden-migration-output'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  });

  it.each([
    ['inside uploads', (fixture: ReturnType<typeof createFixture>) => join(fixture.uploadsPath, 'output')],
    ['inside the SQLite file path', (fixture: ReturnType<typeof createFixture>) => join(fixture.sqlitePath, 'output')],
    ['as an ancestor of both sources', (fixture: ReturnType<typeof createFixture>) => fixture.root],
  ])('rejects output %s', async (_label, outputFor) => {
    const fixture = createFixture();

    await expect(
      runDryRunCli([
        '--sqlite',
        fixture.sqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        outputFor(fixture),
      ]),
    ).rejects.toThrow('MIGRATION_OUTPUT_SOURCE_OVERLAP');
  });

  it('rejects a SQLite source located inside the uploads source', async () => {
    const fixture = createFixture();
    const nestedSqlitePath = join(fixture.uploadsPath, 'fixture.sqlite');
    renameSync(fixture.sqlitePath, nestedSqlitePath);

    await expect(
      runDryRunCli([
        '--sqlite',
        nestedSqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        join(fixture.root, 'output'),
      ]),
    ).rejects.toThrow('MIGRATION_SOURCE_OVERLAP');
  });

  it('rejects an output ancestor that contains the repository', async () => {
    const fixture = createFixture();
    const repositoryAncestor = resolve(repositoryRoot, '..', '..', '..');

    await expect(
      runDryRunCli([
        '--sqlite',
        fixture.sqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        repositoryAncestor,
      ]),
    ).rejects.toThrow('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  });

  it('fails and leaves no output when the output parent is swapped before writing', async () => {
    const fixture = createFixture();
    const outputRoot = temporaryRoot();
    const safeParent = join(outputRoot, 'safe-parent');
    const movedParent = join(outputRoot, 'moved-parent');
    const replacementParent = join(outputRoot, 'replacement-parent');
    mkdirSync(safeParent);
    mkdirSync(replacementParent);
    const outputPath = join(safeParent, 'result');

    await expect(
      runDryRunCli(
        [
          '--sqlite',
          fixture.sqlitePath,
          '--uploads',
          fixture.uploadsPath,
          '--out',
          outputPath,
        ],
        repositoryRoot,
        {
          beforeOutputWrite: () => {
            renameSync(safeParent, movedParent);
            symlinkSync(replacementParent, safeParent);
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_PATH_CHANGED');
    expect(() => readFileSync(join(outputPath, 'migration-bundle.json'))).toThrow();
  });

  it('fails and leaves no output when the output parent is swapped before commit', async () => {
    const fixture = createFixture();
    const outputRoot = temporaryRoot();
    const safeParent = join(outputRoot, 'safe-parent');
    const movedParent = join(outputRoot, 'moved-parent');
    const replacementParent = join(outputRoot, 'replacement-parent');
    mkdirSync(safeParent);
    mkdirSync(replacementParent);
    const outputPath = join(safeParent, 'result');

    await expect(
      runDryRunCli(
        [
          '--sqlite',
          fixture.sqlitePath,
          '--uploads',
          fixture.uploadsPath,
          '--out',
          outputPath,
        ],
        repositoryRoot,
        {
          beforeOutputCommit: () => {
            renameSync(safeParent, movedParent);
            symlinkSync(replacementParent, safeParent);
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_PATH_CHANGED');
    expect(() => readFileSync(join(outputPath, 'migration-report.json'))).toThrow();
  });

  it('writes only held files when the parent is swapped after the last path check', async () => {
    const fixture = createFixture();
    const outputRoot = temporaryRoot();
    const safeParent = join(outputRoot, 'safe-parent');
    const movedParent = join(outputRoot, 'moved-parent');
    mkdirSync(safeParent);
    const outputPath = join(safeParent, 'result');

    await expect(
      runDryRunCli(
        [
          '--sqlite',
          fixture.sqlitePath,
          '--uploads',
          fixture.uploadsPath,
          '--out',
          outputPath,
        ],
        repositoryRoot,
        {
          beforeAnchoredFileWrite: () => {
            renameSync(safeParent, movedParent);
            symlinkSync(fixture.uploadsPath, safeParent);
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_PATH_CHANGED');
    expect(() =>
      readFileSync(join(fixture.uploadsPath, 'result', 'migration-report.json')),
    ).toThrow();
    expect(process.cwd()).toBe(repositoryRoot);
  });

  it('never writes through a late parent swap into a repository boundary', async () => {
    const fixture = createFixture();
    const fakeRepository = temporaryRoot();
    const outputRoot = temporaryRoot();
    const safeParent = join(outputRoot, 'safe-parent');
    const movedParent = join(outputRoot, 'moved-parent');
    mkdirSync(safeParent);
    const outputPath = join(safeParent, 'result');

    await expect(
      runDryRunCli(
        [
          '--sqlite',
          fixture.sqlitePath,
          '--uploads',
          fixture.uploadsPath,
          '--out',
          outputPath,
        ],
        fakeRepository,
        {
          beforeAnchoredFileWrite: () => {
            renameSync(safeParent, movedParent);
            symlinkSync(fakeRepository, safeParent);
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_PATH_CHANGED');
    expect(() =>
      readFileSync(join(fakeRepository, 'result', 'migration-report.json')),
    ).toThrow();
    expect(process.cwd()).toBe(repositoryRoot);
  });

  it('does not expose output paths before source processing is complete', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'status-output');
    let outputWasVisible = false;

    await runDryRunCli(
      [
        '--sqlite',
        fixture.sqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        outputPath,
      ],
        repositoryRoot,
        {
          beforeOutputWrite: () => {
            try {
              readFileSync(join(outputPath, 'migration-status.json'), 'utf8');
              outputWasVisible = true;
            } catch {
              outputWasVisible = false;
            }
          },
        },
      );

    expect(outputWasVisible).toBe(false);
    expect(
      JSON.parse(readFileSync(join(outputPath, 'migration-status.json'), 'utf8')),
    ).toEqual({ status: 'complete', errorCode: null });
  });

  it('runs concurrently without changing caller cwd or cleaning another run', async () => {
    const first = createFixture();
    const second = createFixture();
    const sharedOutputParent = temporaryRoot();
    const firstOutput = join(sharedOutputParent, 'output-one');
    const secondOutput = join(sharedOutputParent, 'output-two');
    const callerCwd = process.cwd();
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    const barrier = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothArrived;
    };

    const results = await Promise.allSettled([
      runDryRunCli(
        ['--sqlite', first.sqlitePath, '--uploads', first.uploadsPath, '--out', firstOutput],
        repositoryRoot,
        { beforeOutputWrite: barrier },
      ),
      runDryRunCli(
        ['--sqlite', second.sqlitePath, '--uploads', second.uploadsPath, '--out', secondOutput],
        repositoryRoot,
        { beforeOutputWrite: barrier },
      ),
    ]);
    process.chdir(callerCwd);

    expect(results).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]);
    expect(process.cwd()).toBe(callerCwd);
    expect(readFileSync(join(firstOutput, 'migration-bundle.json'), 'utf8')).toBe(
      readFileSync(join(secondOutput, 'migration-bundle.json'), 'utf8'),
    );
    expect(
      JSON.parse(readFileSync(join(firstOutput, 'migration-status.json'), 'utf8')),
    ).toEqual({ status: 'complete', errorCode: null });
    expect(
      JSON.parse(readFileSync(join(secondOutput, 'migration-status.json'), 'utf8')),
    ).toEqual({ status: 'complete', errorCode: null });
  });

  it('never cross-cleans a successful concurrent run when its peer aborts', async () => {
    const failed = createFixture();
    const successful = createFixture();
    const sharedOutputParent = temporaryRoot();
    const failedOutput = join(sharedOutputParent, 'failed-output');
    const successfulOutput = join(sharedOutputParent, 'successful-output');
    const evidencePath = join(failed.root, 'failed-hardlink-evidence');
    const callerCwd = process.cwd();
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    const barrier = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothArrived;
    };

    const results = await Promise.allSettled([
      runDryRunCli(
        ['--sqlite', failed.sqlitePath, '--uploads', failed.uploadsPath, '--out', failedOutput],
        repositoryRoot,
        {
          beforeOutputWrite: barrier,
          beforeWorkerFileWrite: ({ fileKind, stagingFilePath }) => {
            if (fileKind === 'bundle') linkSync(stagingFilePath, evidencePath);
          },
        },
      ),
      runDryRunCli(
        [
          '--sqlite',
          successful.sqlitePath,
          '--uploads',
          successful.uploadsPath,
          '--out',
          successfulOutput,
        ],
        repositoryRoot,
        { beforeOutputWrite: barrier },
      ),
    ]);

    expect(process.cwd()).toBe(callerCwd);
    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: { message: 'MIGRATION_OUTPUT_ANCHOR_CHANGED' },
    });
    expect(results[1]).toEqual({ status: 'fulfilled', value: undefined });
    expect(() => readFileSync(join(failedOutput, 'migration-status.json'))).toThrow();
    expect(
      JSON.parse(readFileSync(join(successfulOutput, 'migration-status.json'), 'utf8')),
    ).toEqual({ status: 'complete', errorCode: null });
  });

  it('uses the SQLite snapshot bound before a 5000-to-6000-to-5000 ABA swap', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'sqlite-aba-output');
    let sourceHookRan = false;

    await runDryRunCli(
      ['--sqlite', fixture.sqlitePath, '--uploads', fixture.uploadsPath, '--out', outputPath],
      repositoryRoot,
      {
        afterSourcesBound: () => {
          sourceHookRan = true;
          const database = new DatabaseSync(fixture.sqlitePath);
          database.prepare(
            'UPDATE "AppSettings" SET "registerFloatAmount" = 6000 WHERE "id" = \'default\'',
          ).run();
          database.close();
        },
        beforeSourceIdentityEvidence: () => {
          const database = new DatabaseSync(fixture.sqlitePath);
          database.prepare(
            'UPDATE "AppSettings" SET "registerFloatAmount" = 5000 WHERE "id" = \'default\'',
          ).run();
          database.close();
        },
      },
    );

    expect(sourceHookRan).toBe(true);
    expect(
      JSON.parse(readFileSync(join(outputPath, 'migration-bundle.json'), 'utf8'))
        .appSetting.registerFloatAmount,
    ).toBe(5_000);
  });

  it('inventories the uploads root inode bound before an ABA replacement', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'uploads-aba-output');
    const movedUploads = join(fixture.root, 'uploads-original');
    let sourceHookRan = false;

    await runDryRunCli(
      ['--sqlite', fixture.sqlitePath, '--uploads', fixture.uploadsPath, '--out', outputPath],
      repositoryRoot,
      {
        afterSourcesBound: () => {
          sourceHookRan = true;
          renameSync(fixture.uploadsPath, movedUploads);
          mkdirSync(join(fixture.uploadsPath, 'legacy-report-1'), {
            recursive: true,
          });
          writeFileSync(
            join(fixture.uploadsPath, 'legacy-report-1', 'receipt.txt'),
            'replacement-upload',
          );
        },
        beforeSourceIdentityEvidence: () => {
          rmSync(fixture.uploadsPath, { recursive: true, force: true });
          renameSync(movedUploads, fixture.uploadsPath);
        },
      },
    );

    expect(sourceHookRan).toBe(true);
    const bundle = JSON.parse(
      readFileSync(join(outputPath, 'migration-bundle.json'), 'utf8'),
    );
    expect(bundle.attachments[0].sha256).toBe(
      createHash('sha256').update('receipt-one').digest('hex'),
    );
  });

  it.each(['bundle', 'report', 'status'] as const)(
    'rejects a hardlink before the %s write without writing source bytes',
    async (fileKind) => {
      const fixture = createFixture();
      const outputPath = join(fixture.root, `hardlink-before-${fileKind}`);
      const evidencePath = join(fixture.root, `evidence-before-${fileKind}`);

      await expect(
        runDryRunCli(
          ['--sqlite', fixture.sqlitePath, '--uploads', fixture.uploadsPath, '--out', outputPath],
          repositoryRoot,
          {
            beforeWorkerFileWrite: (context) => {
              if (context.fileKind === fileKind) {
                linkSync(context.stagingFilePath, evidencePath);
              }
            },
          },
        ),
      ).rejects.toThrow('MIGRATION_OUTPUT_ANCHOR_CHANGED');
      expect(readFileSync(evidencePath)).toHaveLength(0);
      expect(() => readFileSync(join(outputPath, 'migration-status.json'))).toThrow();
    },
  );

  it('keeps held writes off sources when the private staging path is replaced', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'stage-swap-output');
    let swapped = false;

    await expect(
      runDryRunCli(
        ['--sqlite', fixture.sqlitePath, '--uploads', fixture.uploadsPath, '--out', outputPath],
        repositoryRoot,
        {
          beforeWorkerFileWrite: ({ fileKind, stagingFilePath }) => {
            if (fileKind !== 'bundle' || swapped) return;
            swapped = true;
            const stagePath = dirname(stagingFilePath);
            renameSync(stagePath, `${stagePath}-moved`);
            symlinkSync(fixture.uploadsPath, stagePath);
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_ANCHOR_CHANGED');
    expect(swapped).toBe(true);
    expect(() => readFileSync(join(outputPath, 'migration-status.json'))).toThrow();
    expect(() =>
      readFileSync(join(fixture.uploadsPath, 'migration-bundle.json')),
    ).toThrow();
    expect(() =>
      readFileSync(join(fixture.uploadsPath, 'migration-report.json')),
    ).toThrow();
  });

  it.each(['bundle', 'report', 'status'] as const)(
    'aborts after detecting a hardlink after the %s write',
    async (fileKind) => {
      const fixture = createFixture();
      const outputPath = join(fixture.root, `hardlink-after-${fileKind}`);
      const evidencePath = join(fixture.root, `evidence-after-${fileKind}`);

      await expect(
        runDryRunCli(
          ['--sqlite', fixture.sqlitePath, '--uploads', fixture.uploadsPath, '--out', outputPath],
          repositoryRoot,
          {
            afterWorkerFileWrite: (context) => {
              if (context.fileKind === fileKind) {
                linkSync(context.stagingFilePath, evidencePath);
              }
            },
          },
        ),
      ).rejects.toThrow('MIGRATION_OUTPUT_ANCHOR_CHANGED');
      expect(readFileSync(evidencePath).byteLength).toBeGreaterThan(0);
      expect(() => readFileSync(join(outputPath, 'migration-status.json'))).toThrow();
    },
  );

  it('revalidates the complete held file set after status finalization before publication', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'late-bundle-hardlink-output');
    const evidencePath = join(fixture.root, 'late-bundle-hardlink-evidence');
    let bundleStagingPath: string | undefined;

    await expect(
      runDryRunCli(
        ['--sqlite', fixture.sqlitePath, '--uploads', fixture.uploadsPath, '--out', outputPath],
        repositoryRoot,
        {
          afterWorkerFileWrite: ({ fileKind, stagingFilePath }) => {
            if (fileKind === 'bundle') bundleStagingPath = stagingFilePath;
            if (fileKind === 'status') {
              if (!bundleStagingPath) throw new Error('TEST_BUNDLE_PATH_MISSING');
              linkSync(bundleStagingPath, evidencePath);
            }
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_ANCHOR_CHANGED');
    expect(readFileSync(evidencePath).byteLength).toBeGreaterThan(0);
    expect(() => readFileSync(join(outputPath, 'migration-status.json'))).toThrow();
    expect(
      readdirSync(fixture.root).filter((name) =>
        name.startsWith('.fsk-migration-output-'),
      ),
    ).toEqual([]);
  });

  it('rejects a completed bundle directory entry replaced under the same name before publication', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'replaced-bundle-entry-output');
    const evidencePath = join(fixture.root, 'original-bundle-evidence.json');
    let bundleStagingPath: string | undefined;

    await expect(
      runDryRunCli(
        ['--sqlite', fixture.sqlitePath, '--uploads', fixture.uploadsPath, '--out', outputPath],
        repositoryRoot,
        {
          afterWorkerFileWrite: ({ fileKind, stagingFilePath }) => {
            if (fileKind === 'bundle') bundleStagingPath = stagingFilePath;
            if (fileKind !== 'status') return;
            if (!bundleStagingPath) throw new Error('TEST_BUNDLE_PATH_MISSING');
            renameSync(bundleStagingPath, evidencePath);
            writeFileSync(bundleStagingPath, readFileSync(evidencePath));
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_ANCHOR_CHANGED');
    expect(
      JSON.parse(readFileSync(evidencePath, 'utf8')).dailyReports[0].reportKey,
    ).toBe('2026-08-23#shift-day');
    expect(existsSync(outputPath)).toBe(false);
    expect(
      readdirSync(fixture.root).filter((name) =>
        name.startsWith('.fsk-migration-output-'),
      ),
    ).toEqual([]);
  });

  it('publishes a valid aborted status when source validation fails', async () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'aborted-output');
    const database = new DatabaseSync(fixture.sqlitePath);
    database.prepare('UPDATE "DailyReport" SET "status" = \'draft\'').run();
    database.close();

    await expect(
      runDryRunCli([
        '--sqlite',
        fixture.sqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        outputPath,
      ]),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:DailyReport.status');
    expect(
      JSON.parse(readFileSync(join(outputPath, 'migration-status.json'), 'utf8')),
    ).toEqual({
      status: 'aborted',
      errorCode: 'INVALID_SQLITE_SOURCE_FIELD:DailyReport.status',
    });
    expect(() => readFileSync(join(outputPath, 'migration-report.json'))).toThrow();
  });

  it('writes a deterministic bundle and report outside the repository without changing sources', () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'dry-run-output');
    const databaseHashBefore = sha256(fixture.sqlitePath);
    const uploadHashBefore = sha256(
      join(fixture.uploadsPath, 'legacy-report-1', 'receipt.txt'),
    );

    const result = runCli([
      '--sqlite',
      fixture.sqlitePath,
      '--uploads',
      fixture.uploadsPath,
      '--out',
      outputPath,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(outputPath, 'migration-bundle.json'), 'utf8')))
      .toMatchObject({ dailyReports: [{ reportKey: '2026-08-23#shift-day' }] });
    expect(JSON.parse(readFileSync(join(outputPath, 'migration-report.json'), 'utf8')))
      .toMatchObject({ modelCounts: { dailyReports: 1 }, conflicts: [] });
    expect(JSON.parse(readFileSync(join(outputPath, 'migration-status.json'), 'utf8')))
      .toEqual({ status: 'complete', errorCode: null });
    expect(sha256(fixture.sqlitePath)).toBe(databaseHashBefore);
    expect(
      sha256(join(fixture.uploadsPath, 'legacy-report-1', 'receipt.txt')),
    ).toBe(uploadHashBefore);
  });

  it('writes a complete deterministic report but no bundle when report keys conflict', () => {
    const fixture = createFixture({ conflictingReport: true });
    const outputPath = join(fixture.root, 'conflict-output');

    const result = runCli([
      '--sqlite',
      fixture.sqlitePath,
      '--uploads',
      fixture.uploadsPath,
      '--out',
      outputPath,
    ]);

    expect(result.status).toBe(1);
    const reportBytes = readFileSync(
      join(outputPath, 'migration-report.json'),
      'utf8',
    );
    expect(JSON.parse(reportBytes)).toMatchObject({
      conflicts: [
        {
          reportKey: '2026-08-23#shift-day',
          sourceIds: ['legacy-report-1', 'legacy-report-2'],
        },
      ],
      orphans: [
        {
          sourceRelativeKey: 'unlinked.txt',
          byteSize: 6,
          sha256:
            '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
        },
      ],
    });
    expect(
      JSON.parse(readFileSync(join(outputPath, 'migration-status.json'), 'utf8')),
    ).toEqual({
      status: 'conflict',
      errorCode: 'MIGRATION_REPORT_KEY_CONFLICT',
    });
    expect(reportBytes.endsWith('\n')).toBe(true);
    expect(() => readFileSync(join(outputPath, 'migration-bundle.json'))).toThrow();

    const secondFixture = createFixture({ conflictingReport: true });
    const secondOutputPath = join(secondFixture.root, 'conflict-output');
    const secondResult = runCli([
      '--sqlite',
      secondFixture.sqlitePath,
      '--uploads',
      secondFixture.uploadsPath,
      '--out',
      secondOutputPath,
    ]);
    expect(secondResult.status).toBe(1);
    expect(
      readFileSync(join(secondOutputPath, 'migration-report.json'), 'utf8'),
    ).toBe(reportBytes);
  });
});
