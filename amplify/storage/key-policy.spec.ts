import { describe, expect, it } from 'vitest';

import {
  assertOwnedPendingKey,
  formalAttachmentKey,
  pendingKey,
} from './key-policy.js';
import {
  applyStagingStorageBucketOverrides,
  type StorageBucketOverrideTarget,
} from './resource.js';

describe('Storage key construction', () => {
  it('builds the exact pending namespace and basenames filename input', () => {
    expect(pendingKey('sub-a', 'draft-1', 'att-1', '../票据.jpg')).toBe(
      'pending/sub-a/draft-1/att-1/票据.jpg',
    );
  });

  it('treats Windows separators as filename input separators', () => {
    expect(
      pendingKey('sub-a', 'draft-1', 'att-1', String.raw`C:\upload\票据.jpg`),
    ).toBe('pending/sub-a/draft-1/att-1/票据.jpg');
  });

  it('builds the formal namespace and removes control characters', () => {
    expect(
      formalAttachmentKey(
        'report_1',
        'att-2',
        'nested/invoice\u0000\u001f\u007f-票据.pdf',
      ),
    ).toBe('daily-reports/report_1/att-2/invoice-票据.pdf');
  });

  it.each(['', '../sub', 'sub/a', String.raw`sub\a`, 'sub.a', 'sub a', '用户'])(
    'rejects invalid subject ID %j',
    (subject) => {
      expect(() => pendingKey(subject, 'draft-1', 'att-1', 'x.jpg')).toThrow(
        'INVALID_STORAGE_ID',
      );
    },
  );

  it.each(['', '../draft', 'draft/a', 'draft.a', 'draft a', '草稿'])(
    'rejects invalid draft ID %j',
    (draftId) => {
      expect(() => pendingKey('sub-a', draftId, 'att-1', 'x.jpg')).toThrow(
        'INVALID_STORAGE_ID',
      );
    },
  );

  it.each(['', '../att', 'att/a', 'att.a', 'att a', '附件'])(
    'rejects invalid attachment ID %j',
    (attachmentId) => {
      expect(() =>
        formalAttachmentKey('report-1', attachmentId, 'x.jpg'),
      ).toThrow('INVALID_STORAGE_ID');
    },
  );

  it.each(['', '/', '\u0000\u001f\u007f', '.', '..'])(
    'rejects filename input that has no safe basename: %j',
    (fileName) => {
      expect(() => pendingKey('sub-a', 'draft-1', 'att-1', fileName)).toThrow(
        'INVALID_STORAGE_FILE_NAME',
      );
    },
  );

  it('accepts a filename at the 255-byte UTF-8 boundary', () => {
    const fileName = `${'票'.repeat(83)}文件`;

    expect(pendingKey('sub-a', 'draft-1', 'att-1', fileName)).toBe(
      `pending/sub-a/draft-1/att-1/${fileName}`,
    );
  });

  it('rejects a filename above the 255-byte UTF-8 boundary', () => {
    const fileName = `${'票'.repeat(84)}.pdf`;

    expect(() => pendingKey('sub-a', 'draft-1', 'att-1', fileName)).toThrow(
      'STORAGE_FILE_NAME_TOO_LONG',
    );
  });

  it.each(['bad\ud800.jpg', 'bad\udc00.jpg'])(
    'rejects a non-well-formed UTF-16 filename %j',
    (fileName) => {
      expect(() => pendingKey('sub-a', 'draft-1', 'att-1', fileName)).toThrow(
        'INVALID_STORAGE_FILE_NAME',
      );
    },
  );

  it.each([
    'invoice\u202e.jpg',
    'invoice\u2066.jpg',
    'invoice\u200b.jpg',
    'invoice\ufeff.jpg',
  ])('rejects unsafe format or bidi control in filename %j', (fileName) => {
    expect(() => pendingKey('sub-a', 'draft-1', 'att-1', fileName)).toThrow(
      'INVALID_STORAGE_FILE_NAME',
    );
  });

  it('preserves well-formed Unicode, including emoji joiner sequences', () => {
    const fileName = '領収書-🧾-👨‍👩‍👧.jpg';

    expect(pendingKey('sub-a', 'draft-1', 'att-1', fileName)).toBe(
      `pending/sub-a/draft-1/att-1/${fileName}`,
    );
  });
});

describe('pending key ownership', () => {
  it('accepts a canonical pending key owned by the subject', () => {
    const key = 'pending/sub-a/draft-1/att-1/票据.jpg';

    expect(() => assertOwnedPendingKey(key, 'sub-a')).not.toThrow();
  });

  it('rejects a pending key owned by another subject', () => {
    expect(() =>
      assertOwnedPendingKey('pending/sub-b/draft-1/att-1/x.jpg', 'sub-a'),
    ).toThrow('PENDING_KEY_NOT_OWNED');
  });

  it('rejects a formal attachment impersonating a pending key', () => {
    expect(() =>
      assertOwnedPendingKey(
        'daily-reports/sub-a/draft-1/att-1/x.jpg',
        'sub-a',
      ),
    ).toThrow('PENDING_KEY_NOT_OWNED');
  });

  it.each([
    'pending/sub-a/../att-1/x.jpg',
    'pending/sub-a/draft-1/att-1/../x.jpg',
    'pending/sub-a/draft-1/att-1/nested/x.jpg',
    String.raw`pending/sub-a/draft-1/att-1/nested\x.jpg`,
    'pending/sub-a/draft-1/att-1/invoice\u0000.pdf',
  ])('rejects non-canonical or traversing full key %j', (key) => {
    expect(() => assertOwnedPendingKey(key, 'sub-a')).toThrow(
      'PENDING_KEY_NOT_OWNED',
    );
  });
});

describe('staging Storage bucket overrides', () => {
  it('applies public blocking, SSE-S3, and short-lived staging prefixes', () => {
    const bucket = {} as StorageBucketOverrideTarget;

    applyStagingStorageBucketOverrides(bucket);

    expect(bucket.publicAccessBlockConfiguration).toEqual({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(bucket.bucketEncryption).toEqual({
      serverSideEncryptionConfiguration: [
        {
          serverSideEncryptionByDefault: {
            sseAlgorithm: 'AES256',
          },
        },
      ],
    });
    expect(bucket.lifecycleConfiguration).toEqual({
      rules: [
        {
          expirationInDays: 7,
          id: 'ExpirePendingObjects',
          noncurrentVersionExpiration: { noncurrentDays: 7 },
          prefix: 'pending/',
          status: 'Enabled',
        },
        {
          expirationInDays: 7,
          id: 'ExpireTestExports',
          noncurrentVersionExpiration: { noncurrentDays: 7 },
          prefix: 'test-exports/',
          status: 'Enabled',
        },
        {
          expirationInDays: 7,
          id: 'ExpireMigrationStaging',
          noncurrentVersionExpiration: { noncurrentDays: 7 },
          prefix: 'migration-staging/',
          status: 'Enabled',
        },
      ],
    });
  });
});
