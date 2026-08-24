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

export interface SubmissionFailure {
  event: 'FAIL' | 'UNKNOWN';
  message: string;
}

export interface KitchenSubmissionSnapshot<TDraft, TResult> {
  readonly state: SubmissionState;
  readonly draft: TDraft;
  readonly result: TResult | null;
  readonly message: string;
}

export interface KitchenSubmissionControllerOptions<TDraft, TResult> {
  draft: TDraft;
  validate(): string | null;
  prepareAttachments(): Promise<void>;
  create(): Promise<TResult>;
  classifyFailure(error: unknown): SubmissionFailure;
  onChange?(snapshot: KitchenSubmissionSnapshot<TDraft, TResult>): void;
}

export interface KitchenSubmissionController<TDraft, TResult> {
  snapshot(): KitchenSubmissionSnapshot<TDraft, TResult>;
  confirm(): void;
  edit(): void;
  submit(): Promise<void>;
  reset(): void;
  invalidatePreparedAttachments(): void;
}

export function createKitchenSubmissionController<TDraft, TResult>(
  options: KitchenSubmissionControllerOptions<TDraft, TResult>,
): KitchenSubmissionController<TDraft, TResult> {
  let state = initialSubmissionState();
  let result: TResult | null = null;
  let message = '';
  let attachmentsPrepared = false;

  function snapshot(): KitchenSubmissionSnapshot<TDraft, TResult> {
    return { state, draft: options.draft, result, message };
  }

  function publish(): void {
    options.onChange?.(snapshot());
  }

  function confirm(): void {
    state = transitionSubmissionState(state, 'CONFIRM');
    message = '';
    publish();
  }

  function edit(): void {
    state = transitionSubmissionState(state, 'EDIT');
    message = '';
    publish();
  }

  async function submit(): Promise<void> {
    if (state.status === 'submitting' || state.status === 'succeeded') return;
    const event =
      state.status === 'failed' || state.status === 'unknown'
        ? 'RETRY'
        : 'SUBMIT';
    const submitting = transitionSubmissionState(state, event);
    if (submitting === state) return;

    const validationMessage = options.validate();
    if (validationMessage) {
      message = validationMessage;
      publish();
      return;
    }

    state = submitting;
    message = '';
    publish();

    try {
      if (!attachmentsPrepared) {
        await options.prepareAttachments();
        attachmentsPrepared = true;
      }
      result = await options.create();
      state = transitionSubmissionState(state, 'SUCCEED');
    } catch (error) {
      const failure = options.classifyFailure(error);
      message = failure.message;
      state = transitionSubmissionState(state, failure.event);
    }
    publish();
  }

  function reset(): void {
    state = initialSubmissionState();
    result = null;
    message = '';
    attachmentsPrepared = false;
    publish();
  }

  function invalidatePreparedAttachments(): void {
    attachmentsPrepared = false;
  }

  return {
    snapshot,
    confirm,
    edit,
    submit,
    reset,
    invalidatePreparedAttachments,
  };
}
