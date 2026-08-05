import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { SetupService } from '../src/setup/setup.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { reconcileFixedShifts } from '../src/shifts/reconcile-fixed-shifts';

type ShiftRow = {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
};

function fakeShiftTransaction(seed: ShiftRow[]) {
  const rows = seed.map((row) => ({ ...row }));
  let nextId = 1;
  const tx = {
    shift: {
      findMany: vi.fn(async () =>
        [...rows].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
        ),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Pick<ShiftRow, 'sortOrder' | 'active'>>;
        }) => {
          const row = rows.find((item) => item.id === where.id);
          if (!row) throw new Error(`missing shift ${where.id}`);
          Object.assign(row, data);
          return { ...row };
        },
      ),
      create: vi.fn(
        async ({ data }: { data: Omit<ShiftRow, 'id'> }) => {
          const row = { id: `created-${nextId++}`, ...data };
          rows.push(row);
          return { ...row };
        },
      ),
    },
  } as unknown as Prisma.TransactionClient;

  return { rows, tx };
}

function normalizedRows(rows: ShiftRow[]) {
  return rows
    .map(({ id, name, sortOrder, active }) => ({ id, name, sortOrder, active }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

describe('reconcileFixedShifts', () => {
  it('reuses day and night ids, creates missing shifts, and deactivates extras', async () => {
    const { rows, tx } = fakeShiftTransaction([
      { id: 'extra', name: '临时班', sortOrder: 0, active: true },
      { id: 'day', name: '白班', sortOrder: 1, active: true },
      { id: 'night', name: '夜班', sortOrder: 2, active: true },
      { id: 'day-copy', name: '白班', sortOrder: 5, active: true },
    ]);

    await reconcileFixedShifts(tx);

    expect(
      rows
        .filter((row) => row.active)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    ).toEqual([
      { id: 'created-1', name: '网管早班', sortOrder: 1 },
      { id: 'day', name: '白班', sortOrder: 2 },
      { id: 'night', name: '夜班', sortOrder: 3 },
      { id: 'created-2', name: '网管夜班', sortOrder: 4 },
    ]);
    expect(rows.find((row) => row.id === 'extra')?.active).toBe(false);
    expect(rows.find((row) => row.id === 'day-copy')?.active).toBe(false);
    const rowsAfterFirstReconciliation = normalizedRows(rows);

    await reconcileFixedShifts(tx);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.active)).toHaveLength(4);
    expect(normalizedRows(rows)).toEqual(rowsAfterFirstReconciliation);
  });

  it('runs shift reconciliation through a Prisma transaction during setup', async () => {
    const { rows, tx } = fakeShiftTransaction([]);
    const transaction = vi.fn(
      async (callback: (client: Prisma.TransactionClient) => Promise<void>) =>
        callback(tx),
    );
    const prisma = {
      $transaction: transaction,
      appSettings: { upsert: vi.fn() },
      responsiblePerson: { count: vi.fn().mockResolvedValue(1) },
    } as unknown as PrismaService;

    await new SetupService(prisma).ensureSeedData();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rows.filter((row) => row.active)).toHaveLength(4);
  });
});
