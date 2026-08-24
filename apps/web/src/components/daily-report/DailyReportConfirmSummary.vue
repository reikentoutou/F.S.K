<script setup lang="ts">
import DailyReportSection from './DailyReportSection.vue';

const props = defineProps<{
  variant?: 'admin' | 'kitchen';
  preview: {
    imosSalesYen: number;
    totalSalesYen: number;
    cashDepositYen: number;
    deviationYen: number;
    staffMealTotalYen: number;
  };
  shiftName: string;
  personName: string;
  registerFloatAmount: number;
  startStr: string;
  endStr: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashInDrawerYen: number;
  expenseYen: number;
  expenseReason: string;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  showWebmasterRow?: boolean;
  webmasterLabel?: string;
}>();

function yen(n: number): string {
  return `${n.toLocaleString('ja-JP')} 円`;
}
</script>

<template>
  <div class="confirm-summary fs-anim-fade-lift">
    <header class="intro">
      <p class="eyebrow">提出前の確認</p>
      <h2 class="title">入力内容の確認</h2>
      <p class="lede">
        {{
          props.variant === 'kitchen'
            ? '入力内容を確認してください。提出後の修正は老板へ依頼してください。'
            : '問題なければ下部の「提出する」で確定してください。'
        }}
      </p>
    </header>

    <DailyReportSection v-if="showWebmasterRow" title="提出元">
      <div class="kv-row">
        <span class="kv-label">網管アカウント</span>
        <span class="kv-value">{{ webmasterLabel ?? '—' }}</span>
      </div>
    </DailyReportSection>

    <DailyReportSection title="基本">
      <div class="kv-row">
        <span class="kv-label">シフト</span>
        <span class="kv-value">{{ shiftName }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">責任者</span>
        <span class="kv-value">{{ personName }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">Newage時間</span>
        <span class="kv-value kv-mono">{{ startStr }} — {{ endStr }}</span>
      </div>
    </DailyReportSection>

    <DailyReportSection title="結算">
      <div class="kv-row">
        <span class="kv-label">前期Imos残高</span>
        <span class="kv-value">{{ yen(previousImosBalanceYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">現在Imos残高</span>
        <span class="kv-value">{{ yen(currentImosBalanceYen) }}</span>
      </div>
      <div class="kv-row row-total">
        <span class="kv-label">Imos売上合計</span>
        <span class="kv-value kv-strong">{{ yen(preview.imosSalesYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">Newage売上</span>
        <span class="kv-value">{{ yen(newageYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">お手元残高</span>
        <span class="kv-value">{{ yen(cashInDrawerYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">底銭</span>
        <span class="kv-value">{{ yen(registerFloatAmount) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">支出</span>
        <span class="kv-value">{{ yen(expenseYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">支出理由</span>
        <span class="kv-value">{{ expenseReason }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">网管餐費（現金）</span>
        <span class="kv-value">{{ yen(staffMealCashYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">网管餐費（支付宝）</span>
        <span class="kv-value">{{ yen(staffMealAlipayYen) }}</span>
      </div>
      <div class="kv-row row-total">
        <span class="kv-label">网管餐費合計</span>
        <span class="kv-value kv-strong">{{ yen(preview.staffMealTotalYen) }}</span>
      </div>
    </DailyReportSection>

    <DailyReportSection title="総計" class="block-highlight">
      <div class="kv-row">
        <span class="kv-label">実際売上</span>
        <span class="kv-value kv-strong">{{ yen(preview.totalSalesYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">現金入金金額</span>
        <span class="kv-value kv-strong">{{ yen(preview.cashDepositYen) }}</span>
      </div>
      <div class="kv-row">
        <span class="kv-label">偏差</span>
        <span class="kv-value kv-strong">{{ yen(preview.deviationYen) }}</span>
      </div>
    </DailyReportSection>
  </div>
</template>

<style scoped>
.confirm-summary {
  display: flex;
  flex-direction: column;
  gap: 20px;
  margin-bottom: 8px;
}

.intro {
  padding: 4px 0 8px;
}

.eyebrow {
  margin: 0 0 6px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.title {
  margin: 0 0 8px;
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--fs-ink, var(--el-text-color-primary));
  line-height: 1.25;
}

.lede {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.5;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.kv-row {
  display: grid;
  grid-template-columns: minmax(120px, 42%) 1fr;
  gap: 8px 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--fs-border, var(--el-border-color-lighter));
  align-items: baseline;
}

.kv-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.row-total {
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px dashed var(--fs-border, var(--el-border-color-lighter));
}

.kv-label {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.kv-value {
  font-size: 0.95rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--fs-ink, var(--el-text-color-primary));
  word-break: break-word;
}

.kv-mono {
  font-weight: 600;
}

.kv-strong {
  font-weight: 700;
  font-size: 1.05rem;
}

.block-highlight {
  border-color: var(--fs-border-strong, var(--el-border-color));
  background: var(--fs-surface, var(--el-fill-color-blank));
}

@media (max-width: 520px) {
  .kv-row {
    grid-template-columns: 1fr;
  }

  .kv-value {
    text-align: left;
  }
}
</style>
