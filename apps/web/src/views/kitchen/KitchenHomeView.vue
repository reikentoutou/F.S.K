<script lang="ts">
import { kitchenContextRepository } from '@/data/master-data';

type RawKitchenContext = Awaited<
  ReturnType<typeof kitchenContextRepository.getContext>
>;

export interface KitchenContext {
  registerFloatAmount: number;
  shifts: Array<{ id: string; name: string; sortOrder: number }>;
  responsiblePersons: Array<{ id: string; name: string }>;
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
  };
}

export function loadKitchenHomeContext(
  repository: Pick<typeof kitchenContextRepository, 'getContext'> =
    kitchenContextRepository,
): Promise<KitchenContext> {
  return repository.getContext().then(normalizeKitchenContext);
}
</script>

<script setup lang="ts">
import { onMounted, shallowRef } from 'vue';
import { useRouter } from 'vue-router';

import { useAuthStore } from '@/stores/auth';
import { todayTokyo } from '@/utils/tokyo';

const auth = useAuthStore();
const router = useRouter();
const businessDate = todayTokyo();
const context = shallowRef<KitchenContext | null>(null);
const loading = shallowRef(true);
const loadError = shallowRef(false);

onMounted(async () => {
  try {
    context.value = await loadKitchenHomeContext();
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
});

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
        <p class="date-label">業務日</p>
        <h2 id="entry-heading" class="date">{{ businessDate }}</h2>

        <p v-if="loadError" class="error" role="alert">
          入力情報を読み込めませんでした。通信を確認して再読み込みしてください。
        </p>
        <template v-else-if="context">
          <p class="guide">入力するシフトを選択してください。</p>
          <div class="shift-list">
            <RouterLink
              v-for="shift in context.shifts"
              :key="shift.id"
              :to="{
                name: 'kitchen-report',
                params: { date: businessDate, shiftId: shift.id },
              }"
              class="shift-link"
            >
              <span>{{ shift.name }}</span>
              <span aria-hidden="true">→</span>
            </RouterLink>
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

.title,
.date {
  margin: 0;
  color: var(--fs-ink);
}

.title {
  font-size: 1.25rem;
}

.date {
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
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
  font-weight: 700;
  text-decoration: none;
  background: var(--fs-surface);
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
