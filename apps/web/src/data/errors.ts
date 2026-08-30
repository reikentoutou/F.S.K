export type DataRepositoryErrorCode =
  | 'REPORT_ALREADY_EXISTS'
  | 'SUBMISSION_RESULT_UNKNOWN'
  | 'DATA_UNAUTHORIZED'
  | 'DATA_NOT_FOUND'
  | 'DATA_CONFLICT'
  | 'DATA_PAGINATION_FAILED'
  | 'DATA_NETWORK_ERROR'
  | 'DATA_OPERATION_FAILED'
  | 'INVALID_MASTER_DATA'
  | 'ATTACHMENT_PATH_MISMATCH';

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
  return hasTrustedSignature(value, [
    'conditionalcheckfailed',
    'conditionalcheckfailedexception',
    'duplicatekey',
    'duplicatekeyexception',
    'alreadyexists',
    'alreadyexistsexception',
  ]);
}

export function dataOperationFailed(cause?: unknown): DataRepositoryError {
  return new DataRepositoryError('DATA_OPERATION_FAILED', { cause });
}

export function classifyDataFailure(cause?: unknown): DataRepositoryError {
  if (
    cause instanceof TypeError ||
    hasTrustedSignature(cause, ['networkerror', 'fetcherror'])
  ) {
    return new DataRepositoryError('DATA_NETWORK_ERROR', { cause });
  }
  if (
    hasTrustedStatus(cause, [401, 403]) ||
    hasTrustedSignature(cause, [
      'unauthorized',
      'unauthorizedexception',
      'accessdenied',
      'accessdeniedexception',
      'forbidden',
      'forbiddenexception',
    ])
  ) {
    return new DataRepositoryError('DATA_UNAUTHORIZED', { cause });
  }
  if (
    hasTrustedStatus(cause, [404]) ||
    hasTrustedSignature(cause, [
      'notfound',
      'notfoundexception',
      'resourcenotfound',
      'resourcenotfoundexception',
    ])
  ) {
    return new DataRepositoryError('DATA_NOT_FOUND', { cause });
  }
  if (
    hasTrustedStatus(cause, [409]) ||
    hasTrustedSignature(cause, [
      'conflict',
      'conflictexception',
      'conditionalcheckfailed',
      'conditionalcheckfailedexception',
    ])
  ) {
    return new DataRepositoryError('DATA_CONFLICT', { cause });
  }
  return dataOperationFailed(cause);
}

export function dataPaginationFailed(cause?: unknown): DataRepositoryError {
  return new DataRepositoryError('DATA_PAGINATION_FAILED', { cause });
}

export function dataNotFound(cause?: unknown): DataRepositoryError {
  return new DataRepositoryError('DATA_NOT_FOUND', { cause });
}

function trustedRecords(value: unknown): Record<string, unknown>[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.filter(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null && typeof candidate === 'object',
  );
}

function trustedValues(value: unknown, field: string): unknown[] {
  return trustedRecords(value).flatMap((record) => {
    const values = [record[field]];
    const extensions = record.extensions;
    if (extensions !== null && typeof extensions === 'object') {
      values.push((extensions as Record<string, unknown>)[field]);
    }
    return values;
  });
}

function normalizedSignatures(value: unknown): string[] {
  return ['errorType', 'name', 'code'].flatMap((field) =>
    trustedValues(value, field).flatMap((candidate) => {
      if (typeof candidate !== 'string') return [];
      return candidate
        .split(':')
        .map((part) => part.replace(/[^a-z0-9]/giu, '').toLowerCase())
        .filter(Boolean);
    }),
  );
}

function hasTrustedSignature(value: unknown, expected: string[]): boolean {
  const signatures = normalizedSignatures(value);
  return expected.some((signature) => signatures.includes(signature));
}

function hasTrustedStatus(value: unknown, expected: number[]): boolean {
  return ['status', 'statusCode'].some((field) =>
    trustedValues(value, field).some((candidate) => {
      const status =
        typeof candidate === 'number'
          ? candidate
          : typeof candidate === 'string' && /^\d{3}$/u.test(candidate)
            ? Number(candidate)
            : undefined;
      return status !== undefined && expected.includes(status);
    }),
  );
}
