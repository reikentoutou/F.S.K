import { fetchAuthSession } from 'aws-amplify/auth';
import { resolveStoreAccess } from '@fsk/domain';
import { getDataClient } from './client';
import type { CreateDailyReportCommand } from './daily-reports';
import { DataRepositoryError, hasDataErrors, classifyDataFailure } from './errors';

export const kitchenReportsRepository = {
  async create(command: CreateDailyReportCommand): Promise<CreateDailyReportCommand & { reportKey: string; submittedAt: string }> {
    const session = await fetchAuthSession();
    const storeId = resolveStoreAccess(session.tokens?.idToken?.payload ?? {});
    try {
      const result = await getDataClient().mutations.submitKitchenReport({ input: JSON.stringify({ ...command, storeId }) });
      if (hasDataErrors(result.errors)) {
        if (JSON.stringify(result.errors).includes('REPORT_ALREADY_EXISTS')) throw new DataRepositoryError('REPORT_ALREADY_EXISTS');
        throw classifyDataFailure(result.errors);
      }
      if (!result.data) throw new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN');
      return { ...command, ...result.data };
    } catch (error) {
      if (error instanceof DataRepositoryError) throw error;
      throw new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN', { cause: error });
    }
  },
};
