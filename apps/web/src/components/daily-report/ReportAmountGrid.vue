<script setup lang="ts">
import type { ReportAggregate } from '@/analytics/report-analytics';

defineProps<{
  amounts: Omit<ReportAggregate, 'count'>;
}>();

const fields = [
  { key: 'totalSalesYen', label: '実際売上' },
  { key: 'cashDepositYen', label: '現金入金金額' },
  { key: 'imosSalesYen', label: 'Imos売上合計' },
  { key: 'expenseYen', label: '支出' },
  { key: 'staffMealTotalYen', label: 'スタッフ食事代合計' },
  { key: 'deviationYen', label: '偏差' },
  { key: 'staffMealCashYen', label: 'スタッフ食事代（現金）' },
  { key: 'staffMealAlipayYen', label: 'スタッフ食事代（アリペイ）' },
] as const;
</script>

<template>
  <dl class="amount-grid">
    <div v-for="field in fields" :key="field.key" :class="{ featured: field.key === 'totalSalesYen' }">
      <dt>{{ field.label }}</dt>
      <dd>{{ amounts[field.key].toLocaleString('ja-JP') }} <span>円</span></dd>
    </div>
  </dl>
</template>

<style scoped>
.amount-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0; margin: 0; }
.amount-grid > div { min-width: 0; padding: 10px 12px; border-top: 1px solid var(--fs-border); }
.amount-grid > div:nth-child(-n + 2) { border-top: 0; }
.amount-grid > div:nth-child(odd) { border-right: 1px solid var(--fs-border); }
dt { color: var(--fs-muted); font-size: 12px; line-height: 1.4; }
dd { margin: 4px 0 0; color: var(--fs-ink); font-size: 17px; font-weight: 600; line-height: 1.35; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
dd span { font-size: 12px; font-weight: 400; }
.featured { background: var(--fs-surface); }
.featured dd { color: var(--fs-accent); font-weight: 700; }
@media (max-width: 720px) {
  .amount-grid > div { padding: 9px 10px; }
  dt { font-size: 11px; }
  dd { font-size: clamp(14px, 4vw, 17px); }
}
</style>
