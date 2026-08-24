import { getUrl, remove, uploadData } from 'aws-amplify/storage';

import { submissionKey } from '../../../../amplify/storage/key-policy';
import { DataRepositoryError } from './errors';

export interface KitchenAttachmentUpload {
  identityId: string;
  draftId: string;
  attachmentId: string;
  fileName: string;
  data: Blob;
}

interface KitchenStorageOperations {
  uploadData: typeof uploadData;
}

interface OwnerStorageOperations {
  getUrl: typeof getUrl;
  remove: typeof remove;
}

const kitchenStorageOperations: KitchenStorageOperations = { uploadData };
const ownerStorageOperations: OwnerStorageOperations = { getUrl, remove };

export function createKitchenAttachmentRepository(
  storage: KitchenStorageOperations = kitchenStorageOperations,
) {
  return {
    async upload(input: KitchenAttachmentUpload): Promise<string> {
      const key = submissionKey(
        input.identityId,
        input.draftId,
        input.attachmentId,
        input.fileName,
      );
      const result = await storage.uploadData({ path: key, data: input.data })
        .result;
      if (result.path !== key) {
        throw new DataRepositoryError('ATTACHMENT_PATH_MISMATCH', {
          cause: result,
        });
      }
      return result.path;
    },
  };
}

export function createOwnerAttachmentRepository(
  storage: OwnerStorageOperations = ownerStorageOperations,
) {
  return {
    async getReadUrl(key: string): Promise<URL> {
      const result = await storage.getUrl({
        path: key,
        options: { validateObjectExistence: true },
      });
      return result.url;
    },
    async delete(key: string): Promise<void> {
      await storage.remove({ path: key }).result;
    },
  };
}

export type KitchenAttachmentRepository = ReturnType<
  typeof createKitchenAttachmentRepository
>;
export type OwnerAttachmentRepository = ReturnType<
  typeof createOwnerAttachmentRepository
>;

export const kitchenAttachmentRepository = createKitchenAttachmentRepository();
export const ownerAttachmentRepository = createOwnerAttachmentRepository();
