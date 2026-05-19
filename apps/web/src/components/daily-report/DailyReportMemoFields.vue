<script setup lang="ts">
import DailyReportSection from './DailyReportSection.vue';
import type { DailyReportFormFieldsModel } from './daily-report-form.types';

defineProps<{
  form: DailyReportFormFieldsModel;
  deviationYenPreview: number;
}>();

function formatYen(n: number): string {
  return `${n.toLocaleString('ja-JP')} 円`;
}
</script>

<template>
  <DailyReportSection title="メモ">
    <div class="deviation-preview">
      <h4 class="deviation-preview-title">偏差（計算）</h4>
      <p class="deviation-num">{{ formatYen(deviationYenPreview) }}</p>
    </div>
    <el-form-item label="偏差理由（負偏差時は必須）" class="item-plain">
      <el-input v-model="form.expenseReason" type="textarea" :rows="3" />
    </el-form-item>
  </DailyReportSection>
</template>

<style scoped>
.item-plain {
  margin-bottom: 0;
}

.item-plain :deep(.el-form-item__label) {
  font-weight: 600;
  color: var(--fs-ink, var(--el-text-color-primary));
}

.deviation-preview {
  margin-bottom: 16px;
  padding: 16px 18px 14px;
  border: 1px solid var(--fs-border-strong, var(--el-border-color));
  border-radius: var(--fs-radius-md, 10px);
  background: var(--fs-surface, var(--el-fill-color-blank));
}

.deviation-preview-title {
  margin: 0 0 10px;
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.deviation-num {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: var(--fs-ink, var(--el-text-color-primary));
}
</style>
