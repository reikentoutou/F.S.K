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

export function createOwnerReportLoadController<T>(callbacks: {
  reset(): void;
  setLoading(value: boolean): void;
  apply(value: T): void;
  fail(error: unknown): void;
}) {
  let generation = 0;

  return {
    async load(read: () => Promise<T>): Promise<void> {
      const currentGeneration = ++generation;
      callbacks.reset();
      callbacks.setLoading(true);
      try {
        const value = await read();
        if (currentGeneration !== generation) return;
        callbacks.apply(value);
      } catch (error: unknown) {
        if (currentGeneration !== generation) return;
        callbacks.fail(error);
      } finally {
        if (currentGeneration === generation) callbacks.setLoading(false);
      }
    },
    invalidate(): void {
      generation += 1;
    },
  };
}

export function createOwnerReportSaveController<T>(callbacks: {
  setSaving(value: boolean): void;
  succeed(value: T): void | Promise<void>;
  fail(error: unknown): void;
}) {
  let generation = 0;
  let pending = false;

  return {
    async run(
      save: (isCurrent: () => boolean) => Promise<T>,
    ): Promise<boolean> {
      if (pending) return false;
      const currentGeneration = generation;
      pending = true;
      callbacks.setSaving(true);
      try {
        const isCurrent = () =>
          currentGeneration === generation && pending;
        const value = await save(isCurrent);
        if (currentGeneration !== generation) return false;
        await callbacks.succeed(value);
        return true;
      } catch (error: unknown) {
        if (currentGeneration === generation) callbacks.fail(error);
        return false;
      } finally {
        if (currentGeneration === generation) {
          pending = false;
          callbacks.setSaving(false);
        }
      }
    },
    invalidate(): void {
      generation += 1;
      if (pending) callbacks.setSaving(false);
      pending = false;
    },
  };
}

export function responsiblePersonSnapshot(
  existing: {
    responsiblePersonId: string;
    responsiblePersonSnapshot: string;
  } | null,
  selectedId: string,
  selectedMasterName: string,
): string {
  if (existing?.responsiblePersonId === selectedId) {
    return existing.responsiblePersonSnapshot;
  }
  return selectedMasterName;
}
</script>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onUnmounted, shallowRef, watch } from 'vue';
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

type ShiftOption = {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
};

type PersonOption = {
  id: string;
  name: string;
  active: boolean;
};

type OwnerReportRouteRequest =
  | { mode: 'edit'; reportKey: string }
  | { mode: 'create'; businessDate: string; shiftId: string };

type OwnerReportPageData = {
  request: OwnerReportRouteRequest;
  shifts: ShiftOption[];
  persons: PersonOption[];
  registerFloatAmount: number;
  report: LoadedReport | null;
};

type OwnerReportSaveOutcome =
  | { saved: false }
  | { saved: true; mode: 'create' | 'edit' };

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const loading = shallowRef(true);
const saving = shallowRef(false);
const pageReady = shallowRef(false);
const loadErrorMessage = shallowRef('');
const step = shallowRef<'form' | 'confirm'>('form');
const registerFloatAmount = shallowRef(0);
const reportKey = shallowRef<string | null>(null);
const shiftId = shallowRef('');
const businessDate = shallowRef('');
const existingReport = shallowRef<LoadedReport | null>(null);
const shifts = shallowRef<ShiftOption[]>([]);
const persons = shallowRef<PersonOption[]>([]);
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

async function loadSettingValue(): Promise<number> {
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

async function readPageData(
  request: OwnerReportRouteRequest,
): Promise<OwnerReportPageData> {
  const [loadedShifts, loadedPersons, floatAmount] = await Promise.all([
    ownerMasterDataRepository.listShifts(),
    ownerMasterDataRepository.listResponsiblePersons(),
    loadSettingValue(),
  ]);
  const loadedShiftOptions = loadedShifts
    .filter((shift): shift is NonNullable<typeof shift> => shift != null)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((shift) => ({
      id: shift.id,
      name: shift.name,
      sortOrder: shift.sortOrder,
      active: shift.active,
    }));
  const loadedPersonOptions = loadedPersons
    .filter((person): person is NonNullable<typeof person> => person != null)
    .map((person) => ({
      id: person.id,
      name: person.name,
      active: person.active,
    }));
  const report =
    request.mode === 'edit'
      ? await loadOwnerReport(request.reportKey, dailyReportsRepository)
      : null;
  return {
    request,
    shifts: loadedShiftOptions,
    persons: loadedPersonOptions,
    registerFloatAmount: floatAmount,
    report,
  };
}

function resetPageState(): void {
  saveController.invalidate();
  pageReady.value = false;
  loadErrorMessage.value = '';
  step.value = 'form';
  existingReport.value = null;
  reportKey.value = null;
  businessDate.value = '';
  shiftId.value = '';
  shifts.value = [];
  persons.value = [];
  registerFloatAmount.value = 0;
  resetDailyReportForm();
}

function applyPageData(data: OwnerReportPageData): void {
  shifts.value = data.shifts;
  persons.value = data.persons;
  registerFloatAmount.value = data.registerFloatAmount;
  if (data.request.mode === 'edit' && data.report) {
    existingReport.value = data.report;
    reportKey.value = data.report.reportKey;
    shiftId.value = data.report.shiftId;
    businessDate.value = data.report.businessDate;
    applyExisting(data.report);
  } else if (data.request.mode === 'create') {
    businessDate.value = data.request.businessDate;
    shiftId.value = data.request.shiftId;
    const defaultPerson = data.persons.find((person) => person.active)?.id;
    resetDailyReportForm(defaultPerson);
    setDefaultResponsiblePerson(defaultPerson);
  }
  pageReady.value = true;
}

const loadController = createOwnerReportLoadController<OwnerReportPageData>({
  reset: resetPageState,
  setLoading(value) {
    loading.value = value;
  },
  apply: applyPageData,
  fail(error) {
    loadErrorMessage.value = ownerReportDataErrorMessage(
      error,
      '読み込みに失敗しました',
    );
    ElMessage.error(loadErrorMessage.value);
  },
});

const saveController =
  createOwnerReportSaveController<OwnerReportSaveOutcome>({
    setSaving(value) {
      saving.value = value;
    },
    async succeed(outcome) {
      if (!outcome.saved) return;
      ElMessage.success(
        outcome.mode === 'edit' ? '修正しました' : '老板补录を保存しました',
      );
      await router.replace(ownerDailyPath);
    },
    fail(error) {
      ElMessage.error(ownerReportDataErrorMessage(error, '保存に失敗しました'));
    },
  });

onUnmounted(() => {
  loadController.invalidate();
  saveController.invalidate();
});

function currentRouteRequest(): OwnerReportRouteRequest | null {
  const mode = ownerReportMode(route.name);
  if (mode === 'edit') {
    const key = String(route.params.reportKey ?? '');
    return key ? { mode, reportKey: key } : null;
  }
  if (mode === 'create') {
    return {
      mode,
      businessDate: String(route.query.businessDate ?? ''),
      shiftId: String(route.query.shiftId ?? ''),
    };
  }
  return null;
}

async function loadPage(): Promise<void> {
  const request = currentRouteRequest();
  await loadController.load(async () => {
    if (!request) throw new DataRepositoryError('DATA_NOT_FOUND');
    return readPageData(request);
  });
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
  if (!pageReady.value || loading.value || saving.value) return;
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
    responsiblePersonSnapshot: responsiblePersonSnapshot(
      existingReport.value,
      payload.responsiblePersonId,
      selectedPerson.name,
    ),
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
  if (!pageReady.value || loading.value) return;
  const validationError = validateDailyReportSubmit({
    form,
    admin: validationOptions(),
  });
  if (validationError) {
    ElMessage.error(validationError);
    return;
  }
  await saveController.run(async (isCurrent) => {
    try {
      await confirmCashBeforeSubmit({
        registerFloatYen: registerFloatAmount.value,
        cashInDrawerYen: form.cashInDrawerYen,
        withdrawalYen: preview.value.cashDepositYen,
      });
    } catch {
      return { saved: false };
    }
    if (!isCurrent()) return { saved: false };
    const command = buildCommand();
    const key = reportKey.value;
    await saveOwnerReport(key, command, dailyReportsRepository);
    return { saved: true, mode: key ? 'edit' : 'create' };
  });
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

    <p
      v-if="!loading && !pageReady && loadErrorMessage"
      class="load-error"
      role="alert"
    >
      {{ loadErrorMessage }}
    </p>

    <template v-if="!loading && pageReady && step === 'confirm'">
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
          :disabled="!pageReady"
          @click="submit"
        >
          {{ isNew ? '老板补录を保存' : '修正を保存' }}
        </el-button>
      </div>
    </template>

    <el-form
      v-if="!loading && pageReady && step === 'form'"
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
.load-error { padding: 16px; color: var(--el-color-danger); border: 1px solid var(--el-color-danger-light-5); border-radius: var(--fs-radius-sm); }
.confirm-actions { margin-top: 20px; padding-top: 8px; }
.submit-btn { width: 100%; max-width: 360px; font-weight: 700; }
</style>
