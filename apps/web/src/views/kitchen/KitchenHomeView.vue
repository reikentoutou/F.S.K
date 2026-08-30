<script lang="ts">
import { kitchenContextRepository } from '@/data/master-data';

type RawKitchenContext = Awaited<
  ReturnType<typeof kitchenContextRepository.getContext>
>;

export interface KitchenContext {
  registerFloatAmount: number;
  shifts: Array<{ id: string; name: string; sortOrder: number }>;
  responsiblePersons: Array<{ id: string; name: string }>;
  submittedShiftIds: string[];
}

interface KitchenDateEventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface KitchenVisibilitySource extends KitchenDateEventSource {
  readonly visibilityState: string;
}

export function createKitchenBusinessDateTracker(options: {
  today(): string;
  getBusinessDate(): string;
  setBusinessDate(value: string): void;
  documentSource: KitchenVisibilitySource;
  windowSource: KitchenDateEventSource;
}): { dispose(): void } {
  let observedToday = options.today();
  const refresh = () => {
    const nextToday = options.today();
    if (options.getBusinessDate() === observedToday) {
      options.setBusinessDate(nextToday);
    }
    observedToday = nextToday;
  };
  const refreshWhenVisible = () => {
    if (options.documentSource.visibilityState === 'visible') refresh();
  };

  options.documentSource.addEventListener(
    'visibilitychange',
    refreshWhenVisible,
  );
  options.windowSource.addEventListener('pageshow', refresh);

  return {
    dispose() {
      options.documentSource.removeEventListener(
        'visibilitychange',
        refreshWhenVisible,
      );
      options.windowSource.removeEventListener('pageshow', refresh);
    },
  };
}

function normalizeKitchenContext(value: RawKitchenContext): KitchenContext {
  if (!value) throw new Error('KITCHEN_CONTEXT_UNAVAILABLE');
  return {
    registerFloatAmount: value.registerFloatAmount,
    shifts: value.shifts.filter(
      (shift): shift is NonNullable<typeof shift> => shift != null,
    ),
    responsiblePersons: value.responsiblePersons.filter(
      (person): person is NonNullable<typeof person> => person != null,
    ),
    submittedShiftIds: value.submittedShiftIds.filter(
      (shiftId): shiftId is NonNullable<typeof shiftId> => shiftId != null,
    ),
  };
}

export function loadKitchenHomeContext(
  businessDate: string,
  repository: Pick<typeof kitchenContextRepository, 'getContext'> =
    kitchenContextRepository,
): Promise<KitchenContext> {
  return repository.getContext(businessDate).then(normalizeKitchenContext);
}

export function kitchenShiftNavigation(
  context: KitchenContext,
  businessDate: string,
  shiftId: string,
): {
  name: 'kitchen-report';
  params: { date: string; shiftId: string };
} | null {
  if (context.submittedShiftIds.includes(shiftId)) return null;
  return {
    name: 'kitchen-report',
    params: { date: businessDate, shiftId },
  };
}
</script>

<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { todayTokyo } from '@/utils/tokyo';
import { isKitchenDatePickerDisabled } from './kitchen-business-date';

const auth = useAuthStore();
const router = useRouter();
const businessDate = shallowRef(todayTokyo());
const context = shallowRef<KitchenContext | null>(null);
const loading = shallowRef(true);
const loadError = shallowRef(false);
let dateTracker: { dispose(): void } | undefined;

onMounted(() => {
  dateTracker = createKitchenBusinessDateTracker({
    today: todayTokyo,
    getBusinessDate: () => businessDate.value,
    setBusinessDate: (value) => {
      businessDate.value = value;
    },
    documentSource: document,
    windowSource: window,
  });
});

onUnmounted(() => {
  dateTracker?.dispose();
});

watch(
  businessDate,
  async (date, _previousDate, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    loading.value = true;
    loadError.value = false;
    context.value = null;
    try {
      const loaded = await loadKitchenHomeContext(date);
      if (active) context.value = loaded;
    } catch {
      if (active) loadError.value = true;
    } finally {
      if (active) loading.value = false;
    }
  },
  { immediate: true },
);

function isSubmitted(shiftId: string): boolean {
  return context.value?.submittedShiftIds.includes(shiftId) ?? false;
}

async function goToShift(shiftId: string): Promise<void> {
  if (!context.value) return;
  const target = kitchenShiftNavigation(
    context.value,
    businessDate.value,
    shiftId,
  );
  if (target) await router.push(target);
}

async function logout(): Promise<void> {
  await auth.logout();
  await router.replace('/login');
}
</script>

<template>
  <div class="page">
    <header class="bar">
      <div class="bar-titles">
        <p class="eyebrow">財務日報</p>
        <h1 class="title">厨房端末</h1>
      </div>
      <div class="right">
        <span class="user">{{ auth.user?.username }}</span>
        <el-button link type="primary" class="logout" @click="logout">
          ログアウト
        </el-button>
      </div>
    </header>

    <main class="main" v-loading="loading">
      <section class="panel" aria-labelledby="entry-heading">
        <div class="date-field">
          <label id="entry-heading" class="date-label">業務日</label>
          <el-date-picker
            v-model="businessDate"
            type="date"
            value-format="YYYY-MM-DD"
            :disabled-date="isKitchenDatePickerDisabled"
            aria-labelledby="entry-heading"
          />
        </div>

        <p v-if="loadError" class="error" role="alert">
          入力情報を読み込めませんでした。通信を確認して再読み込みしてください。
        </p>
        <template v-else-if="context">
          <p class="guide">入力するシフトを選択してください。</p>
          <div class="shift-list">
            <button
              v-for="shift in context.shifts"
              :key="shift.id"
              type="button"
              class="shift-link"
              :class="{ 'is-submitted': isSubmitted(shift.id) }"
              :disabled="isSubmitted(shift.id)"
              @click="goToShift(shift.id)"
            >
              <span>{{ shift.name }}</span>
              <span>{{ isSubmitted(shift.id) ? '提出済' : '入力する →' }}</span>
            </button>
          </div>
          <p v-if="context.shifts.length === 0" class="empty">
            現在入力できるシフトがありません。老板へ連絡してください。
          </p>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: var(--fs-vh-100);
  display: flex;
  flex-direction: column;
  background: var(--fs-page);
}

.bar {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 22px 14px 26px;
  background: var(--fs-surface-elevated);
  border-bottom: 1px solid var(--fs-border);
}

.bar-titles {
  min-width: 0;
}

.eyebrow,
.date-label {
  margin: 0 0 4px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: var(--fs-muted);
}

.title {
  margin: 0;
  color: var(--fs-ink);
}

.title {
  font-size: 1.25rem;
}

.date-field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user,
.guide,
.empty {
  color: var(--fs-muted);
}

.user {
  font-size: 0.86rem;
}

.main {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 28px 20px;
}

.panel {
  min-height: 220px;
  padding: 24px;
  border: 1px solid var(--fs-border);
  border-radius: var(--fs-radius-md);
  background: var(--fs-surface-elevated);
  box-shadow: var(--fs-shadow-soft);
}

.guide {
  margin: 20px 0 12px;
}

.shift-list {
  display: grid;
  gap: 12px;
}

.shift-link {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 56px;
  padding: 14px 16px;
  border: 1px solid var(--fs-border-strong, var(--fs-border));
  border-radius: var(--fs-radius-sm);
  color: var(--el-color-primary);
  font: inherit;
  font-weight: 700;
  text-align: left;
  text-decoration: none;
  background: var(--fs-surface);
  cursor: pointer;
}

.shift-link.is-submitted {
  color: var(--fs-muted);
  cursor: default;
  border-color: var(--fs-border);
  background: color-mix(in srgb, var(--el-color-success) 6%, var(--fs-surface));
}

.error {
  margin: 20px 0 0;
  color: var(--el-color-danger);
  line-height: 1.6;
}

@media (max-width: 640px) {
  .bar {
    padding: 12px 16px;
  }

  .user {
    display: none;
  }

  .main {
    padding: 18px 12px;
  }

  .panel {
    padding: 20px 16px;
  }
}
</style>
