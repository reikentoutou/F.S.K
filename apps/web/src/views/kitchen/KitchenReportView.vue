<script lang="ts">
import type { KitchenAttachmentUpload } from '@/data/attachments';
import { kitchenAttachmentRepository } from '@/data/attachments';
import type { CreateDailyReportCommand } from '@/data/daily-reports';
import { dailyReportsRepository } from '@/data/daily-reports';
import { DataRepositoryError } from '@/data/errors';
import { todayTokyo } from '@/utils/tokyo';
import type { KitchenContext } from './KitchenHomeView.vue';

export type KitchenReportMode = 'create' | null;

export function kitchenReportMode(routeName: unknown): KitchenReportMode {
  return routeName === 'kitchen-report' ? 'create' : null;
}

export const kitchenHomePath = '/kitchen';

export function isCurrentKitchenBusinessDate(
  businessDate: string,
  currentBusinessDate = todayTokyo(),
): boolean {
  return businessDate === currentBusinessDate;
}

export function loadKitchenReportContext(
  repository: Pick<
    typeof import('@/data/master-data').kitchenContextRepository,
    'getContext'
  >,
  businessDate: string,
  currentBusinessDate = todayTokyo(),
): Promise<KitchenContext> {
  if (!isCurrentKitchenBusinessDate(businessDate, currentBusinessDate)) {
    return Promise.reject(new Error('KITCHEN_BUSINESS_DATE_NOT_CURRENT'));
  }
  return repository.getContext().then((value) => {
    if (!value) throw new Error('KITCHEN_CONTEXT_UNAVAILABLE');
    return {
      registerFloatAmount: value.registerFloatAmount,
      shifts: value.shifts.filter(
        (shift): shift is NonNullable<typeof shift> => shift != null,
      ),
      responsiblePersons: value.responsiblePersons.filter(
        (person): person is NonNullable<typeof person> => person != null,
      ),
    };
  });
}

export function createKitchenReport(
  command: CreateDailyReportCommand,
  repository: Pick<typeof dailyReportsRepository, 'create'> =
    dailyReportsRepository,
) {
  return repository.create(command);
}

export function uploadKitchenReportAttachment(
  input: KitchenAttachmentUpload,
  repository: Pick<typeof kitchenAttachmentRepository, 'upload'> =
    kitchenAttachmentRepository,
) {
  return repository.upload(input);
}

export function kitchenSubmissionFailure(error: unknown): {
  event: 'FAIL' | 'UNKNOWN';
  message: string;
} {
  if (error instanceof DataRepositoryError) {
    if (error.code === 'REPORT_ALREADY_EXISTS') {
      return {
        event: 'FAIL',
        message: '该营业日和班次可能已提交，请老板确认',
      };
    }
    if (error.code === 'SUBMISSION_RESULT_UNKNOWN') {
      return {
        event: 'UNKNOWN',
        message:
          '结果不确定，请勿反复修改数据，重试会检查同一营业日和班次冲突',
      };
    }
  }
  return {
    event: 'FAIL',
    message: '提出に失敗しました。入力内容を保持したまま再試行できます。',
  };
}
</script>

<script setup lang="ts">
import { computeDailyReportTotals } from '@fsk/domain';
import { fetchAuthSession } from 'aws-amplify/auth';
import { computed, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import DailyReportConfirmSummary from '@/components/daily-report/DailyReportConfirmSummary.vue';
import DailyReportFormFields from '@/components/daily-report/DailyReportFormFields.vue';
import { useDailyReportFormState } from '@/composables/useDailyReportFormState';
import { useDailyReportPreview } from '@/composables/useDailyReportPreview';
import { kitchenContextRepository } from '@/data/master-data';
import {
  validateDailyReportGoToConfirm,
  validateDailyReportSubmit,
} from '@/utils/daily-report-form-validate';
import {
  failSubmissionWithoutReset,
  initialSubmissionState,
  transitionSubmissionState,
} from './submission-state';

type SubmittedReport = Awaited<ReturnType<typeof createKitchenReport>>;

const route = useRoute();
const router = useRouter();
const context = shallowRef<KitchenContext | null>(null);
const loading = shallowRef(true);
const loadError = shallowRef(false);
const submission = shallowRef(initialSubmissionState());
const submissionMessage = shallowRef('');
const submittedReport = shallowRef<SubmittedReport | null>(null);
const receiptFile = shallowRef<File | null>(null);
const attachmentKeys = shallowRef<string[]>([]);
const draftId = `draft_${crypto.randomUUID().replaceAll('-', '')}`;
const attachmentId = `attachment_${crypto.randomUUID().replaceAll('-', '')}`;

const businessDate = computed(() => String(route.params.date ?? ''));
const shiftId = computed(() => String(route.params.shiftId ?? ''));
const shift = computed(() =>
  context.value?.shifts.find((item) => item.id === shiftId.value),
);
const persons = computed(() => context.value?.responsiblePersons ?? []);
const registerFloatAmount = computed(
  () => context.value?.registerFloatAmount ?? 0,
);

const {
  form,
  reset,
  setDefaultResponsiblePerson,
  buildPayload,
} = useDailyReportFormState();
const preview = useDailyReportPreview(form, registerFloatAmount);
const personName = computed(
  () =>
    persons.value.find((person) => person.id === form.responsiblePersonId)
      ?.name ?? '—',
);

const submittedTotals = computed(() => {
  const report = submittedReport.value;
  if (!report) return null;
  return computeDailyReportTotals(
    {
      previousImosBalanceYen: report.previousImosBalanceYen,
      currentImosBalanceYen: report.currentImosBalanceYen,
      newageYen: report.newageYen,
      cashTotalYen: report.cashTotalYen,
      expenseYen: report.expenseYen,
      staffMealCashYen: report.staffMealCashYen,
      staffMealAlipayYen: report.staffMealAlipayYen,
    },
    registerFloatAmount.value,
  );
});

watch(
  () => [route.name, route.params.date, route.params.shiftId] as const,
  async () => {
    if (kitchenReportMode(route.name) === null) return;
    loading.value = true;
    loadError.value = false;
    context.value = null;
    submission.value = initialSubmissionState();
    submittedReport.value = null;
    attachmentKeys.value = [];
    receiptFile.value = null;
    reset();
    try {
      const loaded = await loadKitchenReportContext(
        kitchenContextRepository,
        businessDate.value,
      );
      context.value = loaded;
      setDefaultResponsiblePerson(loaded.responsiblePersons[0]?.id);
      if (!loaded.shifts.some((item) => item.id === shiftId.value)) {
        loadError.value = true;
      }
    } catch {
      loadError.value = true;
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

function goToConfirm(): void {
  const error = validateDailyReportGoToConfirm({ form });
  if (error) {
    submissionMessage.value = error;
    return;
  }
  submissionMessage.value = '';
  submission.value = transitionSubmissionState(submission.value, 'CONFIRM');
}

function backToForm(): void {
  submissionMessage.value = '';
  submission.value = transitionSubmissionState(submission.value, 'EDIT');
}

function selectReceipt(event: Event): void {
  const input = event.target as HTMLInputElement;
  receiptFile.value = input.files?.[0] ?? null;
  attachmentKeys.value = [];
}

function buildCommand(): CreateDailyReportCommand {
  if (!isCurrentKitchenBusinessDate(businessDate.value)) {
    throw new Error('KITCHEN_BUSINESS_DATE_NOT_CURRENT');
  }
  const selectedShift = shift.value;
  const selectedPerson = persons.value.find(
    (person) => person.id === form.responsiblePersonId,
  );
  if (!selectedShift || !selectedPerson) {
    throw new Error('INVALID_KITCHEN_CONTEXT_SELECTION');
  }
  const payload = buildPayload(businessDate.value, shiftId.value);
  return {
    businessDate: payload.reportDate,
    shiftId: payload.shiftId,
    shiftNameSnapshot: selectedShift.name,
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
    attachmentKeys: [...attachmentKeys.value],
  };
}

async function ensureReceiptUploaded(): Promise<void> {
  if (!receiptFile.value || attachmentKeys.value.length > 0) return;
  const session = await fetchAuthSession();
  if (!session.identityId) {
    throw new Error('KITCHEN_STORAGE_IDENTITY_UNAVAILABLE');
  }
  const key = await uploadKitchenReportAttachment({
    identityId: session.identityId,
    draftId,
    attachmentId,
    fileName: receiptFile.value.name,
    data: receiptFile.value,
  });
  attachmentKeys.value = [key];
}

async function submit(): Promise<void> {
  const currentStatus = submission.value.status;
  if (currentStatus === 'submitting') return;
  const error = validateDailyReportSubmit({ form });
  if (error) {
    submissionMessage.value = error;
    return;
  }
  const event =
    currentStatus === 'failed' || currentStatus === 'unknown'
      ? 'RETRY'
      : 'SUBMIT';
  const next = transitionSubmissionState(submission.value, event);
  if (next === submission.value) return;
  submission.value = next;
  submissionMessage.value = '';
  try {
    await ensureReceiptUploaded();
    submittedReport.value = await createKitchenReport(buildCommand());
    submission.value = transitionSubmissionState(submission.value, 'SUCCEED');
  } catch (caught) {
    const failure = kitchenSubmissionFailure(caught);
    submissionMessage.value = failure.message;
    const retained = failSubmissionWithoutReset(
      submission.value,
      form,
      failure.event,
    );
    submission.value = retained.state;
  }
}
</script>

<template>
  <main class="page" v-loading="loading">
    <header class="bar">
      <el-button
        link
        @click="
          submission.status === 'confirming' ||
          submission.status === 'failed' ||
          submission.status === 'unknown'
            ? backToForm()
            : router.replace(kitchenHomePath)
        "
      >
        {{
          submission.status === 'confirming' ||
          submission.status === 'failed' ||
          submission.status === 'unknown'
            ? '入力に戻る'
            : '厨房トップへ戻る'
        }}
      </el-button>
      <div>
        <p class="eyebrow">{{ businessDate }}</p>
        <h1 class="title">{{ shift?.name ?? shiftId }}</h1>
      </div>
    </header>

    <section v-if="!loading && loadError" class="panel error-panel" role="alert">
      この業務日・シフトの入力情報を読み込めませんでした。厨房トップへ戻ってください。
    </section>

    <section
      v-else-if="!loading && submission.status === 'succeeded' && submittedReport"
      class="panel success-panel"
      aria-labelledby="success-heading"
    >
      <p class="success-mark" aria-hidden="true">✓</p>
      <h2 id="success-heading">提出しました</h2>
      <dl class="result-list">
        <div><dt>業務日</dt><dd>{{ submittedReport.businessDate }}</dd></div>
        <div>
          <dt>シフト</dt><dd>{{ submittedReport.shiftNameSnapshot }}</dd>
        </div>
        <div>
          <dt>責任者</dt><dd>{{ submittedReport.responsiblePersonSnapshot }}</dd>
        </div>
        <div>
          <dt>実際売上</dt>
          <dd>{{ submittedTotals?.totalSalesYen.toLocaleString('ja-JP') }} 円</dd>
        </div>
        <div>
          <dt>reportKey</dt><dd class="mono">{{ submittedReport.reportKey }}</dd>
        </div>
        <div>
          <dt>提出時刻</dt><dd class="mono">{{ submittedReport.submittedAt }}</dd>
        </div>
      </dl>
      <el-button type="primary" size="large" @click="router.replace(kitchenHomePath)">
        厨房トップへ戻る
      </el-button>
    </section>

    <template v-else-if="!loading && context && shift">
      <section
        v-if="submission.status !== 'editing'"
        class="panel"
        aria-label="提出内容の確認"
      >
        <DailyReportConfirmSummary
          variant="kitchen"
          :preview="preview"
          :shift-name="shift.name"
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
        <p v-if="submissionMessage" class="submission-message" role="alert">
          {{ submissionMessage }}
        </p>
        <el-button
          type="primary"
          size="large"
          class="submit-button"
          :loading="submission.status === 'submitting'"
          :disabled="submission.status === 'submitting'"
          @click="submit"
        >
          {{
            submission.status === 'failed' || submission.status === 'unknown'
              ? '同じ内容で再試行'
              : '提出する'
          }}
        </el-button>
      </section>

      <el-form
        v-else
        label-position="top"
        require-asterisk-position="right"
        class="panel form"
      >
        <DailyReportFormFields
          :form="form"
          :persons="persons"
          :register-float-amount="registerFloatAmount"
          :preview="preview"
          variant="kitchen"
          show-kitchen-time-hint
          @confirm="goToConfirm"
        />
        <div class="attachment-field">
          <label for="kitchen-receipt">領収書画像（任意）</label>
          <input
            id="kitchen-receipt"
            type="file"
            accept="image/*,application/pdf"
            @change="selectReceipt"
          />
          <p v-if="receiptFile" class="attachment-name">{{ receiptFile.name }}</p>
        </div>
        <p v-if="submissionMessage" class="submission-message" role="alert">
          {{ submissionMessage }}
        </p>
      </el-form>
    </template>
  </main>
</template>

<style scoped>
.page {
  width: min(920px, 100%);
  min-height: var(--fs-vh-100);
  margin: 0 auto;
  padding: 20px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.eyebrow {
  margin: 0 0 2px;
  color: var(--fs-muted);
  font-size: 0.78rem;
}

.title {
  margin: 0;
  color: var(--fs-ink);
  font-size: 1.35rem;
}

.panel {
  padding: 20px;
  border: 1px solid var(--fs-border);
  border-radius: var(--fs-radius-md);
  background: var(--fs-surface-elevated);
  box-shadow: var(--fs-shadow-soft);
}

.attachment-field {
  display: grid;
  gap: 8px;
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--fs-border);
  color: var(--fs-ink);
  font-weight: 600;
}

.attachment-field input {
  max-width: 100%;
  font: inherit;
}

.attachment-name,
.submission-message {
  margin: 8px 0 0;
  line-height: 1.55;
}

.attachment-name {
  color: var(--fs-muted);
  font-size: 0.85rem;
}

.submission-message {
  color: var(--el-color-danger);
}

.submit-button {
  width: 100%;
  max-width: 360px;
  margin-top: 20px;
  font-weight: 700;
}

.success-panel {
  text-align: center;
}

.success-mark {
  width: 52px;
  height: 52px;
  margin: 0 auto 12px;
  border-radius: 50%;
  color: white;
  background: var(--el-color-success);
  font-size: 2rem;
  line-height: 52px;
}

.result-list {
  display: grid;
  gap: 10px;
  margin: 22px auto;
  max-width: 600px;
  text-align: left;
}

.result-list div {
  display: grid;
  grid-template-columns: minmax(90px, 32%) 1fr;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--fs-border);
}

.result-list dt {
  color: var(--fs-muted);
}

.result-list dd {
  margin: 0;
  color: var(--fs-ink);
  overflow-wrap: anywhere;
}

.mono {
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  .page {
    padding: 12px;
  }

  .panel {
    padding: 16px;
  }
}
</style>
