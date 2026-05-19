import { defineComponent, h, ref, watch } from 'vue';
import { ElCheckbox, ElMessage, ElMessageBox } from 'element-plus';

const fmtJa = (v: number) => v.toLocaleString('ja-JP');

/**
 * 提交前：确认底钱数值（须勾选）并突出显示可取现金额
 */
export function confirmCashBeforeSubmit(opts: {
  registerFloatYen: number;
  cashInDrawerYen: number;
  withdrawalYen: number;
}): Promise<void> {
  const { registerFloatYen, cashInDrawerYen, withdrawalYen } = opts;
  /** 供 MessageBox 的 beforeClose 使用，与组件内勾选状态同步 */
  let agreedForGate = false;

  const Body = defineComponent({
    name: 'CashSubmitConfirmBody',
    setup() {
      const agreed = ref(false);
      watch(
        agreed,
        (v) => {
          agreedForGate = v;
        },
        { immediate: true },
      );
      return () =>
        h('div', { style: 'line-height:1.55;padding:2px 0' }, [
          h('p', { style: 'margin:0 0 10px;font-size:15px' }, [
            'レジ底銭は ',
            h('strong', null, `${fmtJa(registerFloatYen)}`),
            ' 円でよろしいですか。',
          ]),
          h(
            ElCheckbox,
            {
              modelValue: agreed.value,
              'onUpdate:modelValue': (v: boolean | string | number) => {
                agreed.value = v === true;
              },
            },
            () => '上記の底銭で正しい',
          ),
          h('p', { style: 'margin:14px 0 4px;font-size:15px' }, '現金入金金額'),
          h(
            'p',
            {
              style:
                'margin:0;font-size:20px;font-weight:700;color:var(--el-color-primary);letter-spacing:0.02em',
            },
            `${fmtJa(withdrawalYen)} 円`,
          ),
          h(
            'p',
            {
              style:
                'margin:8px 0 0;font-size:12px;color:var(--el-text-color-secondary)',
            },
            `内訳: お手元残高 ${fmtJa(cashInDrawerYen)} 円 − 底銭 ${fmtJa(registerFloatYen)} 円`,
          ),
        ]);
    },
  });

  return ElMessageBox({
    title: '提出前の確認',
    message: h(Body),
    showCancelButton: true,
    confirmButtonText: '提出する',
    cancelButtonText: 'キャンセル',
    distinguishCancelAndClose: true,
    beforeClose: (action, _instance, done) => {
      if (action === 'confirm' && !agreedForGate) {
        ElMessage.warning('底銭の内容にチェックを入れてください');
        return;
      }
      done();
    },
  }).then(() => undefined);
}
