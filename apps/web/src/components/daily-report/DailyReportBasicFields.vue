<script setup lang="ts">
import HmSplitSelect from '@/components/HmSplitSelect.vue';
import DailyReportSection from './DailyReportSection.vue';
import type {
  DailyReportFormFieldsModel,
  ResponsiblePersonOption,
} from './daily-report-form.types';

defineProps<{
  form: DailyReportFormFieldsModel;
  persons: ResponsiblePersonOption[];
}>();
</script>

<template>
  <DailyReportSection title="基本">
    <el-form-item label="責任者" class="item-plain">
      <div class="field-with-guide">
        <el-select v-model="form.responsiblePersonId" class="field-wide" placeholder="選択">
          <el-option v-for="p in persons" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
      </div>
    </el-form-item>

    <el-form-item label="Newage時間" class="item-plain item-time">
      <div class="time-field-with-guide">
        <div class="time-row">
          <div class="time-block">
            <span class="time-tag">開始</span>
            <HmSplitSelect v-model="form.startStr" />
          </div>
          <span class="time-dash" aria-hidden="true">—</span>
          <div class="time-block">
            <span class="time-tag">終了</span>
            <HmSplitSelect v-model="form.endStr" />
          </div>
        </div>
      </div>
    </el-form-item>
  </DailyReportSection>
</template>

<style scoped>
.item-plain {
  margin-bottom: 16px;
}

.item-plain:last-child {
  margin-bottom: 0;
}

.item-plain :deep(.el-form-item__label) {
  font-weight: 600;
  color: var(--fs-ink, var(--el-text-color-primary));
}

.field-wide {
  width: 100%;
  max-width: 360px;
}

.field-with-guide,
.time-field-with-guide {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 14px;
  width: 100%;
}

.time-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 12px;
}

.time-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.time-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.time-dash {
  padding-bottom: 8px;
  font-weight: 700;
  color: var(--fs-faint, var(--el-text-color-placeholder));
}

@media (max-width: 720px) {
  .field-with-guide,
  .time-field-with-guide {
    flex-direction: column;
  }
}
</style>
