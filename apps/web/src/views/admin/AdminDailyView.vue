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
import { ArrowDown, ArrowRight, EditPen } from '@element-plus/icons-vue';
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
      return '権限がありません。ユーザーアカウントで再ログインしてください';
    case 'DATA_NOT_FOUND':
      return '指定したデータが見つかりません。更新または削除された可能性があります';
    case 'REPORT_ALREADY_EXISTS':
    case 'DATA_CONFLICT':
      return 'データが競合しました。画面を更新してもう一度お試しください';
    case 'DATA_PAGINATION_FAILED':
      return 'データの読み込みに失敗しました。もう一度お試しください';
    case 'DATA_NETWORK_ERROR':
    case 'SUBMISSION_RESULT_UNKNOWN':
      return 'ネットワークエラーが発生しました。接続を確認してもう一度お試しください';
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
  return audit.legacySubmittedByUsername || audit.owner || 'ユーザーによる追加';
}

function toggleDate(date: string): void {
  expanded.value = expanded.value.includes(date)
    ? expanded.value.filter((item) => item !== date)
    : [...expanded.value, date];
}

function isExpanded(date: string): boolean {
  return expanded.value.includes(date);
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
    expanded.value = [];
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
            <span class="meta-strong">{{ totalDays }}</span> 営業日 ·
            <span class="meta-strong">{{ totalReports }}</span> 件
            <template v-if="totalReports > 0">
              · 実際売上合計 <span class="meta-strong">{{ formatYen(totalSalesAll) }}</span>
              · スタッフ食事代合計 <span class="meta-strong">{{ formatYen(totalStaffMealAll) }}</span>
            </template>
          </p>
          <p class="panel-hint">初期表示は最近90日です。最大366日まで読み込めます。</p>
        </div>
        <el-button type="primary" class="head-action" @click="openNew">
          <el-icon><EditPen /></el-icon>
          日報を追加
        </el-button>
      </header>

      <div class="summary-grid" aria-label="全日報サマリー">
        <h2 class="summary-title">全日報サマリー</h2>
        <div class="summary-item">
          <span>営業日</span>
          <strong>{{ totalDays }}</strong>
        </div>
        <div class="summary-item">
          <span>日報数</span>
          <strong>{{ totalReports }}</strong>
        </div>
        <div class="summary-item summary-item-wide">
          <span>実際売上合計</span>
          <strong>{{ formatYen(totalSalesAll) }}</strong>
        </div>
        <div class="summary-item summary-item-wide">
          <span>スタッフ食事代合計</span>
          <strong>{{ formatYen(totalStaffMealAll) }}</strong>
        </div>
      </div>

      <div class="filters">
        <span class="filter-label">期間</span>
        <div class="filter-controls">
          <el-date-picker
            v-model="fromDate"
            value-format="YYYY-MM-DD"
            type="date"
            aria-label="開始営業日"
          />
          <span class="range-separator">—</span>
          <el-date-picker
            v-model="toDate"
            value-format="YYYY-MM-DD"
            type="date"
            aria-label="終了営業日"
          />
        </div>
        <el-button :loading="loading" @click="load">読み込む</el-button>
      </div>

      <div class="panel-body">
        <div class="list-heading">
          <h3>日報一覧</h3>
          <span>新しい順 <el-icon><ArrowDown /></el-icon></span>
        </div>
        <el-empty v-if="!loading && totalReports === 0" :image-size="80">
          <template #description>
            <p>この期間にはまだ日報がありません</p>
          </template>
        </el-empty>
        <template v-else>
          <el-collapse v-model="expanded" class="list-collapse desktop-report-list">
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
                <el-table-column label="スタッフ食事代（現金）" min-width="168">
                  <template #default="{ row }">{{ formatYen(row.staffMealCashYen) }}</template>
                </el-table-column>
                <el-table-column label="スタッフ食事代（アリペイ）" min-width="188">
                  <template #default="{ row }">{{ formatYen(row.staffMealAlipayYen) }}</template>
                </el-table-column>
                <el-table-column label="スタッフ食事代合計" min-width="158">
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
          <div class="mobile-report-list">
            <section v-for="[date, list] in byDate" :key="date" class="mobile-day-group">
            <button
              type="button"
              class="mobile-day-button"
              :aria-expanded="isExpanded(date)"
              :aria-controls="`mobile-day-${date}`"
              @click="toggleDate(date)"
            >
              <span class="mobile-day-main">
                <strong>{{ date }}</strong>
                <span>{{ list.length }} 件の日報</span>
              </span>
              <span class="mobile-day-total">{{ formatYen(daySalesYen(list)) }}</span>
              <el-icon :class="{ expanded: isExpanded(date) }"><ArrowRight /></el-icon>
            </button>
            <div
              v-show="isExpanded(date)"
              :id="`mobile-day-${date}`"
              class="mobile-day-details"
            >
              <article v-for="report in list" :key="report.reportKey" class="mobile-report-card">
                <div class="mobile-report-head">
                  <strong>{{ report.shiftNameSnapshot }}</strong>
                  <span>{{ submittedBy(report) }}</span>
                </div>
                <dl class="mobile-report-metrics">
                  <div>
                    <dt>実際売上</dt>
                    <dd>{{ formatYen(reportTotalSales(report)) }}</dd>
                  </div>
                  <div>
                    <dt>スタッフ食事代</dt>
                    <dd>{{ formatYen(rowStaffMealTotalYen(report)) }}</dd>
                  </div>
                </dl>
                <el-button
                  type="primary"
                  plain
                  class="mobile-edit-button"
                  @click.stop="edit(report.reportKey)"
                >
                  編集
                </el-button>
              </article>
            </div>
            </section>
          </div>
        </template>
      </div>
    </section>

    <el-dialog v-model="dialogOpen" title="日報を追加" width="480px" destroy-on-close>
      <p class="dialog-note">現在ログイン中のユーザーを作成者として保存します。</p>
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
.filter-label { display: none; }
.filter-controls { display: flex; align-items: center; gap: 8px; }
.panel-body { padding-top: 10px; }
.summary-grid, .mobile-report-list, .list-heading { display: none; }
.list-collapse { border: none; }
.day-title { display: flex; align-items: center; gap: 12px; width: 100%; padding-right: 8px; }
.day-date { font-weight: 700; font-variant-numeric: tabular-nums; }
.day-sum { margin-left: auto; font-weight: 700; color: var(--fs-muted); }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.day-table { min-width: 980px; }
.dialog-field { width: 100%; }

@media (max-width: 720px) {
  .panel { display: flex; flex-direction: column; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  .panel-head { display: contents; }
  .panel-intro { display: none; }
  .head-action { order: 2; width: 100%; min-height: 46px; margin: 12px 0; font-weight: 700; }
  .head-action .el-icon { font-size: 18px; }
  .summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 12px; overflow: hidden; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
  .summary-grid { order: 1; }
  .summary-title { grid-column: 1 / -1; margin: 0; padding: 16px 16px 10px; font-size: 1.05rem; }
  .summary-item { display: flex; min-width: 0; min-height: 82px; flex-direction: column-reverse; justify-content: center; gap: 5px; padding: 12px 14px; border-right: 1px solid var(--fs-border); border-bottom: 1px solid var(--fs-border); }
  .summary-item:nth-child(3), .summary-item:nth-child(5) { border-right: 0; }
  .summary-item:nth-last-child(-n + 2) { border-bottom: 0; }
  .summary-item span { color: var(--fs-muted); font-size: 0.74rem; line-height: 1.25; }
  .summary-item strong { overflow: hidden; color: var(--fs-accent); font-size: 1.22rem; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
  .filters { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 12px 14px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
  .filters { order: 3; }
  .filter-label { display: block; grid-column: 1 / -1; color: var(--fs-muted); font-size: 0.75rem; font-weight: 600; }
  .filter-controls { min-width: 0; }
  .filter-controls :deep(.el-date-editor) { width: 100%; min-width: 0; }
  .filter-controls :deep(.el-input__wrapper) { padding-right: 6px; padding-left: 8px; }
  .filter-controls :deep(.el-input__prefix) { display: none; }
  .range-separator { flex: 0 0 auto; color: var(--fs-muted); }
  .filters > .el-button { min-height: 40px; }
  .panel-body { order: 4; padding-top: 12px; }
  .list-heading { display: flex; align-items: center; justify-content: space-between; padding: 2px 2px 9px; }
  .list-heading h3 { margin: 0; font-size: 1rem; }
  .list-heading span { display: inline-flex; align-items: center; gap: 3px; color: var(--fs-muted); font-size: 0.76rem; }
  .desktop-report-list { display: none; }
  .mobile-report-list { display: block; overflow: hidden; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
  .mobile-day-group + .mobile-day-group { border-top: 1px solid var(--fs-border); }
  .mobile-day-button { display: grid; width: 100%; min-height: 66px; grid-template-columns: minmax(0, 1fr) auto 20px; align-items: center; gap: 10px; padding: 10px 12px 10px 14px; color: var(--fs-ink); text-align: left; background: transparent; border: 0; cursor: pointer; }
  .mobile-day-main { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
  .mobile-day-main strong { font-size: 0.92rem; font-variant-numeric: tabular-nums; }
  .mobile-day-main span { color: var(--fs-muted); font-size: 0.72rem; }
  .mobile-day-total { font-size: 0.84rem; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mobile-day-button .el-icon { color: var(--fs-muted); transition: transform 0.2s ease; }
  .mobile-day-button .el-icon.expanded { transform: rotate(90deg); }
  .mobile-day-details { padding: 0 10px 10px; background: var(--fs-surface); }
  .mobile-report-card { padding: 13px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-sm); background: var(--fs-surface-elevated); }
  .mobile-report-card + .mobile-report-card { margin-top: 8px; }
  .mobile-report-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .mobile-report-head span { overflow: hidden; color: var(--fs-muted); font-size: 0.72rem; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-report-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 12px 0; }
  .mobile-report-metrics div { min-width: 0; }
  .mobile-report-metrics dt { color: var(--fs-muted); font-size: 0.7rem; }
  .mobile-report-metrics dd { margin: 3px 0 0; overflow: hidden; font-size: 0.88rem; font-weight: 700; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-edit-button { width: 100%; min-height: 42px; }
  :deep(.el-dialog) { width: calc(100% - 28px) !important; max-width: 480px; margin-top: max(8vh, calc(var(--fs-safe-area-top) + 16px)); }
  :deep(.el-dialog__footer) { display: flex; }
  :deep(.el-dialog__footer .el-button) { flex: 1; min-height: 42px; }
}

@media (max-width: 390px) {
  .filters { grid-template-columns: 1fr; }
  .filters > .el-button { width: 100%; }
}
</style>
