import { expect, it, vi } from 'vitest';

import type { CreateDailyReportCommand } from './daily-reports';
import { kitchenReportsRepository } from './kitchen-reports';

const { fetchAuthSession, submitKitchenReport } = vi.hoisted(() => ({
  fetchAuthSession: vi.fn(),
  submitKitchenReport: vi.fn(),
}));

vi.mock('aws-amplify/auth', () => ({ fetchAuthSession }));
vi.mock('./client', () => ({
  getDataClient: () => ({ mutations: { submitKitchenReport } }),
}));

it('uses the ID token to authorize a kitchen report with an uploaded attachment', async () => {
  fetchAuthSession.mockResolvedValue({
    tokens: {
      accessToken: { toString: () => 'access-token' },
      idToken: {
        payload: { 'cognito:groups': ['KITCHEN'], 'cognito:username': 'store02' },
        toString: () => 'id-token',
      },
    },
  });
  const command: CreateDailyReportCommand = {
    businessDate: '2026-11-27',
    shiftId: '02_day',
    shiftNameSnapshot: 'Day',
    responsiblePersonId: '02_operator',
    responsiblePersonSnapshot: 'Operator',
    startMinuteOfDay: 540,
    endMinuteOfDay: 1020,
    timeRangeLabelSnapshot: '09:00–17:00',
    registerFloatSnapshot: 10_000,
    previousImosBalanceYen: 0,
    currentImosBalanceYen: 500,
    newageYen: 500,
    cashTotalYen: 10_000,
    expenseYen: 100,
    expenseReason: 'Supplies',
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
    attachmentKeys: ['submissions/ap-northeast-1:00000000-0000-0000-0000-000000000001/draft/receipt/receipt.png'],
  };
  const saved = { reportKey: '02#2026-11-27#02_day', submittedAt: '2026-11-28T05:00:00.000Z' };
  submitKitchenReport.mockResolvedValue({ data: saved });

  await expect(kitchenReportsRepository.create(command)).resolves.toEqual({ ...command, ...saved });

  expect(submitKitchenReport).toHaveBeenCalledExactlyOnceWith(
    { input: JSON.stringify({ ...command, storeId: '02' }) },
    { authToken: 'id-token' },
  );
});
