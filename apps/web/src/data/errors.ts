export type DataRepositoryErrorCode =
  | 'REPORT_ALREADY_EXISTS'
  | 'SUBMISSION_RESULT_UNKNOWN'
  | 'DATA_OPERATION_FAILED'
  | 'INVALID_MASTER_DATA';

export class DataRepositoryError extends Error {
  constructor(
    readonly code: DataRepositoryErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'DataRepositoryError';
  }
}

export function hasDataErrors(
  errors: readonly unknown[] | null | undefined,
): errors is readonly unknown[] {
  return Array.isArray(errors) && errors.length > 0;
}

export function isDuplicateDataFailure(value: unknown): boolean {
  const seen = new Set<object>();

  function visit(candidate: unknown): boolean {
    if (typeof candidate === 'string') {
      return /conditionalcheckfailed|duplicate(?:_key)?|already[ -]?exists|conflict/i.test(
        candidate,
      );
    }
    if (candidate === null || typeof candidate !== 'object') return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return Object.values(candidate).some(visit);
  }

  return visit(value);
}

export function dataOperationFailed(cause?: unknown): DataRepositoryError {
  return new DataRepositoryError('DATA_OPERATION_FAILED', { cause });
}
