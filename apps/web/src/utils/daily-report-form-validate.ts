import { MAX_YEN } from '@fsk/domain';

import { parseHmToMinute } from '@/utils/time-parse';

export const MAX_DAILY_REPORT_AMOUNT_YEN = MAX_YEN;

type FormSlice = {
  responsiblePersonId: string;
  startStr: string;
  endStr: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashInDrawerYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  expenseYen: number;
  expenseReason: string;
  expenseReceiptStored: boolean;
};

function validYenAmount(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_YEN
  );
}

function amountValidationError(form: FormSlice): string | null {
  if (
    !validYenAmount(form.previousImosBalanceYen) ||
    !validYenAmount(form.currentImosBalanceYen) ||
    !validYenAmount(form.newageYen) ||
    !validYenAmount(form.cashInDrawerYen) ||
    !validYenAmount(form.expenseYen)
  ) {
    return '金額は0〜2,000,000,000円の整数で入力してください';
  }
  return null;
}

function staffMealValidationError(form: FormSlice): string | null {
  if (
    !validYenAmount(form.staffMealCashYen) ||
    !validYenAmount(form.staffMealAlipayYen)
  ) {
    return 'スタッフ食事代は0〜2,000,000,000円の整数で入力してください';
  }
  return null;
}

/** 从「填写」进入「确认」前的共用校验；返回错误文案或 null */
export function validateDailyReportGoToConfirm(opts: {
  form: FormSlice;
  /** 仅管理员新建 */
  admin?: {
    isNew: boolean;
    reportDate: string;
    shiftId: string;
  };
}): string | null {
  const { form, admin } = opts;
  if (admin?.isNew) {
    if (!admin.reportDate || !admin.shiftId) {
      return '日付・シフトを確認してください';
    }
  }
  if (!form.responsiblePersonId) {
    return '責任者を選択してください';
  }
  const amountError = amountValidationError(form);
  if (amountError) return amountError;
  const staffMealError = staffMealValidationError(form);
  if (staffMealError) return staffMealError;
  const sm = parseHmToMinute(form.startStr);
  const em = parseHmToMinute(form.endStr);
  if (sm === em) {
    return '開始と終了を同じ時刻にはできません';
  }
  if (form.expenseYen > 0 && !form.expenseReason?.trim()) {
    return '支出理由を入力してください';
  }
  if (form.expenseYen > 0 && !form.expenseReceiptStored) {
    return '領収書の受け取りと収納を確認してください';
  }
  return null;
}

/** 正式提交前（confirmCash 弹窗与发 HTTP 之前）的共用校验 */
export function validateDailyReportSubmit(opts: {
  form: FormSlice;
  admin?: {
    isNew: boolean;
    reportDate: string;
    shiftId: string;
  };
}): string | null {
  const { form, admin } = opts;
  if (!form.responsiblePersonId) {
    return '責任者を選択してください';
  }
  if (admin?.isNew) {
    if (!admin.reportDate || !admin.shiftId) {
      return '日付・シフトを確認してください';
    }
  }
  const amountError = amountValidationError(form);
  if (amountError) return amountError;
  const staffMealError = staffMealValidationError(form);
  if (staffMealError) return staffMealError;
  if (form.expenseYen > 0 && !form.expenseReason?.trim()) {
    return '支出理由を入力してください';
  }
  if (form.expenseYen > 0 && !form.expenseReceiptStored) {
    return '領収書の受け取りと収納を確認してください';
  }
  return null;
}
