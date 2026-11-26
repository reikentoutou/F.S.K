<script setup lang="ts">
import { computed } from 'vue';
import { minuteToHm, parseHmToMinute } from '@/utils/time-parse';

const model = defineModel<string>({ required: true });

withDefaults(
  defineProps<{
    hourLabel?: string;
    minuteLabel?: string;
  }>(),
  { hourLabel: '時', minuteLabel: '分' },
);

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

const hour = computed({
  get() {
    const m = parseHmToMinute(model.value);
    return String(Math.floor(m / 60)).padStart(2, '0');
  },
  set(h: string) {
    const m = parseHmToMinute(model.value);
    const hi = Number.parseInt(h, 10);
    const mi = m % 60;
    model.value = minuteToHm(Number.isFinite(hi) ? hi * 60 + mi : mi);
  },
});

const minute = computed({
  get() {
    const m = parseHmToMinute(model.value);
    return String(m % 60).padStart(2, '0');
  },
  set(mm: string) {
    const m = parseHmToMinute(model.value);
    const hi = Math.floor(m / 60);
    const mi = Number.parseInt(mm, 10);
    model.value = minuteToHm(hi * 60 + (Number.isFinite(mi) ? mi : 0));
  },
});
</script>

<template>
  <span class="hm-split">
    <el-select
      v-model="hour"
      filterable
      :placeholder="hourLabel"
      class="hm-hour"
      aria-label="時"
    >
      <el-option v-for="h in HOURS" :key="h" :label="h" :value="h" />
    </el-select>
    <span class="colon">:</span>
    <el-select
      v-model="minute"
      filterable
      :placeholder="minuteLabel"
      class="hm-minute"
      aria-label="分"
    >
      <el-option v-for="mm in MINUTES" :key="mm" :label="mm" :value="mm" />
    </el-select>
  </span>
</template>

<style scoped>
.hm-split {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 4px;
  vertical-align: middle;
}
.colon {
  font-weight: 600;
  color: var(--el-text-color-regular);
  user-select: none;
}
.hm-hour,
.hm-minute {
  flex: 1;
  width: 0;
  min-width: 0;
}
.hm-split :deep(.el-select__wrapper) {
  min-height: 44px;
  padding: 0 8px;
  gap: 4px;
}
.hm-split :deep(.el-select__selected-item) { font-size: 16px; }
@media (max-width: 360px) {
  .hm-split { gap: 2px; }
  .hm-split :deep(.el-select__wrapper) { padding: 0 6px; gap: 2px; }
}
</style>
