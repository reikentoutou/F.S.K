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
}

export async function loadOwnerAnalytics(
  options: OwnerAnalyticsLoadOptions,
): Promise<{
  range: { start: string; end: string };
  registerFloatAmount: number;
  analytics: ReportAnalytics;
}> {
  const range = tokyoPeriodRange(options.period, options.anchorDate);
  const dates = businessDateRange(range.start, range.end);
  const setting = await options.getSetting('default').catch((error: unknown) => {
    if (
      error instanceof DataRepositoryError &&
      error.code === 'DATA_NOT_FOUND'
    ) {
      return null;
    }
    throw error;
  });
  const reports: AnalyticsReport[] = [];

  for (let index = 0; index < dates.length; index += 10) {
    const batch = dates.slice(index, index + 10);
    const results = await Promise.all(
      batch.map((businessDate) =>
        options.listByBusinessDate(businessDate),
      ),
    );
    reports.push(
      ...results
        .flat()
        .filter((report): report is AnalyticsReport => report !== null),
    );
  }

  const registerFloatAmount = setting?.registerFloatAmount ?? 0;
  return {
    range,
    registerFloatAmount,
    analytics: buildReportAnalytics(reports, registerFloatAmount),
  };
}
</script>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue';

import { actualSalesBarData } from '@/analytics/report-analytics';
import { useEchartsBarChart } from '@/composables/useEchartsBarChart';
import { dailyReportsRepository } from '@/data/daily-reports';
import { ownerMasterDataRepository } from '@/data/master-data';
import { buildReportCsv, downloadCsvFile } from '@/export/report-csv';
import { todayTokyo } from '@/utils/tokyo';

const period = shallowRef<AnalyticsPeriod>('week');
const anchorDate = shallowRef(todayTokyo());
const loading = shallowRef(false);
const range = shallowRef<{ start: string; end: string } | null>(null);
const analytics = shallowRef<ReportAnalytics | null>(null);
let loadGeneration = 0;

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

function ownerAnalyticsErrorMessage(error: unknown): string {
  if (!(error instanceof DataRepositoryError)) {
    if (error instanceof Error && error.message.startsWith('BUSINESS_DATE_')) {
      return '集計期間は最大366日まで指定できます';
    }
    return '集計データの読み込みに失敗しました';
  }
  switch (error.code) {
    case 'DATA_UNAUTHORIZED':
      return '权限不足，请重新以老板账号登录';
    case 'DATA_PAGINATION_FAILED':
      return '分页读取失败，请重试';
    case 'DATA_NETWORK_ERROR':
      return '网络异常，请确认连接后重试';
    case 'DATA_NOT_FOUND':
      return '未找到指定数据，可能已被修改';
    case 'DATA_CONFLICT':
      return '数据发生冲突，请刷新后重试';
    default:
      return '集計データの読み込みに失敗しました';
  }
}

function formatJaDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return year && month && day
    ? `${year}年${month}月${day}日`
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
  loading.value = true;
  try {
    const loaded = await loadOwnerAnalytics({
      period: period.value,
      anchorDate: anchorDate.value,
      listByBusinessDate: (businessDate) =>
        dailyReportsRepository.listByBusinessDate(
          businessDate,
        ) as Promise<Array<AnalyticsReport | null>>,
      getSetting: (id) => ownerMasterDataRepository.getSetting(id),
    });
    if (generation !== loadGeneration) return;
    range.value = loaded.range;
    analytics.value = loaded.analytics;
    await nextTick();
    if (generation === loadGeneration) renderChart(loaded.analytics);
  } catch (error: unknown) {
    if (generation !== loadGeneration) return;
    range.value = null;
    analytics.value = null;
    ElMessage.error(ownerAnalyticsErrorMessage(error));
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

function downloadCsv(): void {
  if (!analytics.value) return;
  downloadCsvFile(
    buildReportCsv(analytics.value.rows),
    `aggregate-${period.value}-${anchorDate.value}.csv`,
  );
}

watch([period, anchorDate], () => void load(), { immediate: true });
</script>

<template>
  <div v-loading="loading" class="page">
    <section class="panel" aria-labelledby="analytics-heading">
      <header class="panel-head">
        <div>
          <h2 id="analytics-heading" class="panel-title">集計・エクスポート</h2>
          <p class="panel-hint">東京の業務日単位で、最大366日まで集計します。</p>
        </div>
      </header>

      <el-form inline class="filters">
        <el-form-item label="期間">
          <el-select v-model="period" style="width: 150px" aria-label="集計期間">
            <el-option label="単日（業務日）" value="day" />
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
        <el-form-item>
          <el-button :loading="loading" @click="load">再集計</el-button>
          <el-button
            type="primary"
            :disabled="!analytics || loading"
            @click="downloadCsv"
          >
            CSV を出力
          </el-button>
        </el-form-item>
      </el-form>

      <div v-if="analytics && range" class="panel-body">
        <h3 class="grand-headline">{{ headline }}</h3>
        <p class="range-sub">
          集計範囲: {{ range.start }} — {{ range.end }} ／ 対象
          {{ analytics.totals.count }} 件
        </p>

        <el-descriptions :column="1" border size="small" class="totals">
          <el-descriptions-item label="Imos売上合計">
            {{ formatYen(analytics.totals.imosSalesYen) }}
          </el-descriptions-item>
          <el-descriptions-item label="現金入金金額">
            {{ formatYen(analytics.totals.cashDepositYen) }}
          </el-descriptions-item>
          <el-descriptions-item label="支出">
            {{ formatYen(analytics.totals.expenseYen) }}
          </el-descriptions-item>
          <el-descriptions-item label="网管餐費（現金）">
            {{ formatYen(analytics.totals.staffMealCashYen) }}
          </el-descriptions-item>
          <el-descriptions-item label="网管餐費（支付宝）">
            {{ formatYen(analytics.totals.staffMealAlipayYen) }}
          </el-descriptions-item>
          <el-descriptions-item label="网管餐費合計">
            {{ formatYen(analytics.totals.staffMealTotalYen) }}
          </el-descriptions-item>
          <el-descriptions-item label="実際売上">
            {{ formatYen(analytics.totals.totalSalesYen) }}
          </el-descriptions-item>
          <el-descriptions-item label="偏差">
            {{ formatYen(analytics.totals.deviationYen) }}
          </el-descriptions-item>
        </el-descriptions>

        <template v-if="period === 'day'">
          <h3 class="section-title">シフト別内訳</h3>
          <el-empty v-if="dayRows.length === 0" description="この業務日の日報はまだありません" />
          <div v-for="row in dayRows" :key="row.reportKey" class="day-shift-block">
            <el-descriptions
              :title="row.shiftNameSnapshot"
              :column="1"
              border
              size="small"
            >
              <el-descriptions-item label="責任者">
                {{ row.responsiblePersonSnapshot }}
              </el-descriptions-item>
              <el-descriptions-item label="時間帯">
                {{ row.timeRangeLabelSnapshot }}
              </el-descriptions-item>
              <el-descriptions-item label="Imos売上合計">
                {{ formatYen(row.imosSalesYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="Newage売上">
                {{ formatYen(row.newageYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="現金入金金額">
                {{ formatYen(row.cashDepositYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="支出">
                {{ formatYen(row.expenseYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="支出理由">
                {{ row.expenseReason || '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="网管餐費（現金）">
                {{ formatYen(row.staffMealCashYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="网管餐費（支付宝）">
                {{ formatYen(row.staffMealAlipayYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="网管餐費合計">
                {{ formatYen(row.staffMealTotalYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="実際売上">
                {{ formatYen(row.totalSalesYen) }}
              </el-descriptions-item>
              <el-descriptions-item label="偏差">
                {{ formatYen(row.deviationYen) }}
              </el-descriptions-item>
            </el-descriptions>
          </div>
        </template>

        <div ref="chartEl" class="chart" aria-label="シフト別実際売上グラフ" />

        <h3 class="section-title">シフト別合算</h3>
        <el-empty v-if="analytics.byShift.length === 0" description="この期間の日報はまだありません" />
        <div
          v-for="shift in analytics.byShift"
          :key="shift.shiftId"
          class="shift-summary"
        >
          <el-descriptions :title="shift.shiftName" :column="1" border size="small">
            <el-descriptions-item label="件数">{{ shift.count }}</el-descriptions-item>
            <el-descriptions-item label="Imos売上合計">
              {{ formatYen(shift.imosSalesYen) }}
            </el-descriptions-item>
            <el-descriptions-item label="実際売上">
              {{ formatYen(shift.totalSalesYen) }}
            </el-descriptions-item>
            <el-descriptions-item label="現金入金金額">
              {{ formatYen(shift.cashDepositYen) }}
            </el-descriptions-item>
            <el-descriptions-item label="支出">
              {{ formatYen(shift.expenseYen) }}
            </el-descriptions-item>
            <el-descriptions-item label="网管餐費（現金）">
              {{ formatYen(shift.staffMealCashYen) }}
            </el-descriptions-item>
            <el-descriptions-item label="网管餐費（支付宝）">
              {{ formatYen(shift.staffMealAlipayYen) }}
            </el-descriptions-item>
            <el-descriptions-item label="网管餐費合計">
              {{ formatYen(shift.staffMealTotalYen) }}
            </el-descriptions-item>
            <el-descriptions-item label="偏差">
              {{ formatYen(shift.deviationYen) }}
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.panel-title,
.grand-headline {
  margin: 0;
}

.panel-hint,
.range-sub {
  color: var(--fs-muted, var(--el-text-color-secondary));
  font-size: 0.82rem;
}

.filters {
  margin-top: 18px;
}

.totals,
.day-shift-block,
.shift-summary {
  max-width: 720px;
  margin-bottom: 16px;
}

.section-title {
  margin: 24px 0 12px;
  font-size: 1rem;
}

.chart {
  width: 100%;
  height: 360px;
  margin-top: 24px;
}
</style>
