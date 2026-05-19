import { computed, type Reactive, type Ref } from 'vue';
import { computeDailyReportTotals } from '@/utils/daily-report-calc';

type FormSlice = {
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashInDrawerYen: number;
  expenseYen: number;
};

export function useDailyReportPreview(
  form: Reactive<FormSlice>,
  registerFloatAmount: Ref<number>,
) {
  return computed(() =>
    computeDailyReportTotals({
      previousImosBalanceYen: form.previousImosBalanceYen,
      currentImosBalanceYen: form.currentImosBalanceYen,
      newageYen: form.newageYen,
      cashTotalYen: form.cashInDrawerYen,
      expenseYen: form.expenseYen,
      registerFloatYen: registerFloatAmount.value,
    }),
  );
}
