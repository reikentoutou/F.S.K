<script setup lang="ts">
import { MAX_DAILY_REPORT_AMOUNT_YEN } from '@/utils/daily-report-form-validate';
import DailyReportSection from './DailyReportSection.vue';
import type { DailyReportFormFieldsModel } from './daily-report-form.types';

defineProps<{
  form: DailyReportFormFieldsModel;
  registerFloatAmount: number;
  preview: {
    imosSalesYen: number;
    totalSalesYen: number;
    cashDepositYen: number;
    deviationYen: number;
    staffMealTotalYen: number;
  };
}>();

function yen(n: number): string {
  return `${n.toLocaleString('ja-JP')} 円`;
}
</script>

<template>
  <DailyReportSection title="精算入力">
    <div class="settlement-grid">
      <el-form-item label="Imos" class="item-plain">
        <div class="money-row">
          <div class="money-cell">
            <span class="sub-label">前期Imos残高</span>
            <el-input-number v-model="form.previousImosBalanceYen" aria-label="前期Imos残高" :min="0" :controls="false" inputmode="numeric" />
          </div>
          <div class="money-cell">
            <span class="sub-label">現在Imos残高</span>
            <el-input-number v-model="form.currentImosBalanceYen" aria-label="現在Imos残高" :min="0" :controls="false" inputmode="numeric" />
          </div>
          <div class="result-cell inline-result">
            <span class="sub-label">Imos売上合計</span>
            <strong>{{ yen(preview.imosSalesYen) }}</strong>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="Newage売上" class="item-plain amount-field">
        <div class="field-with-guide">
          <el-input-number v-model="form.newageYen" aria-label="Newage売上" :min="0" :controls="false" inputmode="numeric" />
        </div>
      </el-form-item>

      <el-form-item label="お手元残高" class="item-plain amount-field">
        <div class="field-with-guide">
          <el-input-number v-model="form.cashInDrawerYen" aria-label="お手元残高" :min="0" :controls="false" inputmode="numeric" />
        </div>
        <p class="cash-meta">
          底銭 {{ yen(registerFloatAmount) }}
        </p>
      </el-form-item>

      <el-form-item label="支出" class="item-plain">
        <div class="expense-wrap">
          <div class="expense-row">
            <el-input-number v-model="form.expenseYen" aria-label="支出金額" :min="0" :controls="false" inputmode="numeric" />
            <el-input v-model="form.expenseReason" placeholder="支出理由" aria-label="支出理由" />
            <div class="receipt-box">
              <el-checkbox v-model="form.expenseReceiptStored" class="receipt-check">
                領収書 受取・保管済み
              </el-checkbox>
            </div>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="スタッフ食事代" class="item-plain">
        <div class="staff-meal-wrap">
          <div class="staff-meal-grid">
            <div class="money-cell">
              <span class="sub-label">現金</span>
              <el-input-number
                v-model="form.staffMealCashYen"
                aria-label="スタッフ食事代（現金）"
                :min="0"
                :max="MAX_DAILY_REPORT_AMOUNT_YEN"
                :precision="0"
                :step="1"
                :controls="false"
                inputmode="numeric"
              />
            </div>
            <div class="money-cell">
              <span class="sub-label">アリペイ</span>
              <el-input-number
                v-model="form.staffMealAlipayYen"
                aria-label="スタッフ食事代（アリペイ）"
                :min="0"
                :max="MAX_DAILY_REPORT_AMOUNT_YEN"
                :precision="0"
                :step="1"
                :controls="false"
                inputmode="numeric"
              />
            </div>
            <div class="result-cell inline-result">
              <span class="sub-label">スタッフ食事代合計</span>
              <strong>{{ yen(preview.staffMealTotalYen) }}</strong>
            </div>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="総計" class="item-plain">
        <div class="totals-grid">
          <div class="result-cell">
            <span class="sub-label">実際売上</span>
            <strong>{{ yen(preview.totalSalesYen) }}</strong>
          </div>
          <div class="result-cell">
            <span class="sub-label">現金入金金額</span>
            <strong>{{ yen(preview.cashDepositYen) }}</strong>
          </div>
          <div class="result-cell">
            <span class="sub-label">偏差</span>
            <strong>{{ yen(preview.deviationYen) }}</strong>
          </div>
        </div>
      </el-form-item>
    </div>
  </DailyReportSection>
</template>

<style scoped>
.settlement-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 12px;
}

.item-plain {
  grid-column: 1 / -1;
  min-width: 0;
  margin-bottom: 0;
}

.amount-field {
  grid-column: auto;
}

.item-plain :deep(.el-form-item__label) {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--fs-ink);
}

.item-plain :deep(.el-form-item__content) {
  min-width: 0;
  line-height: 1.4;
}

.item-plain :deep(.el-input-number),
.field-with-guide,
.expense-wrap,
.staff-meal-wrap {
  width: 100%;
  min-width: 0;
}

.item-plain :deep(.el-input__wrapper) {
  min-height: 44px;
  padding: 0 12px;
}

.item-plain :deep(.el-input__inner) {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  text-align: left;
}

.money-row,
.staff-meal-grid,
.expense-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  width: 100%;
}

.money-cell {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.sub-label {
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  color: var(--fs-muted);
}

.result-cell {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.result-cell strong {
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow-wrap: anywhere;
  color: var(--fs-ink);
}

.inline-result {
  grid-column: 1 / -1;
  padding-top: 2px;
}

.cash-meta {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--fs-muted);
}

.receipt-box {
  grid-column: 1 / -1;
}

.receipt-check {
  min-height: 44px;
  height: auto;
  white-space: normal;
  color: var(--fs-ink);
}

.receipt-check :deep(.el-checkbox__label) {
  font-size: 13px;
  white-space: normal;
}

.totals-grid {
  display: grid;
  gap: 8px;
  width: 100%;
  padding-top: 12px;
  border-top: 1px solid var(--fs-border);
}

.totals-grid .result-cell:first-child strong {
  font-size: 18px;
  font-weight: 700;
  color: var(--fs-accent);
}

@media (max-width: 640px) {
  .settlement-grid { gap: 12px; }
}
</style>
