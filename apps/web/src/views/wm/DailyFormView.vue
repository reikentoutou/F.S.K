<script lang="ts">
export type KitchenReportMode = 'create' | null;

export function kitchenReportMode(routeName: unknown): KitchenReportMode {
  if (routeName === 'kitchen-report') return 'create';
  return null;
}

export const kitchenHomePath = '/kitchen';
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();

const businessDate = computed(() => String(route.params.date ?? ''));
const shiftId = computed(() => String(route.params.shiftId ?? ''));

async function returnToKitchen(): Promise<void> {
  await router.replace(kitchenHomePath);
}
</script>

<template>
  <main class="page">
    <section class="panel" aria-labelledby="migration-heading">
      <p class="eyebrow">財務日報</p>
      <h1 id="migration-heading" class="title">帳務入力を移行中です</h1>
      <p class="notice">
        この入力画面は次の移行ステップで Amplify Data に接続されます。
      </p>
      <dl class="route-context">
        <div class="context-row">
          <dt>業務日</dt>
          <dd>{{ businessDate || '—' }}</dd>
        </div>
        <div class="context-row">
          <dt>シフト</dt>
          <dd>{{ shiftId || '—' }}</dd>
        </div>
      </dl>
      <p class="detail">
        現在は送信や履歴確認を行いません。厨房トップへ戻ってください。
      </p>
      <el-button type="primary" @click="returnToKitchen">
        厨房トップへ戻る
      </el-button>
    </section>
  </main>
</template>

<style scoped>
.page {
  min-height: var(--fs-vh-100);
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: var(--fs-page);
}

.panel {
  width: min(520px, 100%);
  padding: 24px;
  border: 1px solid var(--fs-border);
  border-radius: var(--fs-radius-md);
  background: var(--fs-surface-elevated);
  box-shadow: var(--fs-shadow-soft);
}

.eyebrow {
  margin: 0 0 6px;
  font-size: 0.72rem;
  letter-spacing: 0.24em;
  color: var(--fs-muted);
}

.title {
  margin: 0 0 12px;
  font-size: 1.35rem;
  color: var(--fs-ink);
}

.notice,
.detail {
  line-height: 1.6;
  color: var(--fs-muted);
}

.route-context {
  margin: 20px 0;
  padding: 12px 16px;
  border-radius: var(--fs-radius-sm);
  background: var(--fs-surface);
}

.context-row {
  display: grid;
  grid-template-columns: 5em 1fr;
  gap: 12px;
}

.context-row + .context-row {
  margin-top: 8px;
}

.context-row dt {
  color: var(--fs-muted);
}

.context-row dd {
  margin: 0;
  color: var(--fs-ink);
  overflow-wrap: anywhere;
}
</style>
