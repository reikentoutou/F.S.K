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
      <div class="field-row">
        <el-select v-model="form.responsiblePersonId" class="field-wide" placeholder="選択">
          <el-option v-for="p in persons" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
      </div>
    </el-form-item>

    <el-form-item label="Newage時間" class="item-plain item-time">
      <div class="field-row">
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
.item-plain { margin-bottom: 12px; }
.item-plain:last-child { margin-bottom: 0; }
.item-plain :deep(.el-form-item__label) {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--fs-ink);
}
.field-wide { width: 100%; max-width: 360px; }
.field-row { width: 100%; min-width: 0; }
.time-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: end;
  gap: 12px;
  max-width: 460px;
}
.time-block { display: grid; gap: 4px; min-width: 0; }
.time-tag { font-size: 12px; line-height: 18px; color: var(--fs-muted); }
.time-dash { padding-bottom: 12px; color: var(--fs-faint); }
.item-plain :deep(.el-select__wrapper) { min-height: 44px; }

@media (max-width: 640px) {
  .field-wide { max-width: none; }
  .time-row { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .time-dash { display: none; }
}
</style>
