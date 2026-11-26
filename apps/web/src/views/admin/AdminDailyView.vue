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

import { computeDailyReportTotals, staffMealTotalYen, storeLabel } from '@fsk/domain';
import { ArrowDown, ArrowRight, EditPen, Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onBeforeUnmount, shallowRef } from 'vue';
import { useRouter } from 'vue-router';

import { businessDateRange, recentTokyoBusinessDateRange } from '@/data/date-range';
import { createDailyReportsRepository } from '@/data/daily-reports';
import { DataRepositoryError } from '@/data/errors';
import { useStoreSelection } from '@/stores/store-selection';
import { createOwnerMasterDataRepository } from '@/data/master-data';
import { todayTokyo } from '@/utils/tokyo';
const storeScope = useStoreSelection().selected;
const ownerMasterDataRepository = createOwnerMasterDataRepository(undefined, storeScope);
const dailyReportsRepository = createDailyReportsRepository(undefined, { storeId: storeScope });

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
const deletingReportKey = shallowRef<string | null>(null);
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
  return computeDailyReportTotals(report, report.registerFloatSnapshot ?? registerFloatAmount.value)
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
  const identity = audit.legacySubmittedByUsername || audit.owner;
  return identity?.split('::').at(-1) || 'ユーザーによる追加';
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
  if (deletingReportKey.value !== null) return;
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
  if (storeScope === 'all') { ElMessage.info('店舗を選択してください'); return; }
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
  if (deletingReportKey.value !== null) return;
  await router.push({ name: 'owner-report-edit', params: { reportKey } });
}

async function removeReport(report: ListedReport): Promise<void> {
  if (loading.value || deletingReportKey.value !== null || isUnmounted) return;
  deletingReportKey.value = report.reportKey;
  try {
    await ElMessageBox.confirm(
      `${storeLabel(report.storeId)}・${report.businessDate}・${report.shiftNameSnapshot}の日報を削除します。売上集計から除外され、元に戻せません。添付ファイルは保管されます。`,
      '日報の削除',
      {
        type: 'warning',
        confirmButtonText: '削除する',
        cancelButtonText: 'キャンセル',
        confirmButtonClass: 'el-button--danger',
      },
    );
    if (isUnmounted) return;
    await dailyReportsRepository.deleteByReportKey(report.reportKey);
    if (isUnmounted) return;
    rows.value = rows.value.filter((row) => row.reportKey !== report.reportKey);
    expanded.value = expanded.value.filter((date) =>
      rows.value.some((row) => row.businessDate === date),
    );
    ElMessage.success('日報を削除しました');
  } catch (error: unknown) {
    if (isUnmounted || error === 'cancel' || error === 'close') return;
    ElMessage.error(
      error instanceof DataRepositoryError && error.code === 'DATA_NETWORK_ERROR'
        ? '削除結果を確認できません。日報一覧を読み込み直して確認してください'
        : ownerDataErrorMessage(error, '日報の削除に失敗しました。一覧を読み込み直して確認してください'),
    );
  } finally {
    deletingReportKey.value = null;
  }
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
          </p>
        </div>
        <el-button type="primary" class="head-action" :disabled="deletingReportKey !== null" @click="openNew">
          <el-icon><EditPen /></el-icon>
          日報を追加
        </el-button>
      </header>

      <div class="summary-grid" aria-label="全日報サマリー">
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
        <el-button class="filter-action" aria-label="読み込む" :loading="loading" :disabled="deletingReportKey !== null" @click="load">
          <el-icon v-if="!loading" class="filter-action-icon"><Refresh /></el-icon>
          <span class="filter-action-label">読み込む</span>
        </el-button>
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
                <el-table-column label="店舗" width="80"><template #default="{ row }">{{ storeLabel(row.storeId) }}</template></el-table-column>
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
                <el-table-column label="操作" width="150" align="right" fixed="right">
                  <template #default="{ row }">
                    <el-button type="primary" link :disabled="deletingReportKey !== null" @click.stop="edit(row.reportKey)">編集</el-button>
                    <el-button
                      type="danger"
                      link
                      :loading="deletingReportKey === row.reportKey"
                      :disabled="loading || deletingReportKey !== null"
                      @click.stop="removeReport(row)"
                    >削除</el-button>
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
                  <strong>{{ storeLabel(report.storeId) }} · {{ report.shiftNameSnapshot }}</strong>
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
                <div class="mobile-report-footer">
                  <span class="mobile-submitter">提出者 {{ submittedBy(report) }}</span>
                  <div class="mobile-report-actions">
                <el-button
                  type="primary"
                  plain
                  class="mobile-edit-button"
                  :disabled="deletingReportKey !== null"
                  @click.stop="edit(report.reportKey)"
                >
                  編集
                </el-button>
                <el-button
                  type="danger"
                  plain
                  :loading="deletingReportKey === report.reportKey"
                  :disabled="loading || deletingReportKey !== null"
                  @click.stop="removeReport(report)"
                >削除</el-button>
                  </div>
                </div>
              </article>
            </div>
            </section>
          </div>
        </template>
      </div>
    </section>

    <el-dialog v-model="dialogOpen" title="日報を追加" width="480px" destroy-on-close>
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
.panel { min-width: 0; padding: 16px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.panel-title { margin: 0; font-size: 18px; color: var(--fs-ink); }
.panel-meta { margin: 2px 0 0; color: var(--fs-muted); font-size: 12px; }
.meta-strong { font-weight: 600; font-variant-numeric: tabular-nums; }
.head-action { min-height: 44px; margin: 0; }
.head-action .el-icon { margin-right: 4px; }
.summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
.summary-item { min-width: 0; padding: 10px 12px; }
.summary-item + .summary-item { border-left: 1px solid var(--fs-border); }
.summary-item span { display: block; color: var(--fs-muted); font-size: 12px; }
.summary-item strong { display: block; margin-top: 3px; color: var(--fs-accent); font-size: 20px; line-height: 1.4; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 0; }
.filter-label, .filter-action-icon { display: none; }
.filter-controls { display: flex; align-items: center; gap: 8px; }
.range-separator { color: var(--fs-muted); }
.mobile-report-list { display: none; }
.list-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.list-heading h3 { margin: 0; font-size: 14px; }
.list-heading span { display: inline-flex; align-items: center; gap: 3px; color: var(--fs-muted); font-size: 12px; }
.list-collapse { border: none; }
.day-title { display: flex; align-items: center; gap: 12px; width: 100%; padding-right: 8px; }
.day-date { font-weight: 600; font-variant-numeric: tabular-nums; }
.day-sum { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.day-table { min-width: 980px; }
.dialog-field { width: 100%; }
@media (max-width: 720px) {
  .panel { padding: 0; border: 0; border-radius: 0; background: transparent; }
  .panel-title { font-size: 18px; }
  .head-action { padding: 0 12px; font-size: 13px; }
  .summary-item { padding: 10px; }
  .summary-item span { font-size: 11px; }
  .summary-item strong { font-size: clamp(15px, 4.4vw, 18px); }
  .filters { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 8px; }
  .filter-controls { min-width: 0; gap: 6px; }
  .filter-controls :deep(.el-date-editor) { width: 100%; min-width: 0; height: 44px; }
  .filter-controls :deep(.el-input__wrapper) { min-height: 44px; padding: 1px 8px; }
  .filter-controls :deep(.el-input__prefix) { display: none; }
  .filter-controls :deep(.el-input__inner) { font-size: 13px; }
  .filters > .el-button { width: 44px; min-height: 44px; padding: 0; }
  .filter-action-icon { display: inline-flex; font-size: 18px; }
  .filter-action-label { display: none; }
  .desktop-report-list { display: none; }
  .mobile-report-list { display: block; overflow: hidden; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-md); background: var(--fs-surface-elevated); }
  .mobile-day-group + .mobile-day-group { border-top: 1px solid var(--fs-border); }
  .mobile-day-button { display: grid; width: 100%; min-height: 54px; grid-template-columns: minmax(0, 1fr) auto 16px; align-items: center; gap: 8px; padding: 8px 10px; color: var(--fs-ink); text-align: left; background: transparent; border: 0; cursor: pointer; }
  .mobile-day-button:focus-visible { outline: 2px solid var(--fs-accent); outline-offset: -3px; }
  .mobile-day-main { display: flex; min-width: 0; flex-direction: column; gap: 1px; }
  .mobile-day-main strong { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .mobile-day-main span { color: var(--fs-muted); font-size: 11px; }
  .mobile-day-total { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mobile-day-button .el-icon { color: var(--fs-muted); }
  .mobile-day-button .el-icon.expanded { transform: rotate(90deg); }
  .mobile-day-details { padding: 8px; border-top: 1px solid var(--fs-border); background: var(--fs-surface); }
  .mobile-report-card { padding: 10px; border: 1px solid var(--fs-border); border-radius: var(--fs-radius-sm); background: var(--fs-surface-elevated); }
  .mobile-report-card + .mobile-report-card { margin-top: 8px; }
  .mobile-report-head strong { font-size: 13px; font-weight: 600; }
  .mobile-report-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 8px 0; }
  .mobile-report-metrics div { min-width: 0; }
  .mobile-report-metrics dt { color: var(--fs-muted); font-size: 11px; }
  .mobile-report-metrics dd { margin: 2px 0 0; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .mobile-report-metrics div:first-child dd { color: var(--fs-accent); }
  .mobile-report-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--fs-border); padding-top: 6px; }
  .mobile-submitter { min-width: 0; color: var(--fs-muted); font-size: 11px; overflow-wrap: anywhere; }
  .mobile-report-actions { display: flex; flex-shrink: 0; gap: 6px; }
  .mobile-report-actions .el-button { min-height: 44px; margin-left: 0; padding: 0 12px; }
  :deep(.el-dialog) { width: calc(100% - 28px) !important; max-width: 480px; margin-top: max(8vh, calc(var(--fs-safe-area-top) + 16px)); }
  :deep(.el-dialog__footer) { display: flex; }
  :deep(.el-dialog__footer .el-button) { flex: 1; min-height: 44px; }
}
</style>
