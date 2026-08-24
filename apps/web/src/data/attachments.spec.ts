import { beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  KitchenAttachmentRepository,
  OwnerAttachmentRepository,
} from './attachments';

interface AttachmentsModule {
  createKitchenAttachmentRepository(storage: unknown): KitchenAttachmentRepository;
  createOwnerAttachmentRepository(storage: unknown): OwnerAttachmentRepository;
}

let attachmentsModule: AttachmentsModule | undefined;
let moduleLoadError: unknown;

beforeAll(async () => {
  try {
    attachmentsModule = (await import('./attachments')) as AttachmentsModule;
  } catch (error) {
    moduleLoadError = error;
  }
});

function loadedModule(): AttachmentsModule {
  expect(moduleLoadError).toBeUndefined();
  expect(attachmentsModule).toBeDefined();
  return attachmentsModule!;
}

describe('attachment repositories', () => {
  it('uploads kitchen files only to the canonical identity submission key', async () => {
    const identityId =
      'ap-northeast-1:123e4567-e89b-12d3-a456-426614174000';
    const key = `submissions/${identityId}/draft-1/att-1/票据.jpg`;
    const result = Promise.resolve({ path: key });
    const uploadData = vi.fn().mockReturnValue({ result });
    const repository = loadedModule().createKitchenAttachmentRepository({ uploadData });
    const data = new Blob(['receipt'], { type: 'image/jpeg' });

    await expect(
      repository.upload({
        identityId,
        draftId: 'draft-1',
        attachmentId: 'att-1',
        fileName: '../票据.jpg',
        data,
      }),
    ).resolves.toBe(key);
    expect(uploadData).toHaveBeenCalledWith({
      path: key,
      data,
    });
  });

  it('rejects an upload result whose returned path differs from the canonical key', async () => {
    const uploadData = vi.fn().mockReturnValue({
      result: Promise.resolve({ path: 'submissions/another-identity/file.jpg' }),
    });
    const repository = loadedModule().createKitchenAttachmentRepository({
      uploadData,
    });

    await expect(
      repository.upload({
        identityId:
          'ap-northeast-1:123e4567-e89b-12d3-a456-426614174000',
        draftId: 'draft-1',
        attachmentId: 'att-1',
        fileName: '票据.jpg',
        data: new Blob(['receipt']),
      }),
    ).rejects.toMatchObject({
      code: 'ATTACHMENT_PATH_MISMATCH',
      message: 'ATTACHMENT_PATH_MISMATCH',
    });
  });

  it('exposes no list, read or delete capability from the kitchen repository', () => {
    const repository = loadedModule().createKitchenAttachmentRepository({
      uploadData: vi.fn(),
      list: vi.fn(),
      getUrl: vi.fn(),
      downloadData: vi.fn(),
      remove: vi.fn(),
    });

    expect(Object.keys(repository)).toEqual(['upload']);
    expectTypeOf<KitchenAttachmentRepository>().not.toHaveProperty('list');
    expectTypeOf<KitchenAttachmentRepository>().not.toHaveProperty('getReadUrl');
    expectTypeOf<KitchenAttachmentRepository>().not.toHaveProperty('download');
    expectTypeOf<KitchenAttachmentRepository>().not.toHaveProperty('delete');
    expectTypeOf<KitchenAttachmentRepository>().not.toHaveProperty('remove');
  });

  it('gives OWNER only explicit read-url and delete operations without listing', async () => {
    const url = new URL('https://example.test/receipt');
    const getUrl = vi.fn().mockResolvedValue({ url, expiresAt: new Date() });
    const removeResult = Promise.resolve({ path: 'daily-reports/report-1/att-1/x.jpg' });
    const remove = vi.fn().mockReturnValue({ result: removeResult });
    const repository = loadedModule().createOwnerAttachmentRepository({
      getUrl,
      remove,
      list: vi.fn(),
    });

    await expect(
      repository.getReadUrl('daily-reports/report-1/att-1/x.jpg'),
    ).resolves.toBe(url);
    await expect(
      repository.delete('daily-reports/report-1/att-1/x.jpg'),
    ).resolves.toBeUndefined();
    expect(getUrl).toHaveBeenCalledWith({
      path: 'daily-reports/report-1/att-1/x.jpg',
      options: { validateObjectExistence: true },
    });
    expect(remove).toHaveBeenCalledWith({
      path: 'daily-reports/report-1/att-1/x.jpg',
    });
    expect(Object.keys(repository)).toEqual(['getReadUrl', 'delete']);
    expectTypeOf<OwnerAttachmentRepository>().not.toHaveProperty('list');
  });
});
