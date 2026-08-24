import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { DataRepositoryError } from '@/data/errors';

import { loadKitchenHomeContext } from './KitchenHomeView.vue';
import {
  createKitchenReport,
  kitchenHomePath,
  kitchenReportMode,
  isCurrentKitchenBusinessDate,
  kitchenSubmissionFailure,
  loadKitchenReportContext,
  uploadKitchenReportAttachment,
} from './KitchenReportView.vue';

describe('kitchen create-only views', () => {
  it('loads the landing page only through getKitchenContext', async () => {
    const context = {
      registerFloatAmount: 5_000,
      shifts: [{ id: 'day', name: '日班', sortOrder: 10 }],
      responsiblePersons: [{ id: 'p1', name: '张三' }],
    };
    const getContext = vi.fn().mockResolvedValue(context);

    await expect(loadKitchenHomeContext({ getContext })).resolves.toEqual(
      context,
    );
    expect(getContext).toHaveBeenCalledOnce();
  });

  it('rejects a missing context and removes nullable generated list entries', async () => {
    const context = {
      registerFloatAmount: 5_000,
      shifts: [null, { id: 'day', name: '日班', sortOrder: 10 }],
      responsiblePersons: [undefined, { id: 'p1', name: '张三' }],
    };

    await expect(
      loadKitchenReportContext(
        {
          getContext: vi.fn().mockResolvedValue(context),
        },
        '2026-08-24',
        '2026-08-24',
      ),
    ).resolves.toEqual({
      registerFloatAmount: 5_000,
      shifts: [{ id: 'day', name: '日班', sortOrder: 10 }],
      responsiblePersons: [{ id: 'p1', name: '张三' }],
    });
    await expect(
      loadKitchenHomeContext({
        getContext: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('KITCHEN_CONTEXT_UNAVAILABLE');
  });

  it('rejects a hand-edited historical or future kitchen date before loading context', async () => {
    const getContext = vi.fn();

    expect(
      isCurrentKitchenBusinessDate('2026-08-24', '2026-08-24'),
    ).toBe(true);
    expect(
      isCurrentKitchenBusinessDate('2026-08-23', '2026-08-24'),
    ).toBe(false);
    expect(
      isCurrentKitchenBusinessDate('2026-08-25', '2026-08-24'),
    ).toBe(false);
    await expect(
      loadKitchenReportContext(
        { getContext },
        '2026-08-23',
        '2026-08-24',
      ),
    ).rejects.toThrow('KITCHEN_BUSINESS_DATE_NOT_CURRENT');
    expect(getContext).not.toHaveBeenCalled();
  });

  it('submits a report only through the create capability', async () => {
    const command = {
      businessDate: '2026-08-24',
      shiftId: 'day',
      shiftNameSnapshot: '日班',
      responsiblePersonId: 'p1',
      responsiblePersonSnapshot: '张三',
      startMinuteOfDay: 540,
      endMinuteOfDay: 1020,
      timeRangeLabelSnapshot: '09:00–17:00',
      previousImosBalanceYen: 100_000,
      currentImosBalanceYen: 120_000,
      newageYen: 8_000,
      cashTotalYen: 20_000,
      expenseYen: 500,
      expenseReason: '消耗品',
      staffMealCashYen: 1_200,
      staffMealAlipayYen: 800,
      attachmentKeys: [],
    };
    const response = {
      reportKey: '2026-08-24#day',
      ...command,
      submittedAt: '2026-08-24T10:11:12.000Z',
    };
    const create = vi.fn().mockResolvedValue(response);

    await expect(createKitchenReport(command, { create })).resolves.toEqual(
      response,
    );
    expect(create).toHaveBeenCalledWith(command);
  });

  it('uploads an optional receipt only through the kitchen write capability', async () => {
    const upload = vi.fn().mockResolvedValue(
      'submissions/ap-northeast-1:00000000-0000-0000-0000-000000000001/draft-1/attachment-1/receipt.jpg',
    );
    const input = {
      identityId:
        'ap-northeast-1:00000000-0000-0000-0000-000000000001',
      draftId: 'draft-1',
      attachmentId: 'attachment-1',
      fileName: 'receipt.jpg',
      data: new Blob(['receipt']),
    };

    await expect(
      uploadKitchenReportAttachment(input, { upload }),
    ).resolves.toContain('/receipt.jpg');
    expect(upload).toHaveBeenCalledWith(input);
  });

  it('shows stable conflict and unknown-result retry guidance', () => {
    expect(
      kitchenSubmissionFailure(
        new DataRepositoryError('REPORT_ALREADY_EXISTS'),
      ),
    ).toEqual({
      event: 'FAIL',
      message: '该营业日和班次可能已提交，请老板确认',
    });
    expect(
      kitchenSubmissionFailure(
        new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN'),
      ),
    ).toEqual({
      event: 'UNKNOWN',
      message:
        '结果不确定，请勿反复修改数据，重试会检查同一营业日和班次冲突',
    });
  });

  it('imports no OWNER repository and contains no report read/update/delete call', () => {
    const files = ['KitchenHomeView.vue', 'KitchenReportView.vue'];
    const source = files
      .map((file) =>
        readFileSync(
          fileURLToPath(new URL(file, import.meta.url)),
          'utf8',
        ),
      )
      .join('\n');

    expect(source).not.toMatch(/owner(?:MasterData|Attachment)Repository/);
    expect(source).not.toMatch(
      /dailyReportsRepository\.(?:getByReportKey|listByBusinessDate|updateByReportKey)/,
    );
  });

  it('keeps only the current kitchen route contract', () => {
    expect(kitchenReportMode('kitchen-report')).toBe('create');
    expect(kitchenReportMode('wm-report')).toBeNull();
    expect(kitchenReportMode('wm-report-edit')).toBeNull();
    expect(kitchenHomePath).toBe('/kitchen');
  });
});
