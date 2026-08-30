import { describe, expect, it, vi } from 'vitest';

import {
  createKitchenSubmissionController,
  initialSubmissionState,
  transitionSubmissionState,
} from './submission-state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const classifyFailure = (error: unknown) => ({
  event: error === 'unknown' ? ('UNKNOWN' as const) : ('FAIL' as const),
  message: String(error),
});

describe('kitchen submission state', () => {
  it('allows only the create flow from editing through a terminal result', () => {
    const confirming = transitionSubmissionState(
      initialSubmissionState(),
      'CONFIRM',
    );
    const submitting = transitionSubmissionState(confirming, 'SUBMIT');

    expect(confirming.status).toBe('confirming');
    expect(submitting.status).toBe('submitting');
    expect(transitionSubmissionState(submitting, 'SUCCEED').status).toBe(
      'succeeded',
    );
    expect(transitionSubmissionState(submitting, 'FAIL').status).toBe('failed');
    expect(transitionSubmissionState(submitting, 'UNKNOWN').status).toBe(
      'unknown',
    );
  });

  it('locks pending consecutive submits to one create request', async () => {
    const response = deferred<{ reportKey: string }>();
    const create = vi.fn(() => response.promise);
    const controller = createKitchenSubmissionController({
      draft: { cashInDrawerYen: 20_000 },
      validate: () => null,
      prepareAttachments: vi.fn().mockResolvedValue(undefined),
      create,
      classifyFailure,
    });
    controller.confirm();

    const first = controller.submit();
    const second = controller.submit();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.snapshot().state.status).toBe('submitting');
    expect(create).toHaveBeenCalledOnce();
    response.resolve({ reportKey: '2026-08-24#day' });
    await Promise.all([first, second]);
    expect(controller.snapshot().state.status).toBe('succeeded');
  });

  it.each([
    ['failed', 'failure'],
    ['unknown', 'unknown'],
  ] as const)(
    'keeps the same populated draft after a %s result',
    async (status, error) => {
      const draft = {
        responsiblePersonId: 'person-1',
        cashInDrawerYen: 20_000,
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
      };
      const controller = createKitchenSubmissionController({
        draft,
        validate: () => null,
        prepareAttachments: vi.fn().mockResolvedValue(undefined),
        create: vi.fn().mockRejectedValue(error),
        classifyFailure,
      });
      controller.confirm();

      await controller.submit();

      expect(controller.snapshot().state.status).toBe(status);
      expect(controller.snapshot().draft).toBe(draft);
      expect(controller.snapshot().draft).toEqual({
        responsiblePersonId: 'person-1',
        cashInDrawerYen: 20_000,
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
      });
    },
  );

  it('does not upload the same attachment again after create returned unknown', async () => {
    const prepareAttachments = vi.fn().mockResolvedValue(undefined);
    const create = vi
      .fn()
      .mockRejectedValueOnce('unknown')
      .mockResolvedValueOnce({ reportKey: '2026-08-24#day' });
    const controller = createKitchenSubmissionController({
      draft: { attachmentKeys: [] as string[] },
      validate: () => null,
      prepareAttachments,
      create,
      classifyFailure,
    });
    controller.confirm();

    await controller.submit();
    expect(controller.snapshot().state.status).toBe('unknown');
    await controller.submit();

    expect(prepareAttachments).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().state.status).toBe('succeeded');
  });

  it('validates before submitting or preparing attachments', async () => {
    const prepareAttachments = vi.fn();
    const create = vi.fn();
    const controller = createKitchenSubmissionController({
      draft: { businessDate: '2026-08-23' },
      validate: () => '营业日已更新，请返回厨房首页重新选择班次',
      prepareAttachments,
      create,
      classifyFailure,
    });
    controller.confirm();

    await controller.submit();

    expect(controller.snapshot().state.status).toBe('confirming');
    expect(controller.snapshot().message).toBe(
      '营业日已更新，请返回厨房首页重新选择班次',
    );
    expect(prepareAttachments).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('invalidates a pending attachment preparation on reset without creating or republishing stale state', async () => {
    const attachment = deferred<void>();
    const create = vi.fn();
    const snapshots: string[] = [];
    const controller = createKitchenSubmissionController({
      draft: { businessDate: '2026-08-24' },
      validate: () => null,
      prepareAttachments: () => attachment.promise,
      create,
      classifyFailure,
      onChange: (snapshot) => snapshots.push(snapshot.state.status),
    });
    controller.confirm();
    const pending = controller.submit();
    expect(controller.snapshot().state.status).toBe('submitting');

    controller.reset();
    const publishCountAfterReset = snapshots.length;
    attachment.resolve();
    await pending;

    expect(create).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      state: { status: 'editing' },
      result: null,
      message: '',
    });
    expect(snapshots).toHaveLength(publishCountAfterReset);
    expect(snapshots.at(-1)).toBe('editing');
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale create %s after reset',
    async (settlement) => {
      const response = deferred<{ reportKey: string }>();
      const snapshots: string[] = [];
      const controller = createKitchenSubmissionController({
        draft: { businessDate: '2026-08-24' },
        validate: () => null,
        prepareAttachments: vi.fn().mockResolvedValue(undefined),
        create: () => response.promise,
        classifyFailure,
        onChange: (snapshot) => snapshots.push(snapshot.state.status),
      });
      controller.confirm();
      const pending = controller.submit();
      await Promise.resolve();
      expect(controller.snapshot().state.status).toBe('submitting');

      controller.reset();
      const publishCountAfterReset = snapshots.length;
      if (settlement === 'resolve') {
        response.resolve({ reportKey: 'stale-report' });
      } else {
        response.reject('stale-failure');
      }
      await pending;

      expect(controller.snapshot()).toMatchObject({
        state: { status: 'editing' },
        result: null,
        message: '',
      });
      expect(snapshots).toHaveLength(publishCountAfterReset);
      expect(snapshots.at(-1)).toBe('editing');
    },
  );

  it('stores only the create response on success and needs no query capability', async () => {
    const response = {
      reportKey: '2026-08-24#day',
      submittedAt: '2026-08-24T10:11:12.000Z',
    };
    const controller = createKitchenSubmissionController({
      draft: { businessDate: '2026-08-24', shiftId: 'day' },
      validate: () => null,
      prepareAttachments: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(response),
      classifyFailure,
    });
    controller.confirm();

    await controller.submit();

    expect(controller.snapshot().result).toBe(response);
    expect(controller.snapshot().state.status).toBe('succeeded');
  });

  it('rejects transitions that would skip confirmation or leave success', () => {
    const editing = initialSubmissionState();
    const succeeded = { status: 'succeeded' } as const;

    expect(transitionSubmissionState(editing, 'SUBMIT')).toBe(editing);
    expect(transitionSubmissionState(succeeded, 'RETRY')).toBe(succeeded);
  });
});
