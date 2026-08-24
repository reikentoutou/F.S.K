<script lang="ts">
import type { CreateDailyReportCommand as ReportCommand } from '@/data/daily-reports';
import { DataRepositoryError as RepositoryError } from '@/data/errors';

export type OwnerReportMode = 'create' | 'edit' | null;

export function ownerReportMode(routeName: unknown): OwnerReportMode {
  if (routeName === 'owner-report-new') return 'create';
  if (routeName === 'owner-report-edit') return 'edit';
  return null;
}

export const ownerDailyPath = '/owner/daily';

export function ownerReportDataErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (!(error instanceof RepositoryError)) return fallback;
  switch (error.code) {
    case 'DATA_UNAUTHORIZED':
      return '权限不足，请重新以老板账号登录';
    case 'DATA_NOT_FOUND':
      return '未找到指定账务，可能已被修改';
    case 'REPORT_ALREADY_EXISTS':
    case 'DATA_CONFLICT':
      return '该营业日和班次已有账务，或数据发生冲突';
    case 'DATA_PAGINATION_FAILED':
      return '分页读取失败，请返回日报后重试';
    case 'DATA_NETWORK_ERROR':
    case 'SUBMISSION_RESULT_UNKNOWN':
      return '网络异常，结果可能不确定，请返回日报确认后再重试';
    default:
      return fallback;
  }
}

export function loadOwnerReport<T>(
  reportKey: string,
  repository: { getByReportKey(reportKey: string): Promise<T> },
): Promise<T> {
  return repository.getByReportKey(reportKey);
}

export function saveOwnerReport<T>(
  reportKey: string | null,
  command: ReportCommand,
  repository: {
    create(command: ReportCommand): Promise<T>;
    updateByReportKey(
      reportKey: string,
      changes: Omit<ReportCommand, 'businessDate' | 'shiftId'>,
    ): Promise<T>;
  },
): Promise<T> {
  if (!reportKey) return repository.create(command);
  const { businessDate: _businessDate, shiftId: _shiftId, ...changes } =
    command;
  return repository.updateByReportKey(reportKey, changes);
}
</script>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import DailyReportConfirmSummary from '@/components/daily-report/DailyReportConfirmSummary.vue';
import DailyReportFormFields from '@/components/daily-report/DailyReportFormFields.vue';
import { useDailyReportFormState } from '@/composables/useDailyReportFormState';
import { useDailyReportPreview } from '@/composables/useDailyReportPreview';
import {
  dailyReportsRepository,
  type CreateDailyReportCommand,
} from '@/data/daily-reports';
import { DataRepositoryError } from '@/data/errors';
import { ownerMasterDataRepository } from '@/data/master-data';
import { confirmCashBeforeSubmit } from '@/utils/coupon-labels';
import {
  validateDailyReportGoToConfirm,
  validateDailyReportSubmit,
} from '@/utils/daily-report-form-validate';
import { useAuthStore } from '@/stores/auth';

type LoadedReport = Awaited<
  ReturnType<typeof dailyReportsRepository.getByReportKey>
>;

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const loading = shallowRef(true);
const saving = shallowRef(false);
const step = shallowRef<'form' | 'confirm'>('form');
const registerFloatAmount = shallowRef(0);
const reportKey = shallowRef<string | null>(null);
const shiftId = shallowRef('');
const businessDate = shallowRef('');
const existingReport = shallowRef<LoadedReport | null>(null);
const shifts = shallowRef<
  Array<{ id: string; name: string; sortOrder: number; active: boolean }>
>([]);
const persons = shallowRef<Array<{ id: string; name: string; active: boolean }>>(
  [],
);
const {
  form,
  reset: resetDailyReportForm,
  applyExisting,
  setDefaultResponsiblePerson,
  buildPayload: buildDailyReportPayload,
} = useDailyReportFormState();

const isNew = computed(() => ownerReportMode(route.name) === 'create');
const activePersons = computed(() =>
  isNew.value ? persons.value.filter((person) => person.active) : persons.value,
);
const shiftName = computed(
  () =>
    existingReport.value?.shiftNameSnapshot ??
    shifts.value.find((shift) => shift.id === shiftId.value)?.name ??
    '—',
);
const personName = computed(
  () =>
    persons.value.find((person) => person.id === form.responsiblePersonId)
      ?.name ??
    existingReport.value?.responsiblePersonSnapshot ??
    '—',
);
const preview = useDailyReportPreview(form, registerFloatAmount);

async function loadSetting(): Promise<number> {
  try {
    const setting = await ownerMasterDataRepository.getSetting('default');
    return setting.registerFloatAmount;
  } catch (error: unknown) {
    if (
      error instanceof DataRepositoryError &&
      error.code === 'DATA_NOT_FOUND'
    ) {
      return 0;
    }
    throw error;
  }
}

async function loadMeta(): Promise<void> {
  const [loadedShifts, loadedPersons, floatAmount] = await Promise.all([
    ownerMasterDataRepository.listShifts(),
    ownerMasterDataRepository.listResponsiblePersons(),
    loadSetting(),
  ]);
  shifts.value = loadedShifts
    .filter((shift): shift is NonNullable<typeof shift> => shift != null)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((shift) => ({
      id: shift.id,
      name: shift.name,
      sortOrder: shift.sortOrder,
      active: shift.active,
    }));
  persons.value = loadedPersons
    .filter((person): person is NonNullable<typeof person> => person != null)
    .map((person) => ({
      id: person.id,
      name: person.name,
      active: person.active,
    }));
  registerFloatAmount.value = floatAmount;
}

async function loadExisting(key: string): Promise<void> {
  const report = await loadOwnerReport(key, dailyReportsRepository);
  existingReport.value = report;
  reportKey.value = report.reportKey;
  shiftId.value = report.shiftId;
  businessDate.value = report.businessDate;
  applyExisting(report);
}

async function loadPage(): Promise<void> {
  loading.value = true;
  step.value = 'form';
  existingReport.value = null;
  try {
    await loadMeta();
    const mode = ownerReportMode(route.name);
    if (mode === 'edit') {
      const key = String(route.params.reportKey ?? '');
      if (!key) throw new DataRepositoryError('DATA_NOT_FOUND');
      await loadExisting(key);
    } else if (mode === 'create') {
      reportKey.value = null;
      businessDate.value = String(route.query.businessDate ?? '');
      shiftId.value = String(route.query.shiftId ?? '');
      const defaultPerson = persons.value.find((person) => person.active)?.id;
      resetDailyReportForm(defaultPerson);
      setDefaultResponsiblePerson(defaultPerson);
    }
  } catch (error: unknown) {
    ElMessage.error(ownerReportDataErrorMessage(error, '読み込みに失敗しました'));
  } finally {
    loading.value = false;
  }
}

watch(
  () => [
    route.name,
    route.params.reportKey,
    route.query.businessDate,
    route.query.shiftId,
  ] as const,
  () => {
    if (ownerReportMode(route.name) !== null) void loadPage();
  },
  { immediate: true },
);

function validationOptions() {
  return isNew.value
    ? {
        isNew: true,
        reportDate: businessDate.value,
        shiftId: shiftId.value,
      }
    : undefined;
}

function goToConfirm(): void {
  const error = validateDailyReportGoToConfirm({
    form,
    admin: validationOptions(),
  });
  if (error) {
    ElMessage.error(error);
    return;
  }
  step.value = 'confirm';
}

function backToForm(): void {
  step.value = 'form';
}

function buildCommand(): CreateDailyReportCommand {
  const selectedShift = shifts.value.find(
    (shift) => shift.id === shiftId.value,
  );
  const selectedPerson = persons.value.find(
    (person) => person.id === form.responsiblePersonId,
  );
  if (!selectedShift || !selectedPerson) {
    throw new DataRepositoryError('INVALID_MASTER_DATA');
  }
  const payload = buildDailyReportPayload(
    businessDate.value,
    shiftId.value,
  );
  return {
    businessDate: payload.reportDate,
    shiftId: payload.shiftId,
    shiftNameSnapshot:
      existingReport.value?.shiftNameSnapshot ?? selectedShift.name,
    responsiblePersonId: payload.responsiblePersonId,
    responsiblePersonSnapshot: selectedPerson.name,
    startMinuteOfDay: payload.startMinuteOfDay,
    endMinuteOfDay: payload.endMinuteOfDay,
    timeRangeLabelSnapshot: `${form.startStr}–${form.endStr}`,
    previousImosBalanceYen: payload.previousImosBalanceYen,
    currentImosBalanceYen: payload.currentImosBalanceYen,
    newageYen: payload.newageYen,
    cashTotalYen: payload.cashTotalYen,
    expenseYen: payload.expenseYen,
    expenseReason: payload.expenseReason.trim() || undefined,
    staffMealCashYen: payload.staffMealCashYen,
    staffMealAlipayYen: payload.staffMealAlipayYen,
    attachmentKeys: existingReport.value?.attachmentKeys?.filter(
      (key): key is string => key != null,
    ) ?? [],
  };
}

async function submit(): Promise<void> {
  const validationError = validateDailyReportSubmit({
    form,
    admin: validationOptions(),
  });
  if (validationError) {
    ElMessage.error(validationError);
    return;
  }
  try {
    await confirmCashBeforeSubmit({
      registerFloatYen: registerFloatAmount.value,
      cashInDrawerYen: form.cashInDrawerYen,
      withdrawalYen: preview.value.cashDepositYen,
    });
  } catch {
    return;
  }
  saving.value = true;
  try {
    const command = buildCommand();
    if (reportKey.value) {
      await saveOwnerReport(reportKey.value, command, dailyReportsRepository);
      ElMessage.success('修正しました');
    } else {
      await saveOwnerReport(null, command, dailyReportsRepository);
      ElMessage.success('老板补录を保存しました');
    }
    await router.replace(ownerDailyPath);
  } catch (error: unknown) {
    ElMessage.error(ownerReportDataErrorMessage(error, '保存に失敗しました'));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page" v-loading="loading">
    <header class="bar">
      <el-button link @click="step === 'confirm' ? backToForm() : router.back()">
        {{ step === 'confirm' ? '入力に戻る' : '戻る' }}
      </el-button>
      <div>
        <h2>日報（老板）— {{ businessDate }}</h2>
        <p v-if="isNew" class="audit-note">
          老板补录：{{ auth.user?.username ?? 'OWNER' }} が作成します
        </p>
      </div>
    </header>

    <template v-if="!loading && step === 'confirm'">
      <DailyReportConfirmSummary
        :preview="preview"
        :shift-name="shiftName"
        :person-name="personName"
        :register-float-amount="registerFloatAmount"
        :start-str="form.startStr"
        :end-str="form.endStr"
        :previous-imos-balance-yen="form.previousImosBalanceYen"
        :current-imos-balance-yen="form.currentImosBalanceYen"
        :newage-yen="form.newageYen"
        :cash-in-drawer-yen="form.cashInDrawerYen"
        :expense-yen="form.expenseYen"
        :expense-reason="form.expenseReason"
        :staff-meal-cash-yen="form.staffMealCashYen"
        :staff-meal-alipay-yen="form.staffMealAlipayYen"
      />
      <div class="confirm-actions">
        <el-button
          type="primary"
          size="large"
          class="submit-btn"
          :loading="saving"
          @click="submit"
        >
          {{ isNew ? '老板补录を保存' : '修正を保存' }}
        </el-button>
      </div>
    </template>

    <el-form
      v-if="!loading && step === 'form'"
      label-position="top"
      require-asterisk-position="right"
      class="form"
    >
      <DailyReportFormFields
        :form="form"
        :persons="activePersons"
        :register-float-amount="registerFloatAmount"
        :preview="preview"
        variant="admin"
        @confirm="goToConfirm"
      />
    </el-form>
  </div>
</template>

<style scoped>
.page { max-width: 900px; }
.bar { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.bar h2 { margin: 0; }
.audit-note { margin: 6px 0 0; color: var(--fs-muted); font-size: 0.82rem; }
.confirm-actions { margin-top: 20px; padding-top: 8px; }
.submit-btn { width: 100%; max-width: 360px; font-weight: 700; }
</style>
