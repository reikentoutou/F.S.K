<script setup lang="ts">
import DailyReportBasicFields from './DailyReportBasicFields.vue';
import DailyReportSalesFields from './DailyReportSalesFields.vue';
import DailyReportSubmitterFields from './DailyReportSubmitterFields.vue';
import type {
  DailyReportFormFieldsModel,
  ResponsiblePersonOption,
  WebmasterOption,
} from './daily-report-form.types';

defineProps<{
    form: DailyReportFormFieldsModel;
    persons: ResponsiblePersonOption[];
    registerFloatAmount: number;
    preview: {
      imosSalesYen: number;
      totalSalesYen: number;
      cashDepositYen: number;
      deviationYen: number;
      staffMealTotalYen: number;
    };
    variant: 'wm' | 'admin' | 'kitchen';
    showWmTimeHint?: boolean;
    showKitchenTimeHint?: boolean;
    startTimeFromPreviousShift?: boolean;
    showWebmasterSelect?: boolean;
    webmasters?: WebmasterOption[];
  }>();

const createdByUserId = defineModel<string>('createdByUserId', {
  required: false,
});

defineEmits<{
  confirm: [];
}>();
</script>

<template>
  <div class="daily-report-form-fields">
    <DailyReportSubmitterFields
      v-if="showWebmasterSelect"
      v-model:created-by-user-id="createdByUserId"
      :webmasters="webmasters"
    />

    <p v-if="variant === 'kitchen' && showKitchenTimeHint" class="kitchen-time-hint">
      開始・終了時刻はこのシフトの実績を確認して入力してください。日をまたぐ終了時刻も入力できます。
    </p>

    <DailyReportBasicFields
      :form="form"
      :persons="persons"
      :variant="variant === 'kitchen' ? 'wm' : variant"
      :show-wm-time-hint="variant === 'wm' && showWmTimeHint"
      :start-time-from-previous-shift="startTimeFromPreviousShift"
    />

    <DailyReportSalesFields
      :form="form"
      :register-float-amount="registerFloatAmount"
      :preview="preview"
    />

    <div class="actions">
      <el-button type="primary" size="large" class="confirm-btn" @click="$emit('confirm')">
        入力内容を確認
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.daily-report-form-fields {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.actions {
  padding-top: 4px;
}

.kitchen-time-hint {
  margin: 0;
  padding: 12px 14px;
  border-radius: var(--fs-radius-sm, 6px);
  color: var(--fs-muted, var(--el-text-color-secondary));
  background: var(--fs-surface, var(--el-fill-color-light));
  font-size: 13px;
  line-height: 1.55;
}

.confirm-btn {
  width: 100%;
  max-width: 360px;
  font-weight: 700;
}

@media (prefers-reduced-motion: no-preference) {
  .confirm-btn:not(:disabled):active {
    transform: translateY(1px);
  }

  .confirm-btn {
    transition: transform 0.12s var(--fs-ease-out, cubic-bezier(0.25, 1, 0.5, 1));
  }
}
</style>
