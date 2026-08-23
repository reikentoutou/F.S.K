import { reactive } from 'vue';
import { minuteToHm, parseHmToMinute } from '@/utils/time-parse';
import type { DailyReportFormFieldsModel } from '@/components/daily-report/daily-report-form.types';

export type DailyReportFormPayload = {
  reportDate: string;
  shiftId: string;
  responsiblePersonId: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  expenseYen: number;
  expenseReason: string;
};

export type DailyReportExistingData = {
  responsiblePersonId: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  staffMealCashYen?: number;
  staffMealAlipayYen?: number;
  expenseYen: number;
  expenseReason: string | null;
};

const DEFAULT_START_STR = '09:00';
const DEFAULT_END_STR = '18:00';

export function useDailyReportFormState() {
  const form = reactive<DailyReportFormFieldsModel>({
    responsiblePersonId: '',
    startStr: DEFAULT_START_STR,
    endStr: DEFAULT_END_STR,
    previousImosBalanceYen: 0,
    currentImosBalanceYen: 0,
    newageYen: 0,
    cashInDrawerYen: 0,
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
    expenseYen: 0,
    expenseReason: '',
    expenseReceiptStored: false,
  });

  function reset(defaultResponsiblePersonId?: string) {
    form.startStr = DEFAULT_START_STR;
    form.endStr = DEFAULT_END_STR;
    form.previousImosBalanceYen = 0;
    form.currentImosBalanceYen = 0;
    form.newageYen = 0;
    form.cashInDrawerYen = 0;
    form.staffMealCashYen = 0;
    form.staffMealAlipayYen = 0;
    form.expenseYen = 0;
    form.expenseReason = '';
    form.expenseReceiptStored = false;
    if (defaultResponsiblePersonId) {
      form.responsiblePersonId = defaultResponsiblePersonId;
    }
  }

  function applyExisting(data: DailyReportExistingData) {
    form.responsiblePersonId = data.responsiblePersonId;
    form.startStr = minuteToHm(data.startMinuteOfDay);
    form.endStr = minuteToHm(data.endMinuteOfDay);
    form.previousImosBalanceYen = data.previousImosBalanceYen;
    form.currentImosBalanceYen = data.currentImosBalanceYen;
    form.newageYen = data.newageYen;
    form.cashInDrawerYen = data.cashTotalYen;
    form.staffMealCashYen = data.staffMealCashYen ?? 0;
    form.staffMealAlipayYen = data.staffMealAlipayYen ?? 0;
    form.expenseYen = data.expenseYen;
    form.expenseReason = data.expenseReason || '';
    form.expenseReceiptStored = data.expenseYen <= 0;
  }

  function setDefaultResponsiblePerson(id?: string) {
    if (!form.responsiblePersonId && id) {
      form.responsiblePersonId = id;
    }
  }

  function buildPayload(reportDate: string, shiftId: string): DailyReportFormPayload {
    return {
      reportDate,
      shiftId,
      responsiblePersonId: form.responsiblePersonId,
      startMinuteOfDay: parseHmToMinute(form.startStr),
      endMinuteOfDay: parseHmToMinute(form.endStr),
      previousImosBalanceYen: form.previousImosBalanceYen,
      currentImosBalanceYen: form.currentImosBalanceYen,
      newageYen: form.newageYen,
      cashTotalYen: form.cashInDrawerYen,
      staffMealCashYen: form.staffMealCashYen,
      staffMealAlipayYen: form.staffMealAlipayYen,
      expenseYen: form.expenseYen,
      expenseReason: form.expenseReason,
    };
  }

  return {
    form,
    reset,
    applyExisting,
    setDefaultResponsiblePerson,
    buildPayload,
  };
}
