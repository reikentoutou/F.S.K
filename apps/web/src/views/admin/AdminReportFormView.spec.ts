import { describe, expect, it, vi } from 'vitest';

import type { CreateDailyReportCommand } from '@/data/daily-reports';
import { DataRepositoryError } from '@/data/errors';
import * as reportView from './AdminReportFormView.vue';

interface ReportActions {
  saveOwnerReport(
    reportKey: string | null,
    command: CreateDailyReportCommand,
    repository: {
      create(command: CreateDailyReportCommand): Promise<unknown>;
      updateByReportKey(reportKey: string, changes: unknown): Promise<unknown>;
    },
  ): Promise<unknown>;
  loadOwnerReport(
    reportKey: string,
    repository: { getByReportKey(reportKey: string): Promise<unknown> },
  ): Promise<unknown>;
  ownerReportDataErrorMessage(error: unknown, fallback: string): string;
}

const actions = reportView as unknown as ReportActions;
const command: CreateDailyReportCommand = {
  businessDate: '2026-08-24',
  shiftId: 'day',
  shiftNameSnapshot: '日班',
  responsiblePersonId: 'p1',
  responsiblePersonSnapshot: '张三',
  startMinuteOfDay: 540,
  endMinuteOfDay: 1020,
  timeRangeLabelSnapshot: '09:00–17:00',
  previousImosBalanceYen: 10_000,
  currentImosBalanceYen: 20_000,
  newageYen: 3_000,
  cashTotalYen: 12_000,
  expenseYen: 500,
  expenseReason: '消耗品',
  staffMealCashYen: 800,
  staffMealAlipayYen: 600,
  attachmentKeys: ['receipts/a.jpg'],
};

describe('OWNER report repository actions', () => {
  it('creates a backfill through create without a client-supplied owner', async () => {
    const create = vi.fn().mockResolvedValue({ reportKey: '2026-08-24#day' });
    const updateByReportKey = vi.fn();

    await actions.saveOwnerReport(null, command, { create, updateByReportKey });

    expect(create).toHaveBeenCalledWith(command);
    expect(updateByReportKey).not.toHaveBeenCalled();
    expect(command).not.toHaveProperty('owner');
  });

  it('gets an edit by reportKey and updates only mutable fields', async () => {
    const getByReportKey = vi.fn().mockResolvedValue({
      reportKey: '2026-08-24#day',
      submittedAt: '2026-08-24T10:00:00.000Z',
    });
    await expect(
      actions.loadOwnerReport('2026-08-24#day', { getByReportKey }),
    ).resolves.toMatchObject({ reportKey: '2026-08-24#day' });
    expect(getByReportKey).toHaveBeenCalledWith('2026-08-24#day');

    const updateByReportKey = vi.fn().mockResolvedValue({});
    await actions.saveOwnerReport('2026-08-24#day', command, {
      create: vi.fn(),
      updateByReportKey,
    });

    expect(updateByReportKey).toHaveBeenCalledOnce();
    expect(updateByReportKey.mock.calls[0]![0]).toBe('2026-08-24#day');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('reportKey');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('businessDate');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('shiftId');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('owner');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('submittedAt');
  });

  it.each([
    ['DATA_UNAUTHORIZED', '权限不足'],
    ['DATA_NOT_FOUND', '未找到'],
    ['DATA_CONFLICT', '冲突'],
    ['DATA_PAGINATION_FAILED', '分页'],
    ['DATA_NETWORK_ERROR', '网络'],
  ] as const)('shows a stable %s page message', (code, text) => {
    expect(
      actions.ownerReportDataErrorMessage(
        new DataRepositoryError(code),
        'fallback',
      ),
    ).toContain(text);
  });
});
