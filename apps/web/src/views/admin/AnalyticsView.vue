<script setup lang="ts">
import { onMounted, ref, watch, nextTick, computed } from 'vue';
import { http } from '@/api/http';
import { todayTokyo } from '@/utils/tokyo';
import {
  deviationYenFromStoredFields,
  staffMealTotalYen as computeStaffMealTotalYen,
} from '@/utils/daily-report-calc';
import { useEchartsBarChart } from '@/composables/useEchartsBarChart';

type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';

type DayReportRow = {
  id: string;
  shiftNameSnapshot: string;
  timeRangeLabelSnapshot: string;
  responsiblePersonSnapshot: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  imosSalesYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  expenseReason: string | null;
  totalSalesYen: number;
  cashDepositYen: number;
  deviationYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  shift: { sortOrder: number };
  createdBy: { username: string };
};

const period = ref<Period>('week');
const anchorDate = ref(todayTokyo());
const loading = ref(false);
const registerFloatAmount = ref(0);
const summary = ref<{
  range: { start: string; end: string };
  totals: {
    totalSalesYen: number;
    imosSalesYen: number;
    expenseYen: number;
    cashDepositYen: number;
    deviationYen: number;
    staffMealCashYen: number;
    staffMealAlipayYen: number;
    staffMealTotalYen: number;
  };
  byShift: {
    shiftName: string;
    totalSalesYen: number;
    imosSalesYen: number;
    expenseYen: number;
    cashDepositYen: number;
    deviationYen: number;
    staffMealCashYen: number;
    staffMealAlipayYen: number;
    staffMealTotalYen: number;
    count: number;
  }[];
  rows?: DayReportRow[];
} | null>(null);

const sortedDayRows = computed(() => {
  const rows = summary.value?.rows;
  if (!rows?.length) return [];
  return [...rows].sort((a, b) => a.shift.sortOrder - b.shift.sortOrder);
});

/** 区间内所有日报行的合计（各班次之和） */
const grandTotals = computed(() => {
  const rows = summary.value?.rows ?? [];
  let totalSalesYen = 0;
  let imosSalesYen = 0;
  let newageYen = 0;
  let cashDepositYen = 0;
  let expenseYen = 0;
  let deviationYen = 0;
  let staffMealCashYen = 0;
  let staffMealAlipayYen = 0;
  let staffMealTotalYen = 0;
  for (const r of rows) {
    totalSalesYen += r.totalSalesYen;
    imosSalesYen += r.imosSalesYen;
    newageYen += r.newageYen;
    cashDepositYen += r.cashDepositYen;
    expenseYen += r.expenseYen;
    deviationYen += deviationYenFromStoredFields(r);
    staffMealCashYen += r.staffMealCashYen;
    staffMealAlipayYen += r.staffMealAlipayYen;
    staffMealTotalYen += computeStaffMealTotalYen(
      r.staffMealCashYen,
      r.staffMealAlipayYen,
    );
  }
  return {
    totalSalesYen,
    imosSalesYen,
    newageYen,
    cashDepositYen,
    expenseYen,
    deviationYen,
    staffMealCashYen,
    staffMealAlipayYen,
    staffMealTotalYen,
    count: rows.length,
  };
});

/** 标题用日期格式：如 2026年4月11日；选周时则为起止两段 */
function formatJaDate(iso: string): string {
  const [y, m, d] = iso.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) return iso;
  return `${y}年${m}月${d}日`;
}

const summaryHeadline = computed(() => {
  if (!summary.value) return '';
  const { start, end } = summary.value.range;
  if (period.value === 'day') return formatJaDate(start);
  if (start === end) return formatJaDate(start);
  return `${formatJaDate(start)} ～ ${formatJaDate(end)}`;
});

const chartEl = ref<HTMLDivElement | null>(null);
const { setBarData } = useEchartsBarChart(chartEl);

async function load() {
  loading.value = true;
  try {
    const [{ data }, { data: st }] = await Promise.all([
      http.get('/analytics/summary', {
        params: { period: period.value, anchorDate: anchorDate.value },
      }),
      http.get<{ registerFloatAmount?: number }>('/meta/settings'),
    ]);
    summary.value = data;
    registerFloatAmount.value = st?.registerFloatAmount ?? 0;
    await nextTick();
    renderChart();
  } finally {
    loading.value = false;
  }
}

function renderChart() {
  if (!summary.value) return;
  setBarData(
    summary.value.byShift.map((b) => b.shiftName),
    [
      {
        name: '実際売上',
        data: summary.value.byShift.map((b) => b.totalSalesYen),
      },
    ],
  );
}

function cashInDrawer(r: DayReportRow): number {
  return r.cashTotalYen;
}

function cashNetRow(r: DayReportRow): number {
  return r.cashDepositYen;
}

function rowDeviation(r: DayReportRow): number {
  return deviationYenFromStoredFields(r);
}

onMounted(load);
watch([period, anchorDate], load);

/** 与 http 实例相同 baseURL（开发环境直连 API），避免相对路径 fetch 丢失 period 等参数 */
async function downloadAggregate(format: 'xlsx' | 'pdf') {
  const { data } = await http.get<Blob>('/export/aggregate', {
    params: {
      period: period.value,
      anchorDate: anchorDate.value,
      format,
    },
    responseType: 'blob',
  });
  const blob = data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aggregate-${period.value}-${anchorDate.value}.${format === 'xlsx' ? 'xlsx' : 'pdf'}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
</script>

<template>
  <div v-loading="loading">
    <el-form inline>
      <el-form-item label="期間">
        <el-select v-model="period" style="width: 140px">
          <el-option label="単日（業務日）" value="day" />
          <el-option label="週" value="week" />
          <el-option label="月" value="month" />
          <el-option label="四半期" value="quarter" />
          <el-option label="年" value="year" />
        </el-select>
      </el-form-item>
      <el-form-item :label="period === 'day' ? '業務日' : '基準日'">
        <el-date-picker v-model="anchorDate" value-format="YYYY-MM-DD" type="date" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" @click="load">再集計</el-button>
        <el-button @click="downloadAggregate('xlsx')">Excel を出力</el-button>
        <el-button @click="downloadAggregate('pdf')">PDF を出力</el-button>
      </el-form-item>
    </el-form>

    <template v-if="summary">
      <h2 class="grand-headline">{{ summaryHeadline }}</h2>
      <p class="range-sub">
        <template v-if="period === 'day'">
          業務日（白班→夜班）: {{ summary.range.start }} ／ 対象
          {{ grandTotals.count }} 件
        </template>
        <template v-else>
          集計範囲: {{ summary.range.start }} — {{ summary.range.end }} ／ 対象 {{ grandTotals.count }} 件
        </template>
      </p>

      <el-descriptions :column="1" border size="small" class="grand-totals-desc">
        <el-descriptions-item label="Imos売上合計">
          {{ grandTotals.imosSalesYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="Newage売上">
          {{ grandTotals.newageYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="現金入金金額">
          {{ grandTotals.cashDepositYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="支出">
          {{ grandTotals.expenseYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="网管餐費（現金）">
          {{ grandTotals.staffMealCashYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="网管餐費（支付宝）">
          {{ grandTotals.staffMealAlipayYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="网管餐費合計">
          {{ grandTotals.staffMealTotalYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="実際売上">
          {{ grandTotals.totalSalesYen }} 円
        </el-descriptions-item>
        <el-descriptions-item label="偏差">
          <span class="deviation">{{ grandTotals.deviationYen }} 円</span>
        </el-descriptions-item>
      </el-descriptions>
      <p class="cash-note">
        ※現金入金金額は各日報の「お手元残高 − 底銭」の合算です。
      </p>

      <template v-if="period === 'day'">
        <h3 class="section-title">シフト別内訳</h3>
        <p v-if="!sortedDayRows.length" class="empty-day">この業務日の日報はまだありません。</p>
        <div v-for="r in sortedDayRows" :key="r.id" class="day-shift-block">
          <h3 class="shift-title">{{ r.shiftNameSnapshot }}</h3>
          <el-descriptions border :column="1" size="small" class="day-desc">
            <el-descriptions-item label="責任者">
              {{ r.responsiblePersonSnapshot }}
            </el-descriptions-item>
            <el-descriptions-item label="Newage時間">
              {{ r.timeRangeLabelSnapshot }}
            </el-descriptions-item>
            <el-descriptions-item label="前期Imos残高">
              {{ r.previousImosBalanceYen }} 円
            </el-descriptions-item>
            <el-descriptions-item label="現在Imos残高">
              {{ r.currentImosBalanceYen }} 円
            </el-descriptions-item>
            <el-descriptions-item label="Imos売上合計">
              {{ r.imosSalesYen }} 円
            </el-descriptions-item>
            <el-descriptions-item label="Newage">{{ r.newageYen }} 円</el-descriptions-item>
            <el-descriptions-item label="お手元残高">
              {{ cashInDrawer(r) }} 円
            </el-descriptions-item>
            <el-descriptions-item label="底銭">
              {{ registerFloatAmount }} 円
            </el-descriptions-item>
            <el-descriptions-item label="現金入金金額">
              {{ cashNetRow(r) }} 円
            </el-descriptions-item>
            <el-descriptions-item label="支出">{{ r.expenseYen }} 円</el-descriptions-item>
            <el-descriptions-item label="支出理由">
              {{ r.expenseReason || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="网管餐費（現金）">
              {{ r.staffMealCashYen }} 円
            </el-descriptions-item>
            <el-descriptions-item label="网管餐費（支付宝）">
              {{ r.staffMealAlipayYen }} 円
            </el-descriptions-item>
            <el-descriptions-item label="网管餐費合計">
              {{ computeStaffMealTotalYen(r.staffMealCashYen, r.staffMealAlipayYen) }} 円
            </el-descriptions-item>
            <el-descriptions-item label="実際売上">
              {{ r.totalSalesYen }} 円
            </el-descriptions-item>
            <el-descriptions-item label="偏差">
              <span class="deviation">{{ rowDeviation(r) }} 円</span>
            </el-descriptions-item>
            <el-descriptions-item label="提出者">
              {{ r.createdBy.username }}
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </template>

      <div ref="chartEl" style="width: 100%; height: 360px" />
      <h3 class="section-title">シフト別合算（縦表）</h3>
      <div
        v-for="b in summary.byShift"
        :key="b.shiftName"
        class="by-shift-vertical"
      >
        <el-descriptions :column="1" border size="small" :title="b.shiftName">
          <el-descriptions-item label="件数">{{ b.count }}</el-descriptions-item>
          <el-descriptions-item label="Imos売上合計">{{ b.imosSalesYen }} 円</el-descriptions-item>
          <el-descriptions-item label="実際売上">{{ b.totalSalesYen }} 円</el-descriptions-item>
          <el-descriptions-item label="現金入金金額">{{ b.cashDepositYen }} 円</el-descriptions-item>
          <el-descriptions-item label="支出">{{ b.expenseYen }} 円</el-descriptions-item>
          <el-descriptions-item label="网管餐費（現金）">{{ b.staffMealCashYen }} 円</el-descriptions-item>
          <el-descriptions-item label="网管餐費（支付宝）">{{ b.staffMealAlipayYen }} 円</el-descriptions-item>
          <el-descriptions-item label="网管餐費合計">{{ b.staffMealTotalYen }} 円</el-descriptions-item>
          <el-descriptions-item label="偏差">{{ b.deviationYen }} 円</el-descriptions-item>
        </el-descriptions>
      </div>
    </template>
  </div>
</template>

<style scoped>
.grand-headline {
  margin: 0 0 8px;
  font-size: 1.2rem;
  font-weight: 600;
}
.range-sub {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
.grand-totals-desc {
  max-width: 520px;
  margin-bottom: 8px;
}
.by-shift-vertical {
  max-width: 520px;
  margin-bottom: 16px;
}
.by-shift-vertical :deep(.el-descriptions__title) {
  font-weight: 600;
  margin-bottom: 8px;
}
.cash-note {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.section-title {
  margin: 20px 0 10px;
  font-size: 1rem;
  font-weight: 600;
}
.empty-day {
  color: #888;
  margin-bottom: 16px;
}
.day-shift-block {
  margin-bottom: 20px;
  max-width: 720px;
}
.shift-title {
  margin: 0 0 8px;
  font-size: 1rem;
  border-bottom: 1px solid #dcdfe6;
  padding-bottom: 6px;
}
.day-desc {
  margin-bottom: 8px;
}
.deviation {
  font-weight: 600;
}
</style>
