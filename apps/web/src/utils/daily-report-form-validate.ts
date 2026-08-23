import { parseHmToMinute } from '@/utils/time-parse';

export const MAX_DAILY_REPORT_AMOUNT_YEN = 2_000_000_000;

type FormSlice = {
  responsiblePersonId: string;
  startStr: string;
  endStr: string;
  cashInDrawerYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  expenseYen: number;
  expenseReason: string;
  expenseReceiptStored: boolean;
};

function validStaffMealAmount(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DAILY_REPORT_AMOUNT_YEN
  );
}

function staffMealValidationError(form: FormSlice): string | null {
  if (
    !validStaffMealAmount(form.staffMealCashYen) ||
    !validStaffMealAmount(form.staffMealAlipayYen)
  ) {
    return '网管餐費は0〜2,000,000,000円の整数で入力してください';
  }
  return null;
}

/** 从「填写」进入「确认」前的共用校验；返回错误文案或 null */
export function validateDailyReportGoToConfirm(opts: {
  form: FormSlice;
  /** 仅管理员新建 */
  admin?: {
    isNew: boolean;
    createdByUserId: string;
    reportDate: string;
    shiftId: string;
  };
}): string | null {
  const { form, admin } = opts;
  if (admin?.isNew) {
    if (!admin.createdByUserId || !admin.reportDate || !admin.shiftId) {
      return '日付・シフト・提出元（網管）を確認してください';
    }
  }
  if (!form.responsiblePersonId) {
    return '責任者を選択してください';
  }
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
    createdByUserId: string;
    reportDate: string;
    shiftId: string;
  };
}): string | null {
  const { form, admin } = opts;
  if (!form.responsiblePersonId) {
    return '責任者を選択してください';
  }
  if (admin?.isNew) {
    if (!admin.createdByUserId || !admin.reportDate || !admin.shiftId) {
      return '日付・シフト・提出元（網管）を確認してください';
    }
  }
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
