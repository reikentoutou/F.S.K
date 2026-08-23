import { computed, type Reactive, type Ref } from 'vue';
import {
  computeDailyReportTotals,
  staffMealTotalYen as computeStaffMealTotalYen,
} from '@/utils/daily-report-calc';

type FormSlice = {
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashInDrawerYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  expenseYen: number;
};

export function useDailyReportPreview(
  form: Reactive<FormSlice>,
  registerFloatAmount: Ref<number>,
) {
  return computed(() => {
    const totals = computeDailyReportTotals({
      previousImosBalanceYen: form.previousImosBalanceYen,
      currentImosBalanceYen: form.currentImosBalanceYen,
      newageYen: form.newageYen,
      cashTotalYen: form.cashInDrawerYen,
      expenseYen: form.expenseYen,
      registerFloatYen: registerFloatAmount.value,
      staffMealCashYen: form.staffMealCashYen,
    });
    return {
      ...totals,
      staffMealTotalYen: computeStaffMealTotalYen(
        form.staffMealCashYen,
        form.staffMealAlipayYen,
      ),
    };
  });
}
