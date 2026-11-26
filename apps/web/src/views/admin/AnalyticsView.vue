<script lang="ts">
import {
  buildReportAnalytics,
  tokyoPeriodRange,
  type AnalyticsPeriod,
  type AnalyticsReport,
  type ReportAnalytics,
} from '@/analytics/report-analytics';
import { businessDateRange } from '@/data/date-range';
import { DataRepositoryError } from '@/data/errors';

export interface OwnerAnalyticsLoadOptions {
  period: AnalyticsPeriod;
  anchorDate: string;
  listByBusinessDate(
    businessDate: string,
  ): Promise<Array<AnalyticsReport | null>>;
  getSetting(id: string): Promise<{ registerFloatAmount: number }>;
  listShifts(): Promise<Array<{ id: string; sortOrder: number } | null>>;
  isCurrent?: () => boolean;
}

function assertAnalyticsLoadCurrent(options: OwnerAnalyticsLoadOptions): void {
  if (options.isCurrent?.() === false) {
    throw new Error('ANALYTICS_LOAD_ABORTED');
  }
}

export interface LoadedAnalyticsSelection {
  period: AnalyticsPeriod;
  range: { start: string; end: string };
}

export function analyticsCsvFilename(
  selection: LoadedAnalyticsSelection,
): string {
  return `aggregate-${selection.period}-${selection.range.start}-${selection.range.end}.csv`;
}

export function ownerAnalyticsErrorMessage(error: unknown): string {
  if (!(error instanceof DataRepositoryError)) {
    if (error instanceof Error && error.message.startsWith('BUSINESS_DATE_')) {
      return '集計期間は最大366日まで指定できます';
    }
    return '集計データの読み込みに失敗しました';
  }
  switch (error.code) {
    case 'DATA_UNAUTHORIZED':
      return '権限がありません。ユーザーアカウントで再ログインしてください';
    case 'DATA_PAGINATION_FAILED':
      return 'データの読み込みに失敗しました。もう一度お試しください';
    case 'DATA_NETWORK_ERROR':
      return 'ネットワークエラーが発生しました。接続を確認してもう一度お試しください';
    case 'DATA_NOT_FOUND':
      return 'レジ底銭設定が見つかりません。設定画面で登録してください';
    case 'DATA_CONFLICT':
      return 'データが競合しました。画面を更新してもう一度お試しください';
    default:
      return '集計データの読み込みに失敗しました';
  }
}

export async function loadOwnerAnalytics(
  options: OwnerAnalyticsLoadOptions,
): Promise<{
  range: { start: string; end: string };
  registerFloatAmount: number;
  analytics: ReportAnalytics;
}> {
  assertAnalyticsLoadCurrent(options);
  const range = tokyoPeriodRange(options.period, options.anchorDate);
  const dates = businessDateRange(range.start, range.end);
  const setting = await options.getSetting('default');
  assertAnalyticsLoadCurrent(options);
  const shifts = await options.listShifts();
  assertAnalyticsLoadCurrent(options);
  const shiftSortOrders = new Map(
    shifts
      .filter((shift): shift is { id: string; sortOrder: number } =>
        shift !== null,
      )
      .map((shift) => [shift.id, shift.sortOrder] as const),
  );
  const reports: AnalyticsReport[] = [];

  for (let index = 0; index < dates.length; index += 10) {
    assertAnalyticsLoadCurrent(options);
    const batch = dates.slice(index, index + 10);
    const results = await Promise.all(
      batch.map((businessDate) =>
        options.listByBusinessDate(businessDate),
      ),
    );
    assertAnalyticsLoadCurrent(options);
    reports.push(
      ...results
        .flat()
        .filter((report): report is AnalyticsReport => report !== null),
    );
  }

  const registerFloatAmount = setting.registerFloatAmount;
  assertAnalyticsLoadCurrent(options);
  return {
    range,
    registerFloatAmount,
    analytics: buildReportAnalytics(
      reports,
      registerFloatAmount,
      shiftSortOrders,
    ),
  };
}
</script>

<script setup lang="ts">

import { ElMessage } from 'element-plus';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue';

import { storeLabel } from '@fsk/domain';
import { ArrowRight, Download, Refresh } from '@element-plus/icons-vue';
import ReportAmountGrid from '@/components/daily-report/ReportAmountGrid.vue';
import { actualSalesBarData } from '@/analytics/report-analytics';
import { useEchartsBarChart } from '@/composables/useEchartsBarChart';
import { createDailyReportsRepository } from '@/data/daily-reports';
import { useStoreSelection } from '@/stores/store-selection';
import { createOwnerMasterDataRepository } from '@/data/master-data';
import { buildReportCsv, downloadCsvFile } from '@/export/report-csv';
import { todayTokyo } from '@/utils/tokyo';
const storeScope = useStoreSelection().selected;
const ownerMasterDataRepository = createOwnerMasterDataRepository(undefined, storeScope);
const dailyReportsRepository = createDailyReportsRepository(undefined, { storeId: storeScope });

const period = shallowRef<AnalyticsPeriod>('week');
const anchorDate = shallowRef(todayTokyo());
const loading = shallowRef(false);
const range = shallowRef<{ start: string; end: string } | null>(null);
const analytics = shallowRef<ReportAnalytics | null>(null);
const loadedSelection = shallowRef<LoadedAnalyticsSelection | null>(null);
let loadGeneration = 0;
let disposed = false;

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration += 1;
});

const chartEl = useTemplateRef<HTMLDivElement>('chartEl');
const { setBarData } = useEchartsBarChart(chartEl);

const headline = computed(() => {
  if (!range.value) return '';
  if (range.value.start === range.value.end) {
    return formatJaDate(range.value.start);
  }
  return `${formatJaDate(range.value.start)} ～ ${formatJaDate(range.value.end)}`;
});

const dayRows = computed(() =>
  period.value === 'day' ? (analytics.value?.rows ?? []) : [],
);

function formatJaDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return year && month && day
    ? `${year}/${month}/${day}`
    : value;
}

function formatYen(value: number): string {
  return `${value.toLocaleString('ja-JP')} 円`;
}

function renderChart(value: ReportAnalytics): void {
  const chartData = actualSalesBarData(value.byShift);
  setBarData(chartData.categories, chartData.series);
}

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  const isCurrent = () => !disposed && generation === loadGeneration;
  const requestedPeriod = period.value;
  const requestedAnchorDate = anchorDate.value;
  loadedSelection.value = null;
  loading.value = true;
  try {
    const loaded = await loadOwnerAnalytics({
      period: requestedPeriod,
      anchorDate: requestedAnchorDate,
      listByBusinessDate: (businessDate) =>
        dailyReportsRepository.listByBusinessDate(
          businessDate,
        ) as Promise<Array<AnalyticsReport | null>>,
      getSetting: (id) => ownerMasterDataRepository.getSetting(id),
      listShifts: () => ownerMasterDataRepository.listShifts(),
      isCurrent,
    });
    if (!isCurrent()) return;
    range.value = loaded.range;
    analytics.value = loaded.analytics;
    loadedSelection.value = {
      period: requestedPeriod,
      range: loaded.range,
    };
    await nextTick();
    if (isCurrent()) renderChart(loaded.analytics);
  } catch (error: unknown) {
    if (!isCurrent()) return;
    range.value = null;
    analytics.value = null;
    loadedSelection.value = null;
    ElMessage.error(ownerAnalyticsErrorMessage(error));
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

function downloadCsv(): void {
  if (!analytics.value || !loadedSelection.value) return;
  downloadCsvFile(
    buildReportCsv(analytics.value.rows),
    `${storeScope}-${analyticsCsvFilename(loadedSelection.value)}`,
  );
}

watch([period, anchorDate], () => void load(), { immediate: true });
</script>

<template>
  <div v-loading="loading" class="page">
    <section class="panel" aria-labelledby="analytics-heading">
      <header class="panel-head">
        <h2 id="analytics-heading" class="panel-title">集計・エクスポート</h2>
        <el-button
          class="export-action"
          :disabled="!analytics || !loadedSelection || loading"
          @click="downloadCsv"
        >
          <el-icon><Download /></el-icon>CSVを出力
        </el-button>
      </header>

      <el-form class="filters" label-position="top">
        <el-form-item label="期間">
          <el-select v-model="period" aria-label="集計期間">
            <el-option label="単日" value="day" />
            <el-option label="週" value="week" />
            <el-option label="月" value="month" />
            <el-option label="四半期" value="quarter" />
            <el-option label="年" value="year" />
          </el-select>
        </el-form-item>
        <el-form-item :label="period === 'day' ? '業務日' : '基準日'">
          <el-date-picker
            v-model="anchorDate"
            value-format="YYYY-MM-DD"
            type="date"
            aria-label="集計基準日"
          />
        </el-form-item>
        <el-button class="refresh-action" :loading="loading" aria-label="再集計" @click="load">
          <el-icon v-if="!loading"><Refresh /></el-icon>
        </el-button>
      </el-form>

      <div v-if="analytics && range" class="panel-body">
        <section class="totals" aria-label="期間合計">
          <header class="totals-head">
            <h3 class="grand-headline">{{ headline }}</h3>
            <span>{{ analytics.totals.count }} 件</span>
          </header>
          <ReportAmountGrid :amounts="analytics.totals" />
        </section>

        <template v-if="period === 'day'">
          <h3 class="section-title">シフト別内訳</h3>
          <el-empty v-if="dayRows.length === 0" description="この業務日の日報はまだありません" />
          <div class="shift-grid">
            <details v-for="row in dayRows" :key="row.reportKey" class="shift-details">
              <summary>
                <span class="shift-heading">
                  <strong>{{ storeLabel(row.storeId) }} {{ row.shiftNameSnapshot }}</strong>
                  <span>{{ row.responsiblePersonSnapshot }} · {{ row.timeRangeLabelSnapshot }}</span>
                </span>
                <strong class="shift-total">{{ formatYen(row.totalSalesYen) }}</strong>
                <el-icon class="disclosure-icon"><ArrowRight /></el-icon>
              </summary>
              <ReportAmountGrid :amounts="row" />
              <dl class="report-extras">
                <div><dt>Newage売上</dt><dd>{{ formatYen(row.newageYen) }}</dd></div>
                <div><dt>支出理由</dt><dd>{{ row.expenseReason || '—' }}</dd></div>
              </dl>
            </details>
          </div>
        </template>

        <section class="chart-panel" aria-labelledby="chart-heading">
          <h3 id="chart-heading" class="section-title">シフト別実際売上</h3>
          <div ref="chartEl" class="chart" :style="{ height: `${Math.max(160, analytics.byShift.length * 36 + 48)}px` }" aria-label="シフト別実際売上グラフ" />
        </section>

        <h3 class="section-title">シフト別合算</h3>
        <el-empty v-if="analytics.byShift.length === 0" description="この期間の日報はまだありません" />
        <div class="shift-grid">
          <details v-for="shift in analytics.byShift" :key="shift.shiftId" class="shift-details">
            <summary>
              <span class="shift-heading">
                <strong>{{ shift.shiftName }}</strong>
                <span>{{ shift.count }} 件</span>
              </span>
              <strong class="shift-total">{{ formatYen(shift.totalSalesYen) }}</strong>
              <el-icon class="disclosure-icon"><ArrowRight /></el-icon>
            </summary>
            <ReportAmountGrid :amounts="shift" />
          </details>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page, .panel, .panel-body { min-width: 0; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.panel-title { margin: 0; font-size: 18px; }
.export-action { flex-shrink: 0; min-height: 40px; }
.export-action .el-icon { margin-right: 5px; }
.filters { display: grid; grid-template-columns: 160px 220px 44px; align-items: end; gap: 10px; margin-bottom: 12px; }
.filters :deep(.el-form-item) { min-width: 0; margin: 0; }
.filters :deep(.el-form-item__label) { margin-bottom: 4px; padding: 0; line-height: 18px; font-size: 12px; color: var(--fs-muted); }
.filters :deep(.el-date-editor) { height: 44px; }
.filters :deep(.el-date-editor), .filters :deep(.el-select) { width: 100%; min-width: 0; }
.filters :deep(.el-input__wrapper), .filters :deep(.el-select__wrapper) { min-height: 44px; }
.refresh-action { width: 44px; height: 44px; margin: 0; padding: 0; font-size: 18px; }
.totals, .chart-panel, .shift-details { overflow: hidden; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
.totals-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--fs-border); }
.grand-headline { margin: 0; font-size: 15px; font-weight: 600; }
.totals-head > span { flex-shrink: 0; color: var(--fs-muted); font-size: 12px; }
.totals :deep(.amount-grid) { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.totals :deep(.amount-grid > div) { border-right: 1px solid var(--fs-border); }
.totals :deep(.amount-grid > div:nth-child(-n + 4)) { border-top: 0; }
.totals :deep(.amount-grid > div:nth-child(4n)) { border-right: 0; }
.section-title { margin: 18px 0 8px; font-size: 14px; font-weight: 600; }
.chart-panel { margin-top: 12px; }
.chart-panel .section-title { margin: 12px 12px 0; }
.chart { width: 100%;  }
.shift-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 8px; }
.shift-details summary { display: flex; align-items: center; gap: 10px; min-height: 64px; padding: 10px 12px; cursor: pointer; list-style: none; }
.shift-details summary::-webkit-details-marker { display: none; }
.shift-details summary:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: -3px; border-radius: var(--fs-radius-md); }
.shift-heading { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
.shift-heading strong { font-size: 14px; overflow-wrap: anywhere; }
.shift-heading > span { color: var(--fs-muted); font-size: 12px; overflow-wrap: anywhere; }
.shift-total { font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.disclosure-icon { flex-shrink: 0; color: var(--fs-muted); }
.shift-details[open] .disclosure-icon { transform: rotate(90deg); }
.shift-details[open] summary { border-bottom: 1px solid var(--fs-border); }
.report-extras { margin: 0; padding: 0 12px 10px; }
.report-extras > div { display: flex; justify-content: space-between; gap: 12px; padding-top: 8px; border-top: 1px solid var(--fs-border); font-size: 12px; }
.report-extras > div + div { margin-top: 8px; }
.report-extras dt { flex-shrink: 0; color: var(--fs-muted); }
.report-extras dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .panel-title { font-size: 16px; }
  .export-action { min-height: 44px; padding: 0 10px; font-size: 12px; }
  .filters { grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr) 44px; gap: 8px; }
  .filters :deep(.el-input__inner), .filters :deep(.el-select__selected-item) { font-size: 14px; }
  .filters :deep(.el-input__wrapper) { padding: 1px 8px; }
  .filters :deep(.el-input__prefix) { display: none; }
  .totals-head { padding: 10px; }
  .grand-headline { font-size: 13px; }
  .totals :deep(.amount-grid) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .totals :deep(.amount-grid > div:nth-child(n + 3)) { border-top: 1px solid var(--fs-border); }
  .totals :deep(.amount-grid > div:nth-child(even)) { border-right: 0; }
  .shift-grid { grid-template-columns: minmax(0, 1fr); }
  .shift-details summary { min-height: 60px; padding: 9px 10px; gap: 8px; }
  .shift-total { font-size: 13px; }
}
</style>
