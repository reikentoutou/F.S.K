<script setup lang="ts">
import { ref } from 'vue';
import HmSplitSelect from '@/components/HmSplitSelect.vue';
import DailyReportSection from './DailyReportSection.vue';
import type {
  DailyReportFormFieldsModel,
  ResponsiblePersonOption,
} from './daily-report-form.types';

defineProps<{
  form: DailyReportFormFieldsModel;
  persons: ResponsiblePersonOption[];
  variant: 'wm' | 'admin';
  showWmTimeHint?: boolean;
  startTimeFromPreviousShift?: boolean;
}>();

const wmTimeCollapse = ref<string[]>([]);
</script>

<template>
  <DailyReportSection title="基本">
    <el-form-item label="責任者" class="item-plain">
      <div class="field-with-guide">
        <el-select v-model="form.responsiblePersonId" class="field-wide" placeholder="選択">
          <el-option v-for="p in persons" :key="p.id" :label="p.name" :value="p.id" />
        </el-select>
        <p class="field-guide">このシフトの実際の担当者を選択してください。</p>
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
        <p class="field-guide time-guide">
          開始・終了を実際のNewage時間で確認します。日をまたぐ場合は終了が開始より早い時刻でも入力できます。
          <template v-if="variant === 'wm' && showWmTimeHint && startTimeFromPreviousShift">
            前シフト終了時刻を開始に反映済みです。
          </template>
        </p>
      </div>
      <template v-if="variant === 'wm' && showWmTimeHint">
        <el-collapse v-model="wmTimeCollapse" class="time-collapse">
          <el-collapse-item title="業務日・時刻の詳しい説明" name="detail">
            <p class="collapse-text">
              業務日は当日内の「白班 → 夜班」の順です。前シフトの日報がある場合、
              開始時刻はその終了時刻が初期値になります。白班は当日の最初のシフトとして扱い、
              前日の最終シフトは参照しません。いずれも手で変更できます。
            </p>
          </el-collapse-item>
        </el-collapse>
      </template>
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

.field-guide {
  margin: 0;
  max-width: 34ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.time-guide {
  padding-top: 21px;
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

.time-collapse {
  margin-top: 8px;
  border: none;
  --el-collapse-header-height: 40px;
}

.time-collapse :deep(.el-collapse-item__header) {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
  border: none;
}

.time-collapse :deep(.el-collapse-item__wrap) {
  border: none;
}

.time-collapse :deep(.el-collapse-item__content) {
  padding-bottom: 4px;
}

.collapse-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--fs-muted, var(--el-text-color-secondary));
  max-width: 70ch;
}

@media (max-width: 720px) {
  .field-with-guide,
  .time-field-with-guide {
    flex-direction: column;
  }

  .time-guide {
    padding-top: 0;
  }
}
</style>
