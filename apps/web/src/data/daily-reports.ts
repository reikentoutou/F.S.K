import { dailyReportKey } from '@fsk/domain';

import { getDataClient, type FskDataClient } from './client';
import {
  DataRepositoryError,
  classifyDataFailure,
  dataNotFound,
  dataOperationFailed,
  dataPaginationFailed,
  hasDataErrors,
  isDuplicateDataFailure,
} from './errors';

export interface CreateDailyReportCommand {
  businessDate: string;
  shiftId: string;
  shiftNameSnapshot: string;
  responsiblePersonId: string;
  responsiblePersonSnapshot: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  timeRangeLabelSnapshot: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  expenseReason?: string;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  attachmentKeys: string[];
}

export interface DailyReportsRepositoryOptions {
  now?: () => Date;
}

export type UpdateDailyReportCommand = Omit<
  CreateDailyReportCommand,
  'businessDate' | 'shiftId'
>;

async function ownerResult<T>(
  load: () => Promise<{ data: T | null; errors?: readonly unknown[] }>,
  nullResult: 'NOT_FOUND' | 'OPERATION_FAILED',
): Promise<T> {
  try {
    const result = await load();
    if (hasDataErrors(result.errors)) {
      throw classifyDataFailure(result.errors);
    }
    if (result.data === null) {
      throw nullResult === 'NOT_FOUND'
        ? dataNotFound()
        : dataOperationFailed();
    }
    return result.data;
  } catch (cause) {
    if (cause instanceof DataRepositoryError) throw cause;
    throw classifyDataFailure(cause);
  }
}

export function createDailyReportsRepository(
  client?: FskDataClient,
  options: DailyReportsRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const resolveClient = () => client ?? getDataClient();

  return {
    async create(command: CreateDailyReportCommand) {
      const input = {
        reportKey: dailyReportKey(command.businessDate, command.shiftId),
        businessDate: command.businessDate,
        shiftId: command.shiftId,
        shiftNameSnapshot: command.shiftNameSnapshot,
        responsiblePersonId: command.responsiblePersonId,
        responsiblePersonSnapshot: command.responsiblePersonSnapshot,
        startMinuteOfDay: command.startMinuteOfDay,
        endMinuteOfDay: command.endMinuteOfDay,
        timeRangeLabelSnapshot: command.timeRangeLabelSnapshot,
        previousImosBalanceYen: command.previousImosBalanceYen,
        currentImosBalanceYen: command.currentImosBalanceYen,
        newageYen: command.newageYen,
        cashTotalYen: command.cashTotalYen,
        expenseYen: command.expenseYen,
        expenseReason: command.expenseReason,
        staffMealCashYen: command.staffMealCashYen,
        staffMealAlipayYen: command.staffMealAlipayYen,
        attachmentKeys: [...command.attachmentKeys],
        submittedAt: now().toISOString(),
      };

      try {
        const result = await resolveClient().models.DailyReport.create(input);
        if (hasDataErrors(result.errors)) {
          throw submissionFailure(result.errors);
        }
        if (result.data === null) {
          throw new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN');
        }
        return result.data;
      } catch (cause) {
        if (cause instanceof DataRepositoryError) throw cause;
        throw submissionFailure(cause);
      }
    },
    async getByReportKey(reportKey: string) {
      return ownerResult(
        () => resolveClient().models.DailyReport.get({ reportKey }),
        'NOT_FOUND',
      );
    },
    async updateByReportKey(
      reportKey: string,
      command: UpdateDailyReportCommand,
    ) {
      return ownerResult(
        () =>
          resolveClient().models.DailyReport.update({
            reportKey,
            shiftNameSnapshot: command.shiftNameSnapshot,
            responsiblePersonId: command.responsiblePersonId,
            responsiblePersonSnapshot: command.responsiblePersonSnapshot,
            startMinuteOfDay: command.startMinuteOfDay,
            endMinuteOfDay: command.endMinuteOfDay,
            timeRangeLabelSnapshot: command.timeRangeLabelSnapshot,
            previousImosBalanceYen: command.previousImosBalanceYen,
            currentImosBalanceYen: command.currentImosBalanceYen,
            newageYen: command.newageYen,
            cashTotalYen: command.cashTotalYen,
            expenseYen: command.expenseYen,
            expenseReason: command.expenseReason,
            staffMealCashYen: command.staffMealCashYen,
            staffMealAlipayYen: command.staffMealAlipayYen,
            attachmentKeys: [...command.attachmentKeys],
          }),
        'OPERATION_FAILED',
      );
    },
    async listByBusinessDate(businessDate: string) {
      const reports = [];
      let nextToken: string | null | undefined;
      const observedTokens = new Set<string>();

      do {
        const loadPage = () =>
          resolveClient().models.DailyReport.dailyReportsByBusinessDate(
            { businessDate },
            nextToken ? { nextToken } : undefined,
          );
        let result: Awaited<ReturnType<typeof loadPage>>;
        try {
          result = await loadPage();
        } catch (cause) {
          throw classifyDataFailure(cause);
        }
        if (hasDataErrors(result.errors)) {
          throw classifyDataFailure(result.errors);
        }
        if (!Array.isArray(result.data)) {
          throw dataPaginationFailed(result.data);
        }
        reports.push(...result.data);
        nextToken = result.nextToken;
        if (nextToken) {
          if (observedTokens.has(nextToken)) {
            throw dataPaginationFailed(new Error('REPEATED_DATA_NEXT_TOKEN'));
          }
          observedTokens.add(nextToken);
        }
      } while (nextToken);

      return reports;
    },
  };
}

export const dailyReportsRepository = createDailyReportsRepository();

function submissionFailure(cause: unknown): DataRepositoryError {
  if (isDuplicateDataFailure(cause)) {
    return new DataRepositoryError('REPORT_ALREADY_EXISTS', { cause });
  }
  const classified = classifyDataFailure(cause);
  if (classified.code === 'DATA_UNAUTHORIZED') return classified;
  return new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN', { cause });
}
