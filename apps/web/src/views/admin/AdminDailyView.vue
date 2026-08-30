<script lang="ts">
import { recentTokyoBusinessDateRange as recentRange } from '@/data/date-range';

export async function loadOwnerDailyReports<T>(options: {
  now?: Date;
  dates?: string[];
  isCurrent?: () => boolean;
  listByBusinessDate(date: string): Promise<Array<T | null>>;
  getSetting(id: string): Promise<{ registerFloatAmount: number }>;
}): Promise<{ rows: T[]; registerFloatAmount: number }> {
  const dates = options.dates ?? recentRange(90, options.now);
  const setting = await options.getSetting('default');
  const dailyResults: Array<Array<T | null>> = [];
  for (let offset = 0; offset < dates.length; offset += 10) {
    if (options.isCurrent && !options.isCurrent()) break;
    dailyResults.push(
      ...(await Promise.all(
        dates
          .slice(offset, offset + 10)
          .map((businessDate) => options.listByBusinessDate(businessDate)),
      )),
    );
  }
  return {
    rows: dailyResults
      .flat()
      .filter((report): report is T => report != null),
    registerFloatAmount: setting.registerFloatAmount,
  };
}
</script>

<script setup lang="ts">
import { computeDailyReportTotals, staffMealTotalYen } from '@fsk/domain';
import { ElMessage } from 'element-plus';
import { computed, onBeforeUnmount, shallowRef } from 'vue';
import { useRouter } from 'vue-router';

import { businessDateRange, recentTokyoBusinessDateRange } from '@/data/date-range';
import { dailyReportsRepository } from '@/data/daily-reports';
import { DataRepositoryError } from '@/data/errors';
import { ownerMasterDataRepository } from '@/data/master-data';
import { todayTokyo } from '@/utils/tokyo';

type ListedReport = NonNullable<
  Awaited<ReturnType<typeof dailyReportsRepository.listByBusinessDate>>[number]
>;

function ownerDataErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof DataRepositoryError)) return fallback;
  switch (error.code) {
    case 'DATA_UNAUTHORIZED':
      return '权限不足，请重新以老板账号登录';
    case 'DATA_NOT_FOUND':
      return '未找到指定数据，可能已被修改';
    case 'REPORT_ALREADY_EXISTS':
    case 'DATA_CONFLICT':
      return '数据发生冲突，请刷新后重试';
    case 'DATA_PAGINATION_FAILED':
      return '分页读取失败，请重试';
    case 'DATA_NETWORK_ERROR':
    case 'SUBMISSION_RESULT_UNKNOWN':
      return '网络异常，请确认连接后重试';
    default:
      return fallback;
  }
}

const router = useRouter();
const defaultDates = recentTokyoBusinessDateRange(90);
const fromDate = shallowRef(defaultDates[0]!);
const toDate = shallowRef(defaultDates.at(-1)!);
const loading = shallowRef(false);
const rows = shallowRef<ListedReport[]>([]);
const expanded = shallowRef<string[]>([]);
const registerFloatAmount = shallowRef(0);
let loadGeneration = 0;
let isUnmounted = false;

const byDate = computed(() => {
  const grouped = new Map<string, ListedReport[]>();
  for (const report of rows.value) {
    const list = grouped.get(report.businessDate) ?? [];
    list.push(report);
    grouped.set(report.businessDate, list);
  }
  return [...grouped.entries()].sort(([left], [right]) =>
    left < right ? 1 : -1,
  );
});

const totalReports = computed(() => rows.value.length);
const totalDays = computed(() => byDate.value.length);
const totalSalesAll = computed(() =>
  rows.value.reduce((sum, report) => sum + reportTotalSales(report), 0),
);
const totalStaffMealAll = computed(() =>
  rows.value.reduce(
    (sum, report) =>
      sum +
      staffMealTotalYen(
        report.staffMealCashYen,
        report.staffMealAlipayYen,
      ),
    0,
  ),
);

function reportTotalSales(report: ListedReport): number {
  return computeDailyReportTotals(report, registerFloatAmount.value)
    .totalSalesYen;
}

function daySalesYen(reports: ListedReport[]): number {
  return reports.reduce((sum, report) => sum + reportTotalSales(report), 0);
}

function rowStaffMealTotalYen(report: ListedReport): number {
  return staffMealTotalYen(
    report.staffMealCashYen,
    report.staffMealAlipayYen,
  );
}

function submittedBy(report: ListedReport): string {
  const audit = report as ListedReport & {
    owner?: string | null;
    legacySubmittedByUsername?: string | null;
  };
  return audit.legacySubmittedByUsername || audit.owner || '老板补录';
}

function formatYen(value: number): string {
  return `${value.toLocaleString('ja-JP')} 円`;
}

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  const isCurrent = (): boolean =>
    !isUnmounted && generation === loadGeneration;
  loading.value = true;
  try {
    const dates = businessDateRange(fromDate.value, toDate.value);
    const loaded = await loadOwnerDailyReports({
      dates,
      isCurrent,
      listByBusinessDate: (businessDate) =>
        dailyReportsRepository.listByBusinessDate(businessDate),
      getSetting: (id) => ownerMasterDataRepository.getSetting(id),
    });
    if (!isCurrent()) return;
    registerFloatAmount.value = loaded.registerFloatAmount;
    rows.value = loaded.rows;
  } catch (error: unknown) {
    if (!isCurrent()) return;
    rows.value = [];
    ElMessage.error(ownerDataErrorMessage(error, '日報一覧の読み込みに失敗しました'));
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

onBeforeUnmount(() => {
  isUnmounted = true;
  loadGeneration += 1;
});

const dialogOpen = shallowRef(false);
const newForm = shallowRef({
  businessDate: todayTokyo(),
  shiftId: '',
});
const shifts = shallowRef<Array<{ id: string; name: string }>>([]);

async function openNew(): Promise<void> {
  try {
    const loaded = await ownerMasterDataRepository.listShifts();
    shifts.value = loaded
      .filter(
        (shift): shift is NonNullable<typeof shift> =>
          shift != null && shift.active,
      )
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((shift) => ({ id: shift.id, name: shift.name }));
    newForm.value = {
      businessDate: todayTokyo(),
      shiftId: shifts.value[0]?.id ?? '',
    };
    dialogOpen.value = true;
  } catch (error: unknown) {
    ElMessage.error(ownerDataErrorMessage(error, 'シフトの読み込みに失敗しました'));
  }
}

async function confirmNew(): Promise<void> {
  if (!newForm.value.businessDate || !newForm.value.shiftId) {
    ElMessage.error('日付・シフトを指定してください');
    return;
  }
  dialogOpen.value = false;
  await router.push({
    name: 'owner-report-new',
    query: {
      businessDate: newForm.value.businessDate,
      shiftId: newForm.value.shiftId,
    },
  });
}

async function edit(reportKey: string): Promise<void> {
  await router.push({ name: 'owner-report-edit', params: { reportKey } });
}

void load();
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
              · 実際売上計 <span class="meta-strong">{{ formatYen(totalSalesAll) }}</span>
              · 网管餐費計 <span class="meta-strong">{{ formatYen(totalStaffMealAll) }}</span>
            </template>
          </p>
          <p class="panel-hint">初期表示は最近90日です。最大366日まで読み込めます。</p>
        </div>
        <el-button type="primary" class="head-action" @click="openNew">
          老板補録
        </el-button>
      </header>

      <div class="filters">
        <el-date-picker
          v-model="fromDate"
          value-format="YYYY-MM-DD"
          type="date"
          aria-label="開始業務日"
        />
        <span>—</span>
        <el-date-picker
          v-model="toDate"
          value-format="YYYY-MM-DD"
          type="date"
          aria-label="終了業務日"
        />
        <el-button :loading="loading" @click="load">読み込む</el-button>
      </div>

      <div class="panel-body">
        <el-empty v-if="!loading && totalReports === 0" :image-size="80">
          <template #description>
            <p>この期間にはまだ日報がありません</p>
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
            <div
              class="table-scroll"
              role="region"
              aria-label="横スクロール可能な日報明細"
              tabindex="0"
            >
              <el-table :data="list" size="small" stripe border class="day-table">
                <el-table-column prop="shiftNameSnapshot" label="シフト" width="108" />
                <el-table-column label="実際売上" min-width="120">
                  <template #default="{ row }">{{ formatYen(reportTotalSales(row)) }}</template>
                </el-table-column>
                <el-table-column label="网管餐費（現金）" min-width="138">
                  <template #default="{ row }">{{ formatYen(row.staffMealCashYen) }}</template>
                </el-table-column>
                <el-table-column label="网管餐費（支付宝）" min-width="148">
                  <template #default="{ row }">{{ formatYen(row.staffMealAlipayYen) }}</template>
                </el-table-column>
                <el-table-column label="网管餐費合計" min-width="128">
                  <template #default="{ row }">{{ formatYen(rowStaffMealTotalYen(row)) }}</template>
                </el-table-column>
                <el-table-column label="提出者" min-width="150">
                  <template #default="{ row }">{{ submittedBy(row) }}</template>
                </el-table-column>
                <el-table-column label="" width="100" align="right" fixed="right">
                  <template #default="{ row }">
                    <el-button type="primary" link @click.stop="edit(row.reportKey)">編集</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </section>

    <el-dialog v-model="dialogOpen" title="老板補録（新規）" width="480px" destroy-on-close>
      <p class="dialog-note">現在のCognito老板账号を作成主体として保存します。</p>
      <el-form label-position="top" require-asterisk-position="right">
        <el-form-item label="業務日" required>
          <el-date-picker
            v-model="newForm.businessDate"
            value-format="YYYY-MM-DD"
            type="date"
            class="dialog-field"
          />
        </el-form-item>
        <el-form-item label="シフト" required>
          <el-select v-model="newForm.shiftId" class="dialog-field">
            <el-option v-for="shift in shifts" :key="shift.id" :label="shift.name" :value="shift.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogOpen = false">キャンセル</el-button>
        <el-button type="primary" @click="confirmNew">フォームへ</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; }
.panel { padding: 18px 20px 16px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); box-shadow: var(--fs-shadow-soft); }
.panel-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 14px 20px; padding-bottom: 14px; border-bottom: 1px solid var(--fs-border); }
.panel-title { margin: 0 0 6px; font-size: 1.1rem; color: var(--fs-ink); }
.panel-meta, .panel-hint, .dialog-note { margin: 0 0 6px; color: var(--fs-muted); font-size: 0.86rem; }
.meta-strong { font-weight: 700; color: var(--fs-ink); font-variant-numeric: tabular-nums; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 0 6px; }
.panel-body { padding-top: 10px; }
.list-collapse { border: none; }
.day-title { display: flex; align-items: center; gap: 12px; width: 100%; padding-right: 8px; }
.day-date { font-weight: 700; font-variant-numeric: tabular-nums; }
.day-sum { margin-left: auto; font-weight: 700; color: var(--fs-muted); }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.day-table { min-width: 980px; }
.dialog-field { width: 100%; }
</style>
