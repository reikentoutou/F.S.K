export type SubmissionStatus =
  | 'editing'
  | 'confirming'
  | 'submitting'
  | 'succeeded'
  | 'failed'
  | 'unknown';

export type SubmissionEvent =
  | 'CONFIRM'
  | 'EDIT'
  | 'SUBMIT'
  | 'RETRY'
  | 'SUCCEED'
  | 'FAIL'
  | 'UNKNOWN';

export interface SubmissionState {
  readonly status: SubmissionStatus;
}

export function initialSubmissionState(): SubmissionState {
  return { status: 'editing' };
}

const transitions: Record<
  SubmissionStatus,
  Partial<Record<SubmissionEvent, SubmissionStatus>>
> = {
  editing: { CONFIRM: 'confirming' },
  confirming: { EDIT: 'editing', SUBMIT: 'submitting' },
  submitting: {
    SUCCEED: 'succeeded',
    FAIL: 'failed',
    UNKNOWN: 'unknown',
  },
  succeeded: {},
  failed: { EDIT: 'editing', RETRY: 'submitting' },
  unknown: { EDIT: 'editing', RETRY: 'submitting' },
};

export function transitionSubmissionState(
  state: SubmissionState,
  event: SubmissionEvent,
): SubmissionState {
  const nextStatus = transitions[state.status][event];
  return nextStatus ? { status: nextStatus } : state;
}

export function failSubmissionWithoutReset<TDraft>(
  state: SubmissionState,
  draft: TDraft,
  event: 'FAIL' | 'UNKNOWN',
): { state: SubmissionState; draft: TDraft } {
  return {
    state: transitionSubmissionState(state, event),
    draft,
  };
}
