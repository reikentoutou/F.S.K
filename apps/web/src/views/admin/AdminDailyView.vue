<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '@/api/http';
import { ElMessage } from 'element-plus';
import { todayTokyo, isoMonthsAgoTokyo } from '@/utils/tokyo';
import { httpErrorMessage } from '@/utils/http-error-message';
import { staffMealTotalYen } from '@/utils/daily-report-calc';

type Row = {
  id: string;
  reportDate: string;
  shiftId: string;
  shiftNameSnapshot: string;
  totalSalesYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  createdBy: { username: string };
};

const router = useRouter();
const loading = ref(true);
const rows = ref<Row[]>([]);
const expanded = ref<string[]>([]);

const byDate = computed(() => {
  const m = new Map<string, Row[]>();
  for (const r of rows.value) {
    const k = r.reportDate;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
});

const totalReports = computed(() => rows.value.length);
const totalDays = computed(() => byDate.value.length);

const totalSalesAll = computed(() =>
  rows.value.reduce((s, r) => s + r.totalSalesYen, 0),
);
const totalStaffMealAll = computed(() =>
  rows.value.reduce(
    (sum, row) =>
      sum + staffMealTotalYen(row.staffMealCashYen, row.staffMealAlipayYen),
    0,
  ),
);

function daySalesYen(list: Row[]): number {
  return list.reduce((s, r) => s + r.totalSalesYen, 0);
}

function rowStaffMealTotalYen(row: Row): number {
  return staffMealTotalYen(row.staffMealCashYen, row.staffMealAlipayYen);
}

function formatYen(n: number): string {
  return `${n.toLocaleString('ja-JP')} 円`;
}

async function load() {
  loading.value = true;
  try {
    const { data } = await http.get<Row[]>('/daily-reports', {
      params: {
        from: isoMonthsAgoTokyo(24),
        to: todayTokyo(),
        limit: 3000,
      },
    });
    rows.value = data;
  } catch (e: unknown) {
    ElMessage.error(
      httpErrorMessage(e, '日報一覧の読み込みに失敗しました'),
    );
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const dlg = ref(false);
const newForm = ref({
  reportDate: '',
  shiftId: '',
  createdByUserId: '',
});
const shifts = ref<{ id: string; name: string }[]>([]);
const webmasters = ref<{ id: string; username: string }[]>([]);

async function openNew() {
  const [{ data: s }, { data: w }] = await Promise.all([
    http.get('/meta/shifts'),
    http.get('/meta/webmaster-users'),
  ]);
  shifts.value = s;
  webmasters.value = w;
  newForm.value = {
    reportDate: '',
    shiftId: s[0]?.id || '',
    createdByUserId: w[0]?.id || '',
  };
  dlg.value = true;
}

function confirmNew() {
  if (!newForm.value.reportDate || !newForm.value.shiftId || !newForm.value.createdByUserId) {
    ElMessage.error('日付・シフト・網管を指定してください');
    return;
  }
  dlg.value = false;
  router.push({
    path: '/admin/report/new',
    query: {
      reportDate: newForm.value.reportDate,
      shiftId: newForm.value.shiftId,
      createdByUserId: newForm.value.createdByUserId,
    },
  });
}

function edit(id: string) {
  router.push(`/admin/report/${id}`);
}
</script>

<template>
  <div v-loading="loading" class="page">
    <section class="panel fs-anim-fade-lift" aria-labelledby="admin-daily-heading">
      <header class="panel-head">
        <div class="panel-intro">
          <h2 id="admin-daily-heading" class="panel-title">全日報</h2>
          <p class="panel-meta">
            <span class="meta-strong">{{ totalDays }}</span> 業務日 ·
            <span class="meta-strong">{{ totalReports }}</span> 件
            <template v-if="totalReports > 0">
              <span class="meta-dot" aria-hidden="true">·</span>
              表示期間の実際売上計 <span class="meta-strong">{{ formatYen(totalSalesAll) }}</span>
              <span class="meta-dot" aria-hidden="true">·</span>
              网管餐費計 <span class="meta-strong">{{ formatYen(totalStaffMealAll) }}</span>
            </template>
          </p>
          <p class="panel-hint">業務日を開くとシフト別の一覧が表示されます。</p>
        </div>
        <el-button type="primary" class="head-action" @click="openNew">空シフトを補録</el-button>
      </header>

      <div class="panel-body">
        <el-empty v-if="!loading && totalReports === 0" :image-size="80">
          <template #description>
            <div class="empty-desc">
              <p class="empty-title">この期間にはまだ日報がありません</p>
              <p class="empty-hint">網管が提出すると、ここに日付ごとに並びます。</p>
            </div>
          </template>
        </el-empty>
        <el-collapse v-else v-model="expanded" class="list-collapse">
          <el-collapse-item v-for="[date, list] in byDate" :key="date" :name="date">
            <template #title>
              <div class="day-title">
                <span class="day-date">{{ date }}</span>
                <el-tag size="small" effect="plain" type="info">{{ list.length }} 件</el-tag>
                <span class="day-sum">{{ formatYen(daySalesYen(list)) }}</span>
              </div>
            </template>
            <el-table :data="list" size="small" stripe border class="day-table">
              <el-table-column prop="shiftNameSnapshot" label="シフト" width="108" />
              <el-table-column label="実際売上" min-width="120">
                <template #default="{ row }">
                  {{ formatYen(row.totalSalesYen) }}
                </template>
              </el-table-column>
              <el-table-column label="网管餐費（現金）" min-width="138">
                <template #default="{ row }">
                  {{ formatYen(row.staffMealCashYen) }}
                </template>
              </el-table-column>
              <el-table-column label="网管餐費（支付宝）" min-width="148">
                <template #default="{ row }">
                  {{ formatYen(row.staffMealAlipayYen) }}
                </template>
              </el-table-column>
              <el-table-column label="网管餐費合計" min-width="128">
                <template #default="{ row }">
                  {{ formatYen(rowStaffMealTotalYen(row)) }}
                </template>
              </el-table-column>
              <el-table-column prop="createdBy.username" label="提出者" min-width="100" />
              <el-table-column label="" width="100" align="right" fixed="right">
                <template #default="{ row }">
                  <el-button type="primary" link @click.stop="edit(row.id)">編集</el-button>
                </template>
              </el-table-column>
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </div>
    </section>

    <el-dialog v-model="dlg" title="補録（新規行）" width="480px" destroy-on-close>
      <el-form label-position="top" require-asterisk-position="right">
        <el-form-item label="業務日" required>
          <el-date-picker
            v-model="newForm.reportDate"
            value-format="YYYY-MM-DD"
            type="date"
            class="dlg-field"
          />
        </el-form-item>
        <el-form-item label="シフト" required>
          <el-select v-model="newForm.shiftId" class="dlg-field">
            <el-option v-for="s in shifts" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="提出元（網管）" required>
          <el-select v-model="newForm.createdByUserId" class="dlg-field">
            <el-option v-for="w in webmasters" :key="w.id" :label="w.username" :value="w.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">キャンセル</el-button>
        <el-button type="primary" @click="confirmNew">フォームへ</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
}

.panel {
  display: flex;
  flex-direction: column;
  padding: 18px 20px 16px;
  border: 1px solid var(--fs-border);
  border-radius: var(--fs-radius-md);
  background: var(--fs-surface-elevated);
  box-shadow: var(--fs-shadow-soft);
}

.panel-head {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px 20px;
  padding-bottom: 14px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--fs-border);
}

.panel-intro {
  min-width: 0;
}

.panel-title {
  margin: 0 0 6px;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--fs-ink);
}

.panel-meta {
  margin: 0 0 6px;
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

.panel-hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--fs-faint);
  line-height: 1.4;
  max-width: 56ch;
}

.head-action {
  flex-shrink: 0;
  font-weight: 600;
}

.panel-body {
  padding-top: 10px;
}

.list-collapse {
  border: none;
  --el-collapse-header-height: 48px;
}

.list-collapse :deep(.el-collapse-item) {
  margin-bottom: 8px;
  border: 1px solid var(--fs-border);
  border-radius: var(--fs-radius-sm);
  overflow: hidden;
  background: var(--fs-surface);
}

.list-collapse :deep(.el-collapse-item__header) {
  padding: 0 14px;
  font-size: 0.95rem;
  font-weight: 600;
  background: var(--fs-surface);
  border: none;
}

.list-collapse :deep(.el-collapse-item__wrap) {
  border: none;
  background: var(--fs-surface-elevated);
}

.list-collapse :deep(.el-collapse-item__content) {
  padding: 0 0 10px;
}

.list-collapse :deep(.el-collapse-item__arrow) {
  margin: 0 0 0 10px;
}

.day-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  width: 100%;
  padding-right: 4px;
}

.day-date {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--fs-ink);
  letter-spacing: 0.02em;
}

.day-sum {
  margin-left: auto;
  font-size: 0.88rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--fs-muted);
}

.day-table {
  margin: 0 12px;
  border-radius: var(--fs-radius-sm);
  overflow: hidden;
}

.day-table :deep(.el-table__header th) {
  font-weight: 700;
  font-size: 12px;
}

.dlg-field {
  width: 100%;
  max-width: 100%;
}

.empty-desc {
  text-align: center;
  max-width: 32ch;
  margin: 0 auto;
}

.empty-title {
  margin: 0 0 6px;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--fs-ink);
}

.empty-hint {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--fs-muted);
}
</style>
