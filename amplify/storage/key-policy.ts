const STORAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const COGNITO_IDENTITY_ID_PATTERN =
  /^[a-z]{2}(?:-[a-z]+)+-\d:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/gu;
const UNSAFE_FORMAT_CONTROL_PATTERN =
  /[\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|\u{e0001}|[\u{e0020}-\u{e007f}]/u;

export const MAX_STORAGE_FILE_NAME_BYTES = 255;

function assertStorageId(value: string, field: string): void {
  if (!STORAGE_ID_PATTERN.test(value)) {
    throw new Error(`INVALID_STORAGE_ID:${field}`);
  }
}

function assertCognitoIdentityId(value: string): void {
  if (!COGNITO_IDENTITY_ID_PATTERN.test(value)) {
    throw new Error('INVALID_STORAGE_ID:identityId');
  }
}

function sanitizeFileName(fileName: string): string {
  if (
    !isWellFormedUnicode(fileName) ||
    UNSAFE_FORMAT_CONTROL_PATTERN.test(fileName)
  ) {
    throw new Error('INVALID_STORAGE_FILE_NAME');
  }

  const normalizedPath = fileName.replaceAll('\\', '/').replace(/\/+$/u, '');
  const baseName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  const sanitized = baseName.replace(CONTROL_CHARACTER_PATTERN, '');

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('INVALID_STORAGE_FILE_NAME');
  }

  if (new TextEncoder().encode(sanitized).byteLength > MAX_STORAGE_FILE_NAME_BYTES) {
    throw new Error('STORAGE_FILE_NAME_TOO_LONG');
  }

  return sanitized;
}

function isWellFormedUnicode(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) {
      return false;
    }
  }

  return true;
}

export function submissionKey(
  identityId: string,
  draftId: string,
  attachmentId: string,
  fileName: string,
): string {
  assertCognitoIdentityId(identityId);
  assertStorageId(draftId, 'draftId');
  assertStorageId(attachmentId, 'attachmentId');

  return `submissions/${identityId}/${draftId}/${attachmentId}/${sanitizeFileName(fileName)}`;
}

/** @deprecated Use submissionKey with the authenticated identity ID. */
export function pendingKey(
  subject: string,
  draftId: string,
  attachmentId: string,
  fileName: string,
): string {
  assertStorageId(subject, 'subject');
  assertStorageId(draftId, 'draftId');
  assertStorageId(attachmentId, 'attachmentId');

  return `submissions/${subject}/${draftId}/${attachmentId}/${sanitizeFileName(fileName)}`;
}

export function formalAttachmentKey(
  reportId: string,
  attachmentId: string,
  fileName: string,
): string {
  assertStorageId(reportId, 'reportId');
  assertStorageId(attachmentId, 'attachmentId');

  return `daily-reports/${reportId}/${attachmentId}/${sanitizeFileName(fileName)}`;
}

export function assertOwnedPendingKey(key: string, subject: string): void {
  assertStorageId(subject, 'subject');

  const [namespace, keySubject, draftId, attachmentId, fileName, ...extra] =
    key.split('/');

  try {
    if (
      namespace !== 'submissions' ||
      keySubject !== subject ||
      extra.length > 0 ||
      fileName === undefined
    ) {
      throw new Error('INVALID_PENDING_KEY');
    }

    assertStorageId(keySubject, 'subject');
    assertStorageId(draftId, 'draftId');
    assertStorageId(attachmentId, 'attachmentId');

    // Full keys must already be canonical; only raw filename input is normalized.
    if (sanitizeFileName(fileName) !== fileName) {
      throw new Error('INVALID_PENDING_KEY');
    }
  } catch {
    throw new Error('PENDING_KEY_NOT_OWNED');
  }
}
