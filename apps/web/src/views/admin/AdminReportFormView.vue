<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '@/api/http';
import { ElMessage } from 'element-plus';
import { confirmCashBeforeSubmit } from '@/utils/coupon-labels';
import { minuteToHm, parseHmToMinute, wrapEndAfterStart } from '@/utils/time-parse';
import {
  validateDailyReportGoToConfirm,
  validateDailyReportSubmit,
} from '@/utils/daily-report-form-validate';
import { useDailyReportFormState } from '@/composables/useDailyReportFormState';
import { useDailyReportPreview } from '@/composables/useDailyReportPreview';
import DailyReportFormFields from '@/components/daily-report/DailyReportFormFields.vue';
import DailyReportConfirmSummary from '@/components/daily-report/DailyReportConfirmSummary.vue';
import { httpErrorMessage } from '@/utils/http-error-message';

const route = useRoute();
const router = useRouter();

const loading = ref(true);
const saving = ref(false);
const step = ref<'form' | 'confirm'>('form');
const registerFloatAmount = ref(0);
const editId = ref<string | null>(null);
const shiftId = ref('');
const reportDate = ref('');
const createdByUserId = ref('');
const shifts = ref<{ id: string; name: string }[]>([]);
const persons = ref<{ id: string; name: string }[]>([]);
const webmasters = ref<{ id: string; username: string }[]>([]);
const {
  form,
  reset: resetDailyReportForm,
  applyExisting,
  setDefaultResponsiblePerson,
  buildPayload: buildDailyReportPayload,
} = useDailyReportFormState();

const isNew = computed(() => !editId.value);

const shiftName = computed(
  () => shifts.value.find((s) => s.id === shiftId.value)?.name ?? '—',
);
const personName = computed(
  () =>
    persons.value.find((p) => p.id === form.responsiblePersonId)?.name ?? '—',
);
const webmasterLabel = computed(
  () =>
    webmasters.value.find((w) => w.id === createdByUserId.value)?.username ??
    '—',
);

const preview = useDailyReportPreview(form, registerFloatAmount);

async function loadMeta() {
  const [{ data: s }, { data: p }, { data: w }, { data: settings }] =
    await Promise.all([
      http.get('/meta/shifts'),
      http.get('/meta/responsible-persons'),
      http.get('/meta/webmaster-users'),
      http.get<{ registerFloatAmount?: number } | null>('/meta/settings'),
    ]);
  shifts.value = s;
  persons.value = p;
  webmasters.value = w;
  registerFloatAmount.value = settings?.registerFloatAmount ?? 0;
  setDefaultResponsiblePerson(p[0]?.id);
}

async function loadExisting(id: string) {
  const { data } = await http.get(`/daily-reports/${id}`);
  editId.value = id;
  shiftId.value = data.shiftId;
  reportDate.value = data.reportDate;
  createdByUserId.value = data.createdByUserId;
  applyExisting(data);
}

async function loadNewDefaultsFromPreviousShift() {
  if (!reportDate.value || !shiftId.value) return;
  try {
    const { data } = await http.get<{ previousShiftEndMinute: number | null }>(
      '/daily-reports/hint/business-day',
      { params: { reportDate: reportDate.value, shiftId: shiftId.value } },
    );
    if (data.previousShiftEndMinute == null) return;
    form.startStr = minuteToHm(data.previousShiftEndMinute);
    const sm = parseHmToMinute(form.startStr);
    const em = parseHmToMinute(form.endStr);
    form.endStr = minuteToHm(wrapEndAfterStart(sm, em));
  } catch {
    // 仅作时间提示；失败不改变当前表单
  }
}

function resetFormForNewAdminReport() {
  resetDailyReportForm(persons.value[0]?.id);
}

async function loadPage() {
  loading.value = true;
  step.value = 'form';
  try {
    await loadMeta();
    if (route.name === 'admin-report-edit' && route.params.id) {
      await loadExisting(route.params.id as string);
    } else if (route.name === 'admin-report-new') {
      editId.value = null;
      reportDate.value = (route.query.reportDate as string) || '';
      shiftId.value = (route.query.shiftId as string) || '';
      createdByUserId.value = (route.query.createdByUserId as string) || '';
      resetFormForNewAdminReport();
      await loadNewDefaultsFromPreviousShift();
    }
  } catch (e: unknown) {
    ElMessage.error(httpErrorMessage(e, '読み込みに失敗しました'));
  } finally {
    loading.value = false;
  }
}

watch(
  () =>
    [
      route.name,
      route.params.id,
      route.query.reportDate,
      route.query.shiftId,
      route.query.createdByUserId,
    ] as const,
  () => {
    if (route.name === 'admin-report-edit' || route.name === 'admin-report-new') {
      void loadPage();
    }
  },
  { immediate: true },
);

function goToConfirm() {
  const err = validateDailyReportGoToConfirm({
    form,
    admin: isNew.value
      ? {
          isNew: true,
          createdByUserId: createdByUserId.value,
          reportDate: reportDate.value,
          shiftId: shiftId.value,
        }
      : undefined,
  });
  if (err) {
    ElMessage.error(err);
    return;
  }
  step.value = 'confirm';
}

function backToForm() {
  step.value = 'form';
}

function buildPayload() {
  const base = buildDailyReportPayload(reportDate.value, shiftId.value);
  if (isNew.value) {
    return { ...base, createdByUserId: createdByUserId.value };
  }
  return base;
}

async function submit() {
  const errSubmit = validateDailyReportSubmit({
    form,
    admin: isNew.value
      ? {
          isNew: true,
          createdByUserId: createdByUserId.value,
          reportDate: reportDate.value,
          shiftId: shiftId.value,
        }
      : undefined,
  });
  if (errSubmit) {
    ElMessage.error(errSubmit);
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
    const payload = buildPayload();
    let id = editId.value;
    if (id) {
      await http.put(`/daily-reports/${id}`, payload);
    } else {
      const res = await http.post<{ id: string }>('/daily-reports', payload);
      id = res.data.id;
      editId.value = id;
    }
    ElMessage.success('提出しました');
    router.replace('/admin/daily');
  } catch (e: unknown) {
    ElMessage.error(httpErrorMessage(e, 'エラー'));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="page" v-loading="loading">
    <header class="bar">
      <el-button
        link
        @click="step === 'confirm' ? backToForm() : router.back()"
      >
        {{ step === 'confirm' ? '入力に戻る' : '戻る' }}
      </el-button>
      <h2>日報（管理者）— {{ reportDate }}</h2>
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
        :show-webmaster-row="isNew"
        :webmaster-label="webmasterLabel"
      />
      <div class="confirm-actions">
        <el-button type="primary" size="large" class="submit-btn" :loading="saving" @click="submit">
          提出する
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
        v-model:created-by-user-id="createdByUserId"
        :form="form"
        :persons="persons"
        :register-float-amount="registerFloatAmount"
        :preview="preview"
        variant="admin"
        :show-webmaster-select="isNew"
        :webmasters="webmasters"
        @confirm="goToConfirm"
      />
    </el-form>
  </div>
</template>

<style scoped>
.page {
  max-width: 900px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
.confirm-actions {
  margin-top: 20px;
  padding-top: 8px;
}

.submit-btn {
  width: 100%;
  max-width: 360px;
  font-weight: 700;
}
</style>
