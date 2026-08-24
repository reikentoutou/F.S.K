import { describe, expect, it } from 'vitest';

import {
  failSubmissionWithoutReset,
  initialSubmissionState,
  transitionSubmissionState,
} from './submission-state';

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

  it('ignores a second submit while the first request is in progress', () => {
    const submitting = transitionSubmissionState(
      { status: 'confirming' },
      'SUBMIT',
    );

    expect(transitionSubmissionState(submitting, 'SUBMIT')).toBe(submitting);
  });

  it.each(['failed', 'unknown'] as const)(
    'lets a %s result retry without returning to editing',
    (status) => {
      expect(
        transitionSubmissionState({ status }, 'RETRY').status,
      ).toBe('submitting');
    },
  );

  it.each([
    ['FAIL', 'failed'],
    ['UNKNOWN', 'unknown'],
  ] as const)(
    'keeps the populated draft on %s so retry sends the same fields',
    (event, status) => {
      const draft = {
        responsiblePersonId: 'person-1',
        cashInDrawerYen: 20_000,
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
      };

      const result = failSubmissionWithoutReset(
        { status: 'submitting' },
        draft,
        event,
      );

      expect(result.state.status).toBe(status);
      expect(result.draft).toBe(draft);
      expect(result.draft).toEqual({
        responsiblePersonId: 'person-1',
        cashInDrawerYen: 20_000,
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
      });
    },
  );

  it('rejects transitions that would skip confirmation or leave success', () => {
    const editing = initialSubmissionState();
    const succeeded = { status: 'succeeded' } as const;

    expect(transitionSubmissionState(editing, 'SUBMIT')).toBe(editing);
    expect(transitionSubmissionState(succeeded, 'RETRY')).toBe(succeeded);
  });
});
