<script setup lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue';
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

const cashTooltip =
  'お手元残高から底銭を引いた金額を、現金入金金額として計算します。';

function yen(n: number): string {
  return `${n.toLocaleString('ja-JP')} 円`;
}
</script>

<template>
  <DailyReportSection title="結算入力">
    <el-form-item label="Imos" class="item-plain">
      <div class="money-row">
        <div class="money-cell">
          <span class="sub-label">前期Imos残高</span>
          <el-input-number v-model="form.previousImosBalanceYen" :min="0" controls-position="right" />
          <p class="field-guide">前回シフト終了時点のImos残高を入力します。</p>
        </div>
        <div class="money-cell">
          <span class="sub-label">現在Imos残高</span>
          <el-input-number v-model="form.currentImosBalanceYen" :min="0" controls-position="right" />
          <p class="field-guide">このシフト終了時点のImos残高を入力します。</p>
        </div>
        <div class="result-cell">
          <span class="sub-label">Imos売上合計</span>
          <strong>{{ yen(preview.imosSalesYen) }}</strong>
          <p class="field-guide result-guide">現在残高から前期残高を引いて自動計算されます。</p>
        </div>
      </div>
    </el-form-item>

    <el-form-item label="Newage売上" class="item-plain">
      <div class="field-with-guide">
        <el-input-number v-model="form.newageYen" :min="0" controls-position="right" />
        <p class="field-guide">Newage側で確認したこのシフトの売上金額を入力します。</p>
      </div>
    </el-form-item>

    <el-form-item class="item-plain">
      <template #label>
        <span class="label-with-tip">
          お手元残高
          <el-tooltip :content="cashTooltip" placement="top" :show-after="300">
            <span class="tip-wrap" tabindex="0" role="button" aria-label="お手元残高の説明">
              <el-icon :size="16"><QuestionFilled /></el-icon>
            </span>
          </el-tooltip>
        </span>
      </template>
      <div class="field-with-guide">
        <el-input-number v-model="form.cashInDrawerYen" :min="0" controls-position="right" />
        <p class="field-guide">手元に残っている現金総額を入力します。底銭は下で自動控除されます。</p>
      </div>
      <p class="cash-meta">
        現金入金金額 <strong>{{ yen(preview.cashDepositYen) }}</strong>（底銭
        {{ registerFloatAmount.toLocaleString('ja-JP') }} 円）
      </p>
    </el-form-item>

    <el-form-item label="支出" class="item-plain">
      <div class="expense-wrap">
        <div class="expense-row">
          <el-input-number v-model="form.expenseYen" :min="0" controls-position="right" />
          <el-input v-model="form.expenseReason" placeholder="支出ありの場合必須" />
          <div class="receipt-box">
            <span class="receipt-label">領収書確認</span>
            <el-checkbox v-model="form.expenseReceiptStored" class="receipt-check">
              領収書の受け取りをして、収納しました
            </el-checkbox>
          </div>
        </div>
        <p class="field-guide expense-guide">支出がある場合は金額と理由を両方入力してください。</p>
      </div>
    </el-form-item>

    <el-form-item label="网管餐费" class="item-plain">
      <div class="staff-meal-wrap">
        <div class="staff-meal-grid">
          <div class="money-cell">
            <span class="sub-label">現金</span>
            <el-input-number
              v-model="form.staffMealCashYen"
              :min="0"
              :max="MAX_DAILY_REPORT_AMOUNT_YEN"
              :precision="0"
              :step="1"
              controls-position="right"
            />
          </div>
          <div class="money-cell">
            <span class="sub-label">支付宝</span>
            <el-input-number
              v-model="form.staffMealAlipayYen"
              :min="0"
              :max="MAX_DAILY_REPORT_AMOUNT_YEN"
              :precision="0"
              :step="1"
              controls-position="right"
            />
          </div>
          <div class="result-cell">
            <span class="sub-label">网管餐费合計</span>
            <strong>{{ yen(preview.staffMealTotalYen) }}</strong>
          </div>
        </div>
        <p class="field-guide staff-meal-guide">
          現金は現金入金金額に含まれますが、実際売上から除外します。支付宝は単独保存し、実際売上には含めません。
        </p>
      </div>
    </el-form-item>

    <el-form-item label="総計" class="item-plain">
      <div class="totals-grid">
        <div class="result-cell">
          <span class="sub-label">実際売上</span>
          <strong>{{ yen(preview.totalSalesYen) }}</strong>
          <p class="field-guide result-guide">
            Newage売上 + 現金入金金額 − 网管餐費（現金）です。
          </p>
        </div>
        <div class="result-cell">
          <span class="sub-label">現金入金金額</span>
          <strong>{{ yen(preview.cashDepositYen) }}</strong>
          <p class="field-guide result-guide">お手元残高から底銭を引いた金額です。</p>
        </div>
        <div class="result-cell">
          <span class="sub-label">偏差</span>
          <strong>{{ yen(preview.deviationYen) }}</strong>
          <p class="field-guide result-guide">現金入金金額と実際売上・支出の差額です。</p>
        </div>
      </div>
    </el-form-item>
  </DailyReportSection>
</template>

<style scoped>
.item-plain {
  margin-bottom: 16px;
}

.item-plain:last-child {
  margin-bottom: 0;
}

.item-plain :deep(.el-form-item__label) {
  font-weight: 600;
  color: var(--fs-ink, var(--el-text-color-primary));
}

.item-plain :deep(.el-input-number) {
  width: 100%;
  max-width: 200px;
}

.field-with-guide {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 14px;
  width: 100%;
}

.field-guide {
  margin: 0;
  max-width: 34ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.money-row,
.totals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px 20px;
  width: 100%;
}

.money-cell,
.result-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.result-cell {
  min-height: 54px;
  justify-content: center;
  padding: 10px 12px;
  border: 1px solid var(--fs-border, var(--el-border-color-lighter));
  border-radius: 6px;
  background: var(--fs-surface, var(--el-fill-color-blank));
}

.result-cell strong {
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
  color: var(--fs-ink, var(--el-text-color-primary));
}

.result-guide {
  max-width: none;
  font-size: 12px;
}

.sub-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.label-with-tip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tip-wrap {
  display: inline-flex;
  cursor: help;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.cash-meta {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.expense-wrap {
  width: 100%;
}

.expense-row {
  display: grid;
  grid-template-columns: minmax(160px, 200px) minmax(220px, 1fr) minmax(220px, 280px);
  gap: 12px;
  width: 100%;
  max-width: 920px;
  align-items: start;
}

.expense-guide {
  margin-top: 8px;
}

.staff-meal-wrap {
  width: 100%;
}

.staff-meal-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(160px, 200px));
  gap: 14px 20px;
  width: 100%;
}

.staff-meal-guide {
  max-width: 72ch;
  margin-top: 8px;
}

.receipt-box {
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid var(--fs-border, var(--el-border-color));
  border-radius: 6px;
  background: var(--fs-surface, var(--el-fill-color-blank));
}

.receipt-label {
  display: block;
  margin-bottom: 3px;
  font-size: 12px;
  font-weight: 700;
  color: var(--fs-muted, var(--el-text-color-secondary));
}

.receipt-check {
  font-weight: 600;
  color: var(--fs-ink, var(--el-text-color-primary));
  white-space: normal;
  height: auto;
  line-height: 1.35;
}

.receipt-check :deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.35;
}

@media (max-width: 560px) {
  .staff-meal-grid {
    grid-template-columns: 1fr;
  }

  .expense-row {
    grid-template-columns: 1fr;
  }

  .field-with-guide {
    flex-direction: column;
  }
}
</style>
