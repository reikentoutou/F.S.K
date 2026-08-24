import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { DataRepositoryError } from '@/data/errors';

import {
  createKitchenBusinessDateTracker,
  loadKitchenHomeContext,
} from './KitchenHomeView.vue';
import {
  createKitchenReport,
  kitchenHomePath,
  kitchenReportMode,
  isCurrentKitchenBusinessDate,
  kitchenBusinessDateSubmissionError,
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

  it('refreshes the Tokyo date on visible/pageshow and removes lifecycle listeners', () => {
    class FakeEventSource {
      visibilityState: 'visible' | 'hidden' = 'visible';
      readonly listeners = new Map<string, Set<() => void>>();

      addEventListener(type: string, listener: () => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: () => void) {
        this.listeners.get(type)?.delete(listener);
      }

      dispatch(type: string) {
        for (const listener of this.listeners.get(type) ?? []) listener();
      }
    }

    const documentSource = new FakeEventSource();
    const windowSource = new FakeEventSource();
    let today = '2026-08-24';
    let shownDate = today;
    const tracker = createKitchenBusinessDateTracker({
      today: () => today,
      setBusinessDate: (value) => {
        shownDate = value;
      },
      documentSource,
      windowSource,
    });

    today = '2026-08-25';
    documentSource.visibilityState = 'hidden';
    documentSource.dispatch('visibilitychange');
    expect(shownDate).toBe('2026-08-24');
    documentSource.visibilityState = 'visible';
    documentSource.dispatch('visibilitychange');
    expect(shownDate).toBe('2026-08-25');
    today = '2026-08-26';
    windowSource.dispatch('pageshow');
    expect(shownDate).toBe('2026-08-26');

    tracker.dispose();
    today = '2026-08-27';
    documentSource.dispatch('visibilitychange');
    windowSource.dispatch('pageshow');
    expect(shownDate).toBe('2026-08-26');
    expect(documentSource.listeners.get('visibilitychange')?.size).toBe(0);
    expect(windowSource.listeners.get('pageshow')?.size).toBe(0);
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
    expect(
      kitchenBusinessDateSubmissionError('2026-08-24', '2026-08-24'),
    ).toBeNull();
    expect(
      kitchenBusinessDateSubmissionError('2026-08-23', '2026-08-24'),
    ).toBe('营业日已更新，请返回厨房首页重新选择班次');
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
