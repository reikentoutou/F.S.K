<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '@/api/http';
import { useAuthStore } from '@/stores/auth';
import { todayTokyo } from '@/utils/tokyo';

const auth = useAuthStore();
const router = useRouter();

const shifts = ref<{ id: string; name: string; sortOrder: number }[]>([]);
const reportDate = ref(todayTokyo());
const reports = ref<
  {
    id: string;
    shiftId: string;
    totalSalesYen: number;
    timeRangeLabelSnapshot: string;
  }[]
>([]);

const byShift = computed(() => {
  const m = new Map<string, (typeof reports.value)[0]>();
  for (const r of reports.value) m.set(r.shiftId, r);
  return m;
});

const shiftsSorted = computed(() =>
  [...shifts.value].sort((a, b) => a.sortOrder - b.sortOrder),
);

const filledCount = computed(
  () => shiftsSorted.value.filter((sh) => byShift.value.has(sh.id)).length,
);

const totalSalesDay = computed(() =>
  reports.value.reduce((s, r) => s + r.totalSalesYen, 0),
);

function shiftRow(shiftId: string) {
  return byShift.value.get(shiftId);
}

function isFilled(shiftId: string): boolean {
  return byShift.value.has(shiftId);
}

async function load() {
  const [{ data: s }, { data: list }] = await Promise.all([
    http.get('/meta/shifts'),
    http.get('/daily-reports', { params: { reportDate: reportDate.value } }),
  ]);
  shifts.value = s;
  reports.value = list;
}

function goShift(shiftId: string) {
  const ex = byShift.value.get(shiftId);
  if (ex) return;
  router.push(`/wm/report/${reportDate.value}/${shiftId}`);
}

onMounted(load);
watch(reportDate, load);

function logout() {
  auth.logout();
  router.replace('/login');
}

function formatYen(n: number): string {
  return `${n.toLocaleString('ja-JP')} 円`;
}
</script>

<template>
  <div class="page">
    <header class="bar">
      <div class="bar-titles">
        <p class="eyebrow">財務日報</p>
        <h1 class="title">日報（網管）</h1>
      </div>
      <div class="right">
        <span class="user">{{ auth.user?.username }}</span>
        <el-button link type="primary" class="logout" @click="logout">ログアウト</el-button>
      </div>
    </header>

    <main class="main">
      <section class="panel" aria-labelledby="wm-shift-heading">
        <div class="panel-head">
          <div class="panel-intro">
            <h2 id="wm-shift-heading" class="panel-title">シフト別入力</h2>
            <p class="panel-meta">
              <span class="meta-strong">{{ filledCount }} / {{ shiftsSorted.length }}</span>
              シフト提出済み
              <span v-if="filledCount > 0" class="meta-dot" aria-hidden="true">·</span>
              <span v-if="filledCount > 0" class="meta-sales">
                計 <span class="meta-strong">{{ formatYen(totalSalesDay) }}</span>
              </span>
            </p>
          </div>
          <div class="panel-date">
            <span class="date-label" id="wm-date-label">業務日（東京）</span>
            <el-date-picker
              v-model="reportDate"
              value-format="YYYY-MM-DD"
              type="date"
              aria-labelledby="wm-date-label"
            />
          </div>
        </div>

        <p class="panel-hint">
          未入力のカードを押すと、そのシフトの日報入力へ移動します。提出済みの日報は網管側では編集できません。
        </p>

        <ul class="shift-grid fs-stagger-children">
          <li v-for="sh in shiftsSorted" :key="sh.id" class="shift-li">
            <button
              type="button"
              class="shift-card"
              :class="{ 'is-filled': isFilled(sh.id) }"
              :disabled="isFilled(sh.id)"
              @click="goShift(sh.id)"
            >
              <div class="shift-card-top">
                <span class="shift-name">{{ sh.name }}</span>
                <el-tag :type="isFilled(sh.id) ? 'success' : 'info'" size="small" effect="plain">
                  {{ isFilled(sh.id) ? '提出済' : '未入力' }}
                </el-tag>
              </div>
              <div v-if="shiftRow(sh.id)" class="shift-body">
                <p class="sales-line">実際売上</p>
                <p class="sales-num">{{ formatYen(shiftRow(sh.id)!.totalSalesYen) }}</p>
                <p v-if="shiftRow(sh.id)!.timeRangeLabelSnapshot" class="time-line">
                  {{ shiftRow(sh.id)!.timeRangeLabelSnapshot }}
                </p>
              </div>
              <div v-else class="shift-body shift-body-empty">
                <p class="empty-line">タップして入力</p>
              </div>
            </button>
          </li>
        </ul>
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
  box-shadow: 0 1px 0 rgba(28, 26, 22, 0.04);
}

.bar-titles {
  min-width: 0;
}

.eyebrow {
  margin: 0 0 2px;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--fs-muted);
}

.title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--fs-ink);
  line-height: 1.3;
}

.main {
  flex: 1;
  width: 100%;
  max-width: 1120px;
  margin: 0 auto;
  padding: 18px 22px 28px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: min(560px, calc(var(--fs-vh-100) - 96px));
  padding: 20px 22px 22px;
  border: 1px solid var(--fs-border);
  border-radius: var(--fs-radius-md);
  background: var(--fs-surface-elevated);
  box-shadow: var(--fs-shadow-soft);
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px 24px;
  padding-bottom: 14px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--fs-border);
}

.panel-intro {
  min-width: 0;
}

.panel-title {
  margin: 0 0 6px;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--fs-ink);
  letter-spacing: 0.02em;
}

.panel-meta {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.45;
  color: var(--fs-muted);
}

.meta-strong {
  font-weight: 700;
  color: var(--fs-ink);
  font-variant-numeric: tabular-nums;
}

.meta-dot {
  margin: 0 0.35em;
  color: var(--fs-faint);
}

.meta-sales {
  font-variant-numeric: tabular-nums;
}

.panel-date {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
}

.date-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--fs-muted);
}

.panel-hint {
  margin: 0 0 16px;
  font-size: 0.8rem;
  color: var(--fs-faint);
  line-height: 1.4;
}

.shift-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  flex: 1;
  align-content: start;
}

.shift-li {
  margin: 0;
  min-height: 0;
}

.shift-card {
  width: 100%;
  height: 100%;
  min-height: 158px;
  margin: 0;
  padding: 14px 16px 14px;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  border-radius: var(--fs-radius-sm);
  border: 1px solid var(--fs-border);
  background: var(--fs-surface);
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease;
}

@media (hover: hover) {
  .shift-card:not(:disabled):hover {
    border-color: var(--fs-border-strong);
    box-shadow: var(--fs-shadow-soft);
    transform: translateY(-1px);
  }
}

.shift-card:not(:disabled):active {
  transform: translateY(1px);
}

.shift-card:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.shift-card.is-filled {
  cursor: default;
  color: inherit;
  opacity: 1;
  border-color: color-mix(in srgb, var(--el-color-success) 35%, var(--fs-border));
  background: color-mix(in srgb, var(--el-color-success) 6%, var(--fs-surface));
}

.shift-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.shift-name {
  font-size: 1rem;
  font-weight: 700;
  color: var(--fs-ink);
  line-height: 1.3;
}

.shift-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shift-body-empty {
  flex: 1;
  justify-content: center;
  min-height: 72px;
}

.sales-line {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--fs-muted);
}

.sales-num {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--fs-success-ink);
  line-height: 1.2;
}

.time-line {
  margin: 6px 0 0;
  font-size: 0.8rem;
  color: var(--fs-muted);
  line-height: 1.4;
}

.empty-line {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 500;
  color: var(--fs-faint);
}

.right {
  display: flex;
  align-items: center;
  gap: 14px;
}

.user {
  font-weight: 600;
  color: var(--fs-ink);
}

.logout {
  font-weight: 500;
}

@supports not (background: color-mix(in srgb, red 50%, blue)) {
  .shift-card.is-filled {
    border-color: var(--fs-border-strong);
    background: var(--fs-surface-elevated);
  }
}
</style>
