<script setup lang="ts">
import DailyReportBasicFields from './DailyReportBasicFields.vue';
import DailyReportSalesFields from './DailyReportSalesFields.vue';
import type {
  DailyReportFormFieldsModel,
  ResponsiblePersonOption,
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
  }>();

defineEmits<{
  confirm: [];
}>();
</script>

<template>
  <div class="daily-report-form-fields">
    <DailyReportBasicFields
      :form="form"
      :persons="persons"
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
