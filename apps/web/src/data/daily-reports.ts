import { dailyReportKey } from '@fsk/domain';

import { getDataClient, type FskDataClient } from './client';
import {
  DataRepositoryError,
  dataOperationFailed,
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

function unwrapOwnerResult<T>(result: {
  data: T | null;
  errors?: readonly unknown[];
}): T {
  if (hasDataErrors(result.errors)) throw dataOperationFailed(result.errors);
  if (result.data === null) throw dataOperationFailed();
  return result.data;
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
          if (isDuplicateDataFailure(result.errors)) {
            throw new DataRepositoryError('REPORT_ALREADY_EXISTS', {
              cause: result.errors,
            });
          }
          throw new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN', {
            cause: result.errors,
          });
        }
        if (result.data === null) {
          throw new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN');
        }
        return result.data;
      } catch (cause) {
        if (cause instanceof DataRepositoryError) throw cause;
        if (isDuplicateDataFailure(cause)) {
          throw new DataRepositoryError('REPORT_ALREADY_EXISTS', { cause });
        }
        throw new DataRepositoryError('SUBMISSION_RESULT_UNKNOWN', { cause });
      }
    },
    async getByReportKey(reportKey: string) {
      return unwrapOwnerResult(
        await resolveClient().models.DailyReport.get({ reportKey }),
      );
    },
    async updateByReportKey(
      reportKey: string,
      command: UpdateDailyReportCommand,
    ) {
      return unwrapOwnerResult(
        await resolveClient().models.DailyReport.update({
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
      );
    },
    async listByBusinessDate(businessDate: string) {
      const reports = [];
      let nextToken: string | null | undefined;
      const observedTokens = new Set<string>();

      do {
        const result =
          await resolveClient().models.DailyReport.dailyReportsByBusinessDate(
            { businessDate },
            nextToken ? { nextToken } : undefined,
          );
        if (hasDataErrors(result.errors)) {
          throw dataOperationFailed(result.errors);
        }
        reports.push(...result.data);
        nextToken = result.nextToken;
        if (nextToken) {
          if (observedTokens.has(nextToken)) {
            throw dataOperationFailed(new Error('REPEATED_DATA_NEXT_TOKEN'));
          }
          observedTokens.add(nextToken);
        }
      } while (nextToken);

      return reports;
    },
  };
}

export const dailyReportsRepository = createDailyReportsRepository();
