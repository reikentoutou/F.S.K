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
/** 填写 → 确认 */
const step = ref<'form' | 'confirm'>('form');
/** 设置中的收银底钱（从实点中扣除） */
const registerFloatAmount = ref(0);
const editId = ref<string | null>(null);
const shiftId = ref('');
const reportDate = ref('');
const shifts = ref<{ id: string; name: string }[]>([]);
const persons = ref<{ id: string; name: string }[]>([]);
/** 新建时：开始时刻是否已按上一班次结束对齐（仅展示；可手改） */
const startTimeFromPreviousShift = ref(false);
const {
  form,
  reset: resetDailyReportForm,
  setDefaultResponsiblePerson,
  buildPayload: buildDailyReportPayload,
} = useDailyReportFormState();

const pageTitle = computed(() =>
  editId.value ? '日報を提出済' : '日報を新規',
);

const shiftName = computed(
  () => shifts.value.find((s) => s.id === shiftId.value)?.name ?? '—',
);
const personName = computed(
  () =>
    persons.value.find((p) => p.id === form.responsiblePersonId)?.name ?? '—',
);

const preview = useDailyReportPreview(form, registerFloatAmount);

async function loadMeta() {
  const [{ data: s }, { data: p }, { data: settings }] =
    await Promise.all([
      http.get('/meta/shifts'),
      http.get('/meta/responsible-persons'),
      http.get<{ registerFloatAmount?: number } | null>('/meta/settings'),
    ]);
  shifts.value = s;
  persons.value = p;
  registerFloatAmount.value = settings?.registerFloatAmount ?? 0;
  setDefaultResponsiblePerson(p[0]?.id);
}

/** 新建：同一日期内 sortOrder 上一档已有日报则开始时刻默认为其结束（与责任人无关），可手改 */
async function applyStartFromPreviousShift() {
  startTimeFromPreviousShift.value = false;
  try {
    const { data } = await http.get<{ previousShiftEndMinute: number | null }>(
      '/daily-reports/hint/business-day',
      { params: { reportDate: reportDate.value, shiftId: shiftId.value } },
    );
    if (data.previousShiftEndMinute == null) return;
    form.startStr = minuteToHm(data.previousShiftEndMinute);
    startTimeFromPreviousShift.value = true;
    const sm = parseHmToMinute(form.startStr);
    const em = parseHmToMinute(form.endStr);
    form.endStr = minuteToHm(wrapEndAfterStart(sm, em));
  } catch {
    // API 不可用时保留 reset 后的默认时间，仍可手填
  }
}

function resetFormForNewShift() {
  editId.value = null;
  resetDailyReportForm(persons.value[0]?.id);
}

async function tryLoadExistingForNew() {
  const { data: list } = await http.get<{ shiftId: string; id: string }[]>(
    '/daily-reports',
    { params: { reportDate: reportDate.value } },
  );
  const ex = list.find((x) => x.shiftId === shiftId.value);
  if (ex) {
    ElMessage.warning('提出済みの日報は網管側では編集できません');
    await router.replace('/wm');
    return;
  }
  resetFormForNewShift();
  await applyStartFromPreviousShift();
}

async function loadPage() {
  loading.value = true;
  step.value = 'form';
  try {
    await loadMeta();
    if (route.name === 'wm-report-edit') {
      ElMessage.warning('提出済みの日報は網管側では編集できません');
      await router.replace('/wm');
      return;
    } else if (route.name === 'wm-report') {
      reportDate.value = String(route.params.date ?? '');
      shiftId.value = String(route.params.shiftId ?? '');
      await tryLoadExistingForNew();
    }
  } catch (e: unknown) {
    ElMessage.error(httpErrorMessage(e, '読み込みに失敗しました'));
  } finally {
    loading.value = false;
  }
}

watch(
  () =>
    [route.name, route.params.date, route.params.shiftId, route.params.id] as const,
  () => {
    if (route.name === 'wm-report' || route.name === 'wm-report-edit') {
      void loadPage();
    }
  },
  { immediate: true },
);

function goToConfirm() {
  const err = validateDailyReportGoToConfirm({
    form,
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
  return buildDailyReportPayload(reportDate.value, shiftId.value);
}

async function submit() {
  const errSubmit = validateDailyReportSubmit({
    form,
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
    if (!id) {
      const res = await http.post<{ id: string }>('/daily-reports', payload);
      id = res.data.id;
      editId.value = id;
    }
    ElMessage.success('提出しました');
    router.replace('/wm');
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
      <h2>{{ pageTitle }} — {{ reportDate }}</h2>
    </header>

    <!-- 确认：展示填写内容与计算偏差 -->
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
        :form="form"
        :persons="persons"
        :register-float-amount="registerFloatAmount"
        :preview="preview"
        variant="wm"
        :show-wm-time-hint="!editId"
        :start-time-from-previous-shift="startTimeFromPreviousShift"
        @confirm="goToConfirm"
      />
    </el-form>
  </div>
</template>

<style scoped>
.page {
  max-width: 900px;
  margin: 0 auto;
  padding: 16px;
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
