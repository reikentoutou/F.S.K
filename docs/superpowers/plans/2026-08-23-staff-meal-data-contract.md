# 网管餐费数据契约实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 NestJS、SQLite、Vue 账务系统中完整加入网管餐费现金与支付宝字段，使现金餐费进入现金入金但不进入实际销售，支付宝独立保存且不进入实际销售，并同步覆盖填报、确认、明细、统计、Excel/PDF 与旧数据兼容。

**Architecture:** `DailyReport` 只保存 `staffMealCashYen` 和 `staffMealAlipayYen` 两个原始日元整数字段，`staffMealTotalYen` 始终即时派生；服务端继续独占 `cashDepositYen`、`totalSalesYen` 和 `deviationYen` 的权威计算。API 与 Web 使用同名纯函数和同一组测试向量，统计与导出从两个原始字段汇总，避免把派生合计持久化或把支付宝误算入营业销售。

**Tech Stack:** NestJS 10、Prisma 6、SQLite、class-validator、Vue 3 `<script setup>`、Element Plus、TypeScript strict、pnpm 9、Vitest 3、ExcelJS、Puppeteer。

**Spec:** `docs/superpowers/specs/2026-08-23-fsk-amplify-gen2-migration-design.md`

## Global Constraints

- 本计划只实现总体设计的阶段 A；不得创建或修改 Amplify、Cognito、RDS、S3、Functions、PWA、Manifest、Service Worker 或部署资源。
- 本地角色继续使用 `ADMIN`、`WEBMASTER`；`WEBMASTER → KITCHEN` 只在后续 Cognito 迁移阶段执行。
- `DailyReport.staffMealCashYen` 与 `DailyReport.staffMealAlipayYen` 都是日元整数，允许范围为 `0..2_000_000_000`，数据库默认值为 `0`。
- `staffMealTotalYen = staffMealCashYen + staffMealAlipayYen`，它是派生值，不增加数据库列，也不接受客户端作为权威字段提交。
- `cashDepositYen = cashTotalYen - registerFloatYen`，现金餐费不从现金入金金额中扣除。
- `totalSalesYen = newageYen + cashDepositYen - staffMealCashYen`，支付宝餐费和餐费合计都不得加入或再次扣减实际销售。
- `deviationYen = totalSalesYen + expenseYen - imosSalesYen`；`expenseYen` 与网管餐费继续保持独立。
- 旧日报通过 Prisma 的非空默认值自动获得两个 `0`，不得改写旧日报的其他金额、快照、ID 或外键。
- 日报确认页、管理员日报明细、统计、Excel 与 PDF 必须同时展示现金、支付宝及合计。
- “明细”是按业务日、班次、日报展示两种支付方式；不得增加逐人或逐餐子表。
- 修改 `apps/web` 前必须完整阅读 `.agents/skills/vue-best-practices/SKILL.md`；编写 Web 测试前还必须阅读 `.agents/skills/vue-testing-best-practices/SKILL.md`。
- 不引入新的前端测试框架；确认页和 Element Plus 布局通过 strict typecheck、生产 build 与人工验收覆盖。
- 每个任务只提交其 `Files` 列出的文件；不提交本地 SQLite 数据库、生成的导出文件或无关工作区改动。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `apps/api/src/calc/daily-report-calc.ts` | 服务端网管餐费合计与权威销售公式 |
| `apps/api/test/daily-report-calc.spec.ts` | 服务端公式、零值兼容与支付宝隔离测试 |
| `apps/api/prisma/schema.prisma` | SQLite 最终两项原始字段与默认值 |
| `apps/api/src/daily-reports/daily-reports.controller.ts` | 创建/更新 DTO 的整数范围验证 |
| `apps/api/src/daily-reports/daily-reports.service.ts` | 原始字段持久化与服务器派生金额重算 |
| `apps/api/test/daily-report-dto.spec.ts` | 新字段 `0`、上界、负数和超上界验证 |
| `apps/api/test/daily-reports-staff-meal.spec.ts` | 创建、更新和伪造派生金额覆盖测试 |
| `apps/web/src/utils/daily-report-calc.ts` | Web 预览使用的同契约纯函数 |
| `apps/web/src/utils/daily-report-calc.spec.ts` | Web 与 API 共用测试向量 |
| `apps/web/src/components/daily-report/daily-report-form.types.ts` | 表单字段类型 |
| `apps/web/src/composables/useDailyReportFormState.ts` | 默认值、旧日报加载与提交 payload |
| `apps/web/src/composables/useDailyReportPreview.ts` | 两项餐费和修订后销售的响应式预览 |
| `apps/web/src/composables/useDailyReportFormState.spec.ts` | 默认、加载、重置和 payload 测试 |
| `apps/web/src/utils/daily-report-form-validate.ts` | 前端整数/范围校验 |
| `apps/web/src/utils/daily-report-form-validate.spec.ts` | 两项餐费非法值拦截测试 |
| `apps/web/src/components/daily-report/DailyReportSalesFields.vue` | 支出下方的两项输入框、合计与公式提示 |
| `apps/web/src/components/daily-report/DailyReportFormFields.vue` | 预览类型透传 |
| `apps/web/src/components/daily-report/DailyReportConfirmSummary.vue` | 提交前显示现金、支付宝和合计 |
| `apps/web/src/views/wm/DailyFormView.vue` | 网管确认页传入餐费字段 |
| `apps/web/src/views/admin/AdminReportFormView.vue` | 管理员确认页传入餐费字段 |
| `apps/api/src/analytics/analytics.service.ts` | 全局与按班次的三项餐费汇总 |
| `apps/api/test/analytics-staff-meal.spec.ts` | 统计总计、班次汇总和明细原值测试 |
| `apps/web/src/views/admin/AdminDailyView.vue` | 管理员日报列表餐费明细 |
| `apps/web/src/views/admin/AnalyticsView.vue` | 单日明细、总计和按班次汇总展示 |
| `apps/api/src/export/export-report-data.ts` | Excel/PDF 共用的可测试行数据构造 |
| `apps/api/test/export-report-data.spec.ts` | 日报明细、总计、班次合计导出内容测试 |
| `apps/api/src/export/export.service.ts` | Excel/PDF 接入共用导出行数据 |

---

### Task 1: 锁定 API 与 Web 的网管餐费公式

**Files:**
- Create: `apps/api/test/daily-report-calc.spec.ts`
- Modify: `apps/api/src/calc/daily-report-calc.ts:15-55`
- Modify: `apps/web/src/utils/daily-report-calc.spec.ts:1-44`
- Modify: `apps/web/src/utils/daily-report-calc.ts:15-55`

**Interfaces:**
- Consumes: 现有 `cashDepositYen()`、`deviationYen()`。
- Produces: `staffMealTotalYen(staffMealCashYen: number, staffMealAlipayYen: number): number`；`actualSalesYen(newageYen: number, cashTotalYen: number, registerFloatYen: number, staffMealCashYen?: number): number`；`computeDailyReportTotals()` 新增可省略输入 `staffMealCashYen` 并按 `0` 兼容现有调用，返回结构仍只包含四个数据库派生字段。

- [ ] **Step 1: 写 API 公式失败测试**

创建 `apps/api/test/daily-report-calc.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  actualSalesYen,
  cashDepositYen,
  computeDailyReportTotals,
  deviationYen,
  imosSalesYen,
  staffMealTotalYen,
} from '../src/calc/daily-report-calc';

describe('daily report calc with staff meals', () => {
  it('keeps staff meal cash inside cash deposit but removes it from actual sales', () => {
    expect(cashDepositYen(20_000, 5_000)).toBe(15_000);
    expect(actualSalesYen(8_000, 20_000, 5_000, 1_200)).toBe(21_800);
  });

  it('derives the staff meal total without storing it in report totals', () => {
    expect(staffMealTotalYen(1_200, 800)).toBe(2_000);
    expect(
      computeDailyReportTotals({
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 32_000,
        newageYen: 8_000,
        cashTotalYen: 20_000,
        expenseYen: 1_000,
        registerFloatYen: 5_000,
        staffMealCashYen: 1_200,
      }),
    ).toEqual({
      imosSalesYen: 22_000,
      totalSalesYen: 21_800,
      cashDepositYen: 15_000,
      deviationYen: 800,
    });
  });

  it('preserves the previous result when staff meal cash is zero', () => {
    expect(actualSalesYen(8_000, 20_000, 5_000)).toBe(23_000);
    expect(imosSalesYen(10_000, 32_000)).toBe(22_000);
    expect(deviationYen(23_000, 1_000, 22_000)).toBe(2_000);
  });
});
```

- [ ] **Step 2: 更新 Web 测试为同一测试向量**

将 `apps/web/src/utils/daily-report-calc.spec.ts` 替换为：

```ts
import { describe, expect, it } from 'vitest';
import {
  actualSalesYen,
  cashDepositYen,
  computeDailyReportTotals,
  deviationYen,
  imosSalesYen,
  staffMealTotalYen,
} from './daily-report-calc';

describe('daily report calc with staff meals', () => {
  it('computes Imos sales and cash deposit without changing cash deposit for meals', () => {
    expect(imosSalesYen(10_000, 32_000)).toBe(22_000);
    expect(cashDepositYen(20_000, 5_000)).toBe(15_000);
  });

  it('subtracts only staff meal cash from actual sales', () => {
    expect(actualSalesYen(8_000, 20_000, 5_000, 1_200)).toBe(21_800);
    expect(staffMealTotalYen(1_200, 800)).toBe(2_000);
  });

  it('returns only the stored server totals', () => {
    expect(
      computeDailyReportTotals({
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 32_000,
        newageYen: 8_000,
        cashTotalYen: 20_000,
        expenseYen: 1_000,
        registerFloatYen: 5_000,
        staffMealCashYen: 1_200,
      }),
    ).toEqual({
      imosSalesYen: 22_000,
      totalSalesYen: 21_800,
      cashDepositYen: 15_000,
      deviationYen: 800,
    });
  });

  it('keeps old reports unchanged when both meal fields are zero', () => {
    expect(actualSalesYen(8_000, 20_000, 5_000)).toBe(23_000);
    expect(staffMealTotalYen(0, 0)).toBe(0);
    expect(deviationYen(23_000, 1_000, 22_000)).toBe(2_000);
  });
});
```

- [ ] **Step 3: 运行测试并确认新接口尚不存在**

Run:

```bash
pnpm --filter @finance/api test -- test/daily-report-calc.spec.ts
pnpm --filter @finance/web test -- src/utils/daily-report-calc.spec.ts
```

Expected: 两端都 FAIL，错误包含 `staffMealTotalYen` 未导出、`actualSalesYen` 参数数量不符或 `staffMealCashYen` 不在输入类型中。

- [ ] **Step 4: 在 API 和 Web 实现完全一致的纯函数**

在两个 `daily-report-calc.ts` 中加入：

```ts
export function staffMealTotalYen(
  staffMealCashYen: number,
  staffMealAlipayYen: number,
): number {
  return staffMealCashYen + staffMealAlipayYen;
}
```

将两个文件中的 `actualSalesYen` 改为：

```ts
export function actualSalesYen(
  newageYen: number,
  cashTotalYen: number,
  registerFloatYen: number,
  staffMealCashYen = 0,
): number {
  return (
    newageYen +
    cashDepositYen(cashTotalYen, registerFloatYen) -
    staffMealCashYen
  );
}
```

在两个文件的 `computeDailyReportTotals` 输入类型加入可选字段，使 Task 1 提交后现有服务和 composable 仍能编译，并在 Task 2/3 显式传入新值：

```ts
staffMealCashYen?: number;
```

并把内部调用改为：

```ts
const actualSales = actualSalesYen(
  data.newageYen,
  data.cashTotalYen,
  data.registerFloatYen,
  data.staffMealCashYen ?? 0,
);
```

保持返回值严格为：

```ts
return {
  imosSalesYen: imosSales,
  totalSalesYen: actualSales,
  cashDepositYen: cashDeposit,
  deviationYen: deviationYen(actualSales, data.expenseYen, imosSales),
};
```

不得把 `staffMealTotalYen` 放进这个返回对象，因为 `DailyReportsService` 会把该对象直接展开到 Prisma `data`，数据库没有这个列。

- [ ] **Step 5: 运行公式测试并确认通过**

Run:

```bash
pnpm --filter @finance/api test -- test/daily-report-calc.spec.ts
pnpm --filter @finance/web test -- src/utils/daily-report-calc.spec.ts
pnpm run typecheck
pnpm run build
```

Expected: API 3 个测试、Web 4 个测试全部 PASS；现有 API/Web 调用按现金餐费 `0` 保持兼容；两端 strict typecheck 和 build 都成功。

- [ ] **Step 6: 提交公式契约**

```bash
git add apps/api/src/calc/daily-report-calc.ts apps/api/test/daily-report-calc.spec.ts apps/web/src/utils/daily-report-calc.ts apps/web/src/utils/daily-report-calc.spec.ts
git commit -m "feat: 定义网管餐费计算契约"
```

---

### Task 2: 增加 SQLite 字段、DTO 边界和服务端权威持久化

**Files:**
- Modify: `apps/api/prisma/schema.prisma:69-78`
- Modify: `apps/api/src/daily-reports/daily-reports.controller.ts:22-112`
- Modify: `apps/api/src/daily-reports/daily-reports.service.ts:20-239`
- Create: `apps/api/test/daily-report-dto.spec.ts`
- Create: `apps/api/test/daily-reports-staff-meal.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `computeDailyReportTotals({ ..., staffMealCashYen })`。
- Produces: Prisma `DailyReport.staffMealCashYen`、`DailyReport.staffMealAlipayYen`；创建 DTO 两项必填、更新 DTO 两项可选；create/update 返回值包含两项原始字段和服务器重算后的派生字段。

- [ ] **Step 1: 写 DTO 范围失败测试**

创建 `apps/api/test/daily-report-dto.spec.ts`：

```ts
import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  CreateDailyReportDto,
  UpdateDailyReportDto,
} from '../src/daily-reports/daily-reports.controller';

function createDto(overrides: Partial<CreateDailyReportDto> = {}) {
  return Object.assign(new CreateDailyReportDto(), {
    reportDate: '2026-08-23',
    shiftId: 'shift-1',
    responsiblePersonId: 'person-1',
    startMinuteOfDay: 540,
    endMinuteOfDay: 1080,
    previousImosBalanceYen: 10_000,
    currentImosBalanceYen: 32_000,
    newageYen: 8_000,
    cashTotalYen: 20_000,
    expenseYen: 1_000,
    expenseReason: '備品',
    staffMealCashYen: 0,
    staffMealAlipayYen: 2_000_000_000,
    ...overrides,
  });
}

describe('daily report staff meal DTO', () => {
  it('accepts zero and the exact upper bound', async () => {
    await expect(validate(createDto())).resolves.toHaveLength(0);
  });

  it.each([
    ['staffMealCashYen', -1],
    ['staffMealCashYen', 2_000_000_001],
    ['staffMealAlipayYen', -1],
    ['staffMealAlipayYen', 2_000_000_001],
  ] as const)('rejects %s=%d', async (property, value) => {
    const errors = await validate(createDto({ [property]: value }));
    expect(errors.map((error) => error.property)).toContain(property);
  });

  it('applies the same range to optional update fields', async () => {
    const dto = Object.assign(new UpdateDailyReportDto(), {
      staffMealCashYen: 2_000_000_001,
      staffMealAlipayYen: -1,
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property).sort()).toEqual([
      'staffMealAlipayYen',
      'staffMealCashYen',
    ]);
  });
});
```

- [ ] **Step 2: 写服务端重算与持久化失败测试**

创建 `apps/api/test/daily-reports-staff-meal.spec.ts`：

```ts
import { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DailyReportsService } from '../src/daily-reports/daily-reports.service';
import { PrismaService } from '../src/prisma/prisma.service';

function createHarness() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'report-1',
    ...data,
  }));
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'report-1',
    ...data,
  }));
  type FindUnique = (
    args: unknown,
  ) => Promise<Record<string, unknown> | null>;
  const dailyReportFindUnique = vi.fn<FindUnique>().mockResolvedValue(null);
  const prisma = {
    user: { findFirst: vi.fn() },
    shift: { findUnique: vi.fn().mockResolvedValue({ id: 'shift-1', name: '白班', active: true }) },
    responsiblePerson: {
      findFirst: vi.fn().mockResolvedValue({ id: 'person-1', name: '厨房', active: true }),
      findUnique: vi.fn().mockResolvedValue({ id: 'person-1', name: '厨房', active: true }),
    },
    appSettings: { findUnique: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }) },
    dailyReport: {
      findUnique: dailyReportFindUnique,
      findFirst: vi.fn().mockResolvedValue(null),
      create,
      update,
    },
  } as unknown as PrismaService;
  return { service: new DailyReportsService(prisma), create, update, dailyReportFindUnique };
}

const baseDto = {
  reportDate: '2026-08-23',
  shiftId: 'shift-1',
  responsiblePersonId: 'person-1',
  startMinuteOfDay: 540,
  endMinuteOfDay: 1080,
  previousImosBalanceYen: 10_000,
  currentImosBalanceYen: 32_000,
  newageYen: 8_000,
  cashTotalYen: 20_000,
  expenseYen: 1_000,
  expenseReason: '備品',
  staffMealCashYen: 1_200,
  staffMealAlipayYen: 800,
};

describe('DailyReportsService staff meals', () => {
  it('persists both raw fields and overwrites forged derived amounts on create', async () => {
    const { service, create } = createHarness();
    const forged = {
      ...baseDto,
      totalSalesYen: 999_999,
      cashDepositYen: 999_999,
      deviationYen: 999_999,
      staffMealTotalYen: 999_999,
    };

    await service.create(
      { userId: 'wm-1', role: Role.WEBMASTER },
      forged,
    );

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        cashDepositYen: 15_000,
        totalSalesYen: 21_800,
        deviationYen: 800,
      }),
    });
    const written = create.mock.calls[0]?.[0].data;
    expect(written).not.toHaveProperty('staffMealTotalYen');
  });

  it('uses stored values for omitted update fields and recalculates after a cash-meal edit', async () => {
    const { service, update, dailyReportFindUnique } = createHarness();
    dailyReportFindUnique.mockResolvedValueOnce({
      id: 'report-1',
      ...baseDto,
      shiftNameSnapshot: '白班',
      responsiblePersonSnapshot: '厨房',
      timeRangeLabelSnapshot: '09:00 - 18:00',
      imosSalesYen: 22_000,
      totalSalesYen: 21_800,
      cashDepositYen: 15_000,
      deviationYen: 800,
      status: 'approved',
      createdByUserId: 'wm-1',
    });

    await service.update(
      { userId: 'admin-1', role: Role.ADMIN },
      'report-1',
      { staffMealCashYen: 2_000 },
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: 'report-1' },
      data: expect.objectContaining({
        staffMealCashYen: 2_000,
        staffMealAlipayYen: 800,
        cashDepositYen: 15_000,
        totalSalesYen: 21_000,
        deviationYen: 0,
      }),
    });
  });
});
```

- [ ] **Step 3: 运行测试并确认 schema、DTO 和服务尚不支持字段**

Run:

```bash
pnpm --filter @finance/api test -- test/daily-report-dto.spec.ts test/daily-reports-staff-meal.spec.ts
```

Expected: FAIL，至少包含 DTO 类未导出、DTO 缺少新字段、服务没有持久化原始字段或服务端结果仍为旧公式。

- [ ] **Step 4: 修改 Prisma schema 并重新生成 Client**

在 `expenseReason` 后加入：

```prisma
  /// 网管餐费现金：包含在钱箱现金中，但不属于实际销售
  staffMealCashYen          Int @default(0)
  /// 网管餐费支付宝：独立保存，不进入现金入金或实际销售
  staffMealAlipayYen        Int @default(0)
```

把 `totalSalesYen` 上方注释更新为：

```prisma
  /// 実際売上 = Newage売上 + お手元残高 - 底銭 - 网管餐费现金
```

Run:

```bash
pnpm run db:generate
```

Expected: Prisma Client generation succeeds and `DailyReport` types expose both fields.

- [ ] **Step 5: 导出 DTO 并加入精确范围验证**

把类声明改为：

```ts
export class CreateDailyReportDto {
```

```ts
export class UpdateDailyReportDto {
```

在创建 DTO 的 `expenseReason` 后加入：

```ts
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  staffMealCashYen!: number;

  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  staffMealAlipayYen!: number;
```

在更新 DTO 的 `expenseReason` 后加入：

```ts
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  staffMealCashYen?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  staffMealAlipayYen?: number;
```

- [ ] **Step 6: 接入 create/update 服务且只保存两个原始字段**

在 `computeAndValidate` 的 `data` 类型加入：

```ts
staffMealCashYen: number;
```

在调用 `computeDailyReportTotals` 时加入：

```ts
staffMealCashYen: data.staffMealCashYen,
```

在 `create` 的 DTO 类型中加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

在 create 的 `computeAndValidate` 输入中加入：

```ts
staffMealCashYen: dto.staffMealCashYen,
```

在 Prisma create `data` 中、`...computed` 之前加入：

```ts
staffMealCashYen: dto.staffMealCashYen,
staffMealAlipayYen: dto.staffMealAlipayYen,
```

在 `update` 的 Partial 类型中加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

在 `next` 中加入：

```ts
staffMealCashYen: dto.staffMealCashYen ?? row.staffMealCashYen,
staffMealAlipayYen: dto.staffMealAlipayYen ?? row.staffMealAlipayYen,
```

在 update 的 `computeAndValidate` 输入中加入：

```ts
staffMealCashYen: next.staffMealCashYen,
```

在 Prisma update `data` 中、`...computed` 之前加入：

```ts
staffMealCashYen: next.staffMealCashYen,
staffMealAlipayYen: next.staffMealAlipayYen,
```

客户端传入对象即使额外携带 `totalSalesYen`、`cashDepositYen`、`deviationYen` 或 `staffMealTotalYen`，服务也不得读取或展开这些字段。

- [ ] **Step 7: 运行目标测试、API typecheck 和 build**

Run:

```bash
pnpm --filter @finance/api test -- test/daily-report-calc.spec.ts test/daily-report-dto.spec.ts test/daily-reports-staff-meal.spec.ts
pnpm run typecheck:api
pnpm run build:api
```

Expected: 目标测试全部 PASS；TypeScript 无错误；Nest build 成功。

- [ ] **Step 8: 将字段应用到当前配置的 SQLite 开发库**

先确认 `.env` 中的 `DATABASE_URL` 指向开发/验收副本而不是唯一生产文件，然后执行：

```bash
pnpm run db:push
```

Expected: Prisma 报告数据库与 schema 同步；现有行因为 `@default(0)` 获得两个非空 `0`，没有要求重置数据库。

- [ ] **Step 9: 提交 schema、DTO、服务和测试**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/daily-reports/daily-reports.controller.ts apps/api/src/daily-reports/daily-reports.service.ts apps/api/test/daily-report-dto.spec.ts apps/api/test/daily-reports-staff-meal.spec.ts
git commit -m "feat(api): 持久化网管餐费字段"
```

---

### Task 3: 扩展 Web 表单状态、预览、提交 DTO 和前端边界校验

**Files:**
- Modify: `apps/web/src/components/daily-report/daily-report-form.types.ts:1-12`
- Modify: `apps/web/src/composables/useDailyReportFormState.ts:5-105`
- Modify: `apps/web/src/composables/useDailyReportPreview.ts:1-26`
- Modify: `apps/web/src/utils/daily-report-form-validate.ts:1-73`
- Create: `apps/web/src/composables/useDailyReportFormState.spec.ts`
- Create: `apps/web/src/utils/daily-report-form-validate.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `staffMealTotalYen()` 与 `computeDailyReportTotals()`。
- Produces: `form.staffMealCashYen`、`form.staffMealAlipayYen`；payload 同名字段；preview 的 `staffMealTotalYen`；`MAX_DAILY_REPORT_AMOUNT_YEN = 2_000_000_000`。

- [ ] **Step 1: 阅读 Vue 实现与测试技能**

Run:

```bash
sed -n '1,260p' .agents/skills/vue-best-practices/SKILL.md
sed -n '1,320p' .agents/skills/vue-testing-best-practices/SKILL.md
```

Expected: 两个文件完整读到末尾；若仓库本地技能目录不存在，则读取本机技能目录中同名 `SKILL.md`，并继续遵守本计划的文件范围。

- [ ] **Step 2: 写表单状态失败测试**

创建 `apps/web/src/composables/useDailyReportFormState.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { useDailyReportFormState } from './useDailyReportFormState';

describe('useDailyReportFormState staff meals', () => {
  it('defaults, resets, and submits both fields', () => {
    const state = useDailyReportFormState();
    expect(state.form.staffMealCashYen).toBe(0);
    expect(state.form.staffMealAlipayYen).toBe(0);

    state.form.responsiblePersonId = 'person-1';
    state.form.staffMealCashYen = 1_200;
    state.form.staffMealAlipayYen = 800;
    expect(state.buildPayload('2026-08-23', 'shift-1')).toMatchObject({
      staffMealCashYen: 1_200,
      staffMealAlipayYen: 800,
    });

    state.reset();
    expect(state.form.staffMealCashYen).toBe(0);
    expect(state.form.staffMealAlipayYen).toBe(0);
  });

  it('loads old report-shaped data as zero when meal fields are absent', () => {
    const state = useDailyReportFormState();
    state.applyExisting({
      responsiblePersonId: 'person-1',
      startMinuteOfDay: 540,
      endMinuteOfDay: 1080,
      previousImosBalanceYen: 10_000,
      currentImosBalanceYen: 32_000,
      newageYen: 8_000,
      cashTotalYen: 20_000,
      expenseYen: 0,
      expenseReason: null,
    });
    expect(state.form.staffMealCashYen).toBe(0);
    expect(state.form.staffMealAlipayYen).toBe(0);
  });
});
```

- [ ] **Step 3: 写前端范围校验失败测试**

创建 `apps/web/src/utils/daily-report-form-validate.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_DAILY_REPORT_AMOUNT_YEN,
  validateDailyReportGoToConfirm,
  validateDailyReportSubmit,
} from './daily-report-form-validate';

type ValidationForm = Parameters<
  typeof validateDailyReportSubmit
>[0]['form'];

function form(overrides: Partial<ValidationForm> = {}): ValidationForm {
  return {
    responsiblePersonId: 'person-1',
    startStr: '09:00',
    endStr: '18:00',
    cashInDrawerYen: 20_000,
    expenseYen: 0,
    expenseReason: '',
    expenseReceiptStored: true,
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
    ...overrides,
  };
}

describe('daily report staff meal validation', () => {
  it('accepts integer bounds in both validation stages', () => {
    const valid = form({
      staffMealCashYen: 0,
      staffMealAlipayYen: MAX_DAILY_REPORT_AMOUNT_YEN,
    });
    expect(validateDailyReportGoToConfirm({ form: valid })).toBeNull();
    expect(validateDailyReportSubmit({ form: valid })).toBeNull();
  });

  it.each([-1, 1.5, 2_000_000_001, Number.NaN])(
    'rejects invalid staff meal cash %s before confirmation and submit',
    (value) => {
      const invalid = form({ staffMealCashYen: value });
      expect(validateDailyReportGoToConfirm({ form: invalid })).toBe(
        '网管餐費は0〜2,000,000,000円の整数で入力してください',
      );
      expect(validateDailyReportSubmit({ form: invalid })).toBe(
        '网管餐費は0〜2,000,000,000円の整数で入力してください',
      );
    },
  );

  it('rejects invalid Alipay amount', () => {
    expect(
      validateDailyReportSubmit({
        form: form({ staffMealAlipayYen: 2_000_000_001 }),
      }),
    ).toBe('网管餐費は0〜2,000,000,000円の整数で入力してください');
  });
});
```

- [ ] **Step 4: 运行测试并确认表单接口尚不存在**

Run:

```bash
pnpm --filter @finance/web test -- src/composables/useDailyReportFormState.spec.ts src/utils/daily-report-form-validate.spec.ts
```

Expected: FAIL，错误包含餐费字段或 `MAX_DAILY_REPORT_AMOUNT_YEN` 不存在。

- [ ] **Step 5: 扩展表单类型、默认值、旧数据和 payload**

在 `DailyReportFormFieldsModel` 中、`expenseYen` 前加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

在 `DailyReportFormPayload` 中加入必填字段：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

在 `DailyReportExistingData` 中加入可选字段，以兼容前后端短暂版本错位和旧 fixture：

```ts
staffMealCashYen?: number;
staffMealAlipayYen?: number;
```

在 reactive 初值与 `reset()` 中都设为：

```ts
form.staffMealCashYen = 0;
form.staffMealAlipayYen = 0;
```

其中 reactive 对象的初值直接写成：

```ts
staffMealCashYen: 0,
staffMealAlipayYen: 0,
```

在 `applyExisting()` 中加入：

```ts
form.staffMealCashYen = data.staffMealCashYen ?? 0;
form.staffMealAlipayYen = data.staffMealAlipayYen ?? 0;
```

在 `buildPayload()` 返回对象中加入：

```ts
staffMealCashYen: form.staffMealCashYen,
staffMealAlipayYen: form.staffMealAlipayYen,
```

- [ ] **Step 6: 扩展响应式预览且不提交派生合计**

将 import 改为：

```ts
import {
  computeDailyReportTotals,
  staffMealTotalYen as computeStaffMealTotalYen,
} from '@/utils/daily-report-calc';
```

在 `FormSlice` 加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

把 computed 函数体改为：

```ts
return computed(() => {
  const totals = computeDailyReportTotals({
    previousImosBalanceYen: form.previousImosBalanceYen,
    currentImosBalanceYen: form.currentImosBalanceYen,
    newageYen: form.newageYen,
    cashTotalYen: form.cashInDrawerYen,
    expenseYen: form.expenseYen,
    registerFloatYen: registerFloatAmount.value,
    staffMealCashYen: form.staffMealCashYen,
  });
  return {
    ...totals,
    staffMealTotalYen: computeStaffMealTotalYen(
      form.staffMealCashYen,
      form.staffMealAlipayYen,
    ),
  };
});
```

- [ ] **Step 7: 在确认和正式提交前执行同一范围校验**

在 `daily-report-form-validate.ts` 顶部加入：

```ts
export const MAX_DAILY_REPORT_AMOUNT_YEN = 2_000_000_000;

function validStaffMealAmount(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DAILY_REPORT_AMOUNT_YEN
  );
}

function staffMealValidationError(form: FormSlice): string | null {
  if (
    !validStaffMealAmount(form.staffMealCashYen) ||
    !validStaffMealAmount(form.staffMealAlipayYen)
  ) {
    return '网管餐費は0〜2,000,000,000円の整数で入力してください';
  }
  return null;
}
```

在 `FormSlice` 加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

在两个导出校验函数中，完成责任人/管理员必填校验后、支出校验前加入：

```ts
const staffMealError = staffMealValidationError(form);
if (staffMealError) return staffMealError;
```

- [ ] **Step 8: 运行 Web 目标测试和 typecheck**

Run:

```bash
pnpm --filter @finance/web test -- src/utils/daily-report-calc.spec.ts src/composables/useDailyReportFormState.spec.ts src/utils/daily-report-form-validate.spec.ts
pnpm run typecheck:web
```

Expected: 所有目标测试 PASS；Web strict typecheck 也必须 PASS。`useDailyReportPreview` 返回值可以结构化赋给现有较窄的 preview prop，Task 4 再显式扩展组件 prop 并读取合计。

- [ ] **Step 9: 提交 Web 状态与校验**

```bash
git add apps/web/src/components/daily-report/daily-report-form.types.ts apps/web/src/composables/useDailyReportFormState.ts apps/web/src/composables/useDailyReportPreview.ts apps/web/src/composables/useDailyReportFormState.spec.ts apps/web/src/utils/daily-report-form-validate.ts apps/web/src/utils/daily-report-form-validate.spec.ts
git commit -m "feat(web): 接入网管餐费表单状态"
```

---

### Task 4: 在支出下方增加两项输入并完善确认页

**Files:**
- Modify: `apps/web/src/components/daily-report/DailyReportSalesFields.vue:6-261`
- Modify: `apps/web/src/components/daily-report/DailyReportFormFields.vue:11-26`
- Modify: `apps/web/src/components/daily-report/DailyReportConfirmSummary.vue:4-109`
- Modify: `apps/web/src/views/wm/DailyFormView.vue:207-221`
- Modify: `apps/web/src/views/admin/AdminReportFormView.vue:230-246`

**Interfaces:**
- Consumes: Task 3 的两个 form 字段、`preview.staffMealTotalYen` 和 `MAX_DAILY_REPORT_AMOUNT_YEN`。
- Produces: 支出下方的“网管餐费”现金/支付宝输入，确认页三行餐费信息，修正后的实际销售说明。

- [ ] **Step 1: 给表单组件加入预览类型和最大金额常量**

在 `DailyReportSalesFields.vue` 导入：

```ts
import { MAX_DAILY_REPORT_AMOUNT_YEN } from '@/utils/daily-report-form-validate';
```

在 `DailyReportSalesFields.vue`、`DailyReportFormFields.vue` 和 `DailyReportConfirmSummary.vue` 的 preview 类型中加入：

```ts
staffMealTotalYen: number;
```

- [ ] **Step 2: 在支出后、总计前增加网管餐费输入区**

在 `DailyReportSalesFields.vue` 的支出 `</el-form-item>` 后插入：

```vue
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
```

把实际销售说明从 `Imos売上とNewage売上の合計です。` 改为：

```vue
<p class="field-guide result-guide">
  Newage売上 + 現金入金金額 − 网管餐費（現金）です。
</p>
```

在 scoped style 中加入：

```css
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
```

在现有 `@media (max-width: 560px)` 内加入：

```css
.staff-meal-grid {
  grid-template-columns: 1fr;
}
```

- [ ] **Step 3: 在确认摘要展示两个原始值与合计**

在 `DailyReportConfirmSummary.vue` props 中加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

在支出理由之后插入：

```vue
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
```

- [ ] **Step 4: 在网管和管理员确认页传入原始字段**

在两个 `DailyReportConfirmSummary` 调用中、`expense-reason` 后加入：

```vue
:staff-meal-cash-yen="form.staffMealCashYen"
:staff-meal-alipay-yen="form.staffMealAlipayYen"
```

- [ ] **Step 5: 运行 Web 测试、typecheck 和 build**

Run:

```bash
pnpm --filter @finance/web test
pnpm run typecheck:web
pnpm run build:web
```

Expected: 全部 Web Vitest PASS；`vue-tsc` 无错误；Vite production build 成功。

- [ ] **Step 6: 人工验证填报与确认闭环**

Run:

```bash
pnpm run dev
```

在浏览器分别用网管和管理员流程输入：底钱 `5,000`、手头现金 `20,000`、Newage `8,000`、现金餐费 `1,200`、支付宝餐费 `800`、Imos 前值 `10,000`、现值 `32,000`、支出 `1,000`。Expected:

- “网管餐费”严格位于“支出”下方。
- 现金和支付宝是两个独立金额框，合计显示 `2,000 円`。
- 现金入金显示 `15,000 円`，没有因现金餐费减少。
- 实际销售显示 `21,800 円`，支付宝没有加入或再次扣减。
- 偏差显示 `800 円`。
- 确认页同时显示现金 `1,200 円`、支付宝 `800 円`、合计 `2,000 円`。
- 手机宽度下三个餐费单元纵向排列，无水平溢出，提交按钮仍可见。

- [ ] **Step 7: 提交填报和确认 UI**

```bash
git add apps/web/src/components/daily-report/DailyReportSalesFields.vue apps/web/src/components/daily-report/DailyReportFormFields.vue apps/web/src/components/daily-report/DailyReportConfirmSummary.vue apps/web/src/views/wm/DailyFormView.vue apps/web/src/views/admin/AdminReportFormView.vue
git commit -m "feat(web): 添加网管餐费填报与确认"
```

---

### Task 5: 在 API 统计中同步现金、支付宝和合计

**Files:**
- Modify: `apps/api/src/analytics/analytics.service.ts:1-84`
- Create: `apps/api/test/analytics-staff-meal.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `staffMealTotalYen()`；Task 2 的 Prisma 两项字段。
- Produces: `summary.totals` 与每个 `summary.byShift[]` 都包含 `staffMealCashYen`、`staffMealAlipayYen`、`staffMealTotalYen`；`summary.rows` 保留逐日报原始字段。

- [ ] **Step 1: 写统计失败测试**

创建 `apps/api/test/analytics-staff-meal.spec.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('AnalyticsService staff meal summary', () => {
  it('returns raw methods and derived total globally and by shift', async () => {
    const rows = [
      {
        id: 'r1',
        reportDate: '2026-08-23',
        shiftId: 'day',
        shiftNameSnapshot: '白班',
        totalSalesYen: 21_800,
        imosSalesYen: 22_000,
        expenseYen: 1_000,
        cashDepositYen: 15_000,
        deviationYen: 800,
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        shift: { sortOrder: 2 },
        createdBy: { username: 'kitchen' },
      },
      {
        id: 'r2',
        reportDate: '2026-08-23',
        shiftId: 'night',
        shiftNameSnapshot: '夜班',
        totalSalesYen: 10_000,
        imosSalesYen: 9_000,
        expenseYen: 0,
        cashDepositYen: 10_000,
        deviationYen: 1_000,
        staffMealCashYen: 300,
        staffMealAlipayYen: 500,
        shift: { sortOrder: 3 },
        createdBy: { username: 'kitchen' },
      },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = {
      dailyReport: { findMany },
    } as unknown as PrismaService;

    const result = await new AnalyticsService(prisma).summary(
      'day',
      '2026-08-23',
    );

    expect(result.totals).toMatchObject({
      staffMealCashYen: 1_500,
      staffMealAlipayYen: 1_300,
      staffMealTotalYen: 2_800,
      totalSalesYen: 31_800,
    });
    expect(result.byShift).toEqual([
      expect.objectContaining({
        shiftId: 'day',
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        staffMealTotalYen: 2_000,
      }),
      expect.objectContaining({
        shiftId: 'night',
        staffMealCashYen: 300,
        staffMealAlipayYen: 500,
        staffMealTotalYen: 800,
      }),
    ]);
    expect(result.rows[0]).toMatchObject({
      staffMealCashYen: 1_200,
      staffMealAlipayYen: 800,
    });
  });
});
```

- [ ] **Step 2: 运行测试并确认统计字段缺失**

Run:

```bash
pnpm --filter @finance/api test -- test/analytics-staff-meal.spec.ts
```

Expected: FAIL，`totals` 和 `byShift` 不含网管餐费字段。

- [ ] **Step 3: 实现三项统计值**

把 calc import 改为：

```ts
import {
  deviationYenFromStoredFields,
  staffMealTotalYen as computeStaffMealTotalYen,
} from '../calc/daily-report-calc';
```

在 `byShift` value 类型和初始化对象中加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
staffMealTotalYen: number;
```

初始化值全部为 `0`。在全局累计变量中加入：

```ts
let staffMealCashYen = 0;
let staffMealAlipayYen = 0;
let staffMealTotalYen = 0;
```

在循环中、更新 `count` 前加入：

```ts
const rowStaffMealTotalYen = computeStaffMealTotalYen(
  r.staffMealCashYen,
  r.staffMealAlipayYen,
);
byShift[sid].staffMealCashYen += r.staffMealCashYen;
byShift[sid].staffMealAlipayYen += r.staffMealAlipayYen;
byShift[sid].staffMealTotalYen += rowStaffMealTotalYen;
staffMealCashYen += r.staffMealCashYen;
staffMealAlipayYen += r.staffMealAlipayYen;
staffMealTotalYen += rowStaffMealTotalYen;
```

在返回的 `totals` 中加入：

```ts
staffMealCashYen,
staffMealAlipayYen,
staffMealTotalYen,
```

- [ ] **Step 4: 运行统计测试和 API 全量测试**

Run:

```bash
pnpm --filter @finance/api test -- test/analytics-staff-meal.spec.ts
pnpm --filter @finance/api test
pnpm run typecheck:api
```

Expected: 新统计测试与现有 API 测试全部 PASS；TypeScript 无错误。

- [ ] **Step 5: 提交统计 API**

```bash
git add apps/api/src/analytics/analytics.service.ts apps/api/test/analytics-staff-meal.spec.ts
git commit -m "feat(api): 汇总网管餐费统计"
```

---

### Task 6: 在管理员日报明细与统计页面展示餐费

**Files:**
- Modify: `apps/web/src/views/admin/AdminDailyView.vue:9-167`
- Modify: `apps/web/src/views/admin/AnalyticsView.vue:5-294`

**Interfaces:**
- Consumes: Task 2 日报行的两个原始字段；Task 5 的 `totals` 和 `byShift` 三项字段；Task 1 的 `staffMealTotalYen()`。
- Produces: 日报列表按行显示现金、支付宝、合计；统计页显示区间总计、单日逐班明细和按班次合计。

- [ ] **Step 1: 扩展管理员日报类型和合计函数**

在 `AdminDailyView.vue` 的 `Row` 中加入：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

导入：

```ts
import { staffMealTotalYen } from '@/utils/daily-report-calc';
```

增加：

```ts
const totalStaffMealAll = computed(() =>
  rows.value.reduce(
    (sum, row) =>
      sum + staffMealTotalYen(row.staffMealCashYen, row.staffMealAlipayYen),
    0,
  ),
);

function rowStaffMealTotalYen(row: Row): number {
  return staffMealTotalYen(row.staffMealCashYen, row.staffMealAlipayYen);
}
```

在显示期间实际销售合计之后加入：

```vue
<span class="meta-dot" aria-hidden="true">·</span>
网管餐費計 <span class="meta-strong">{{ formatYen(totalStaffMealAll) }}</span>
```

- [ ] **Step 2: 给每份日报加入现金、支付宝和合计列**

在“实际销售”列后加入：

```vue
<el-table-column label="网管餐費（現金）" min-width="138">
  <template #default="{ row }">
    {{ formatYen(row.staffMealCashYen) }}
  </template>
</el-table-column>
<el-table-column label="网管餐費（支付宝）" min-width="148">
  <template #default="{ row }">
    {{ formatYen(row.staffMealAlipayYen) }}
  </template>
</el-table-column>
<el-table-column label="网管餐費合計" min-width="128">
  <template #default="{ row }">
    {{ formatYen(rowStaffMealTotalYen(row)) }}
  </template>
</el-table-column>
```

保留操作列 `fixed="right"`，窄屏通过 Element Plus 表格横向滚动查看金额明细。

- [ ] **Step 3: 扩展统计页类型和区间合计**

在 `DayReportRow` 中只加入两个数据库原始字段：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
```

在 `summary.totals` 和 `summary.byShift` 中加入三个统计字段：

```ts
staffMealCashYen: number;
staffMealAlipayYen: number;
staffMealTotalYen: number;
```

`DayReportRow` 不加入数据库不存在的 `staffMealTotalYen`。把 calc import 改为：

```ts
import {
  deviationYenFromStoredFields,
  staffMealTotalYen as computeStaffMealTotalYen,
} from '@/utils/daily-report-calc';
```

在 `grandTotals` 中初始化、累计并返回：

```ts
let staffMealCashYen = 0;
let staffMealAlipayYen = 0;
let staffMealTotalYen = 0;
```

循环内：

```ts
staffMealCashYen += r.staffMealCashYen;
staffMealAlipayYen += r.staffMealAlipayYen;
staffMealTotalYen += computeStaffMealTotalYen(
  r.staffMealCashYen,
  r.staffMealAlipayYen,
);
```

返回对象加入这三个变量。

- [ ] **Step 4: 展示区间总计、单日明细和班次合计**

在 grand totals 的“支出”后加入：

```vue
<el-descriptions-item label="网管餐費（現金）">
  {{ grandTotals.staffMealCashYen }} 円
</el-descriptions-item>
<el-descriptions-item label="网管餐費（支付宝）">
  {{ grandTotals.staffMealAlipayYen }} 円
</el-descriptions-item>
<el-descriptions-item label="网管餐費合計">
  {{ grandTotals.staffMealTotalYen }} 円
</el-descriptions-item>
```

在单日逐班的“支出理由”后加入：

```vue
<el-descriptions-item label="网管餐費（現金）">
  {{ r.staffMealCashYen }} 円
</el-descriptions-item>
<el-descriptions-item label="网管餐費（支付宝）">
  {{ r.staffMealAlipayYen }} 円
</el-descriptions-item>
<el-descriptions-item label="网管餐費合計">
  {{ computeStaffMealTotalYen(r.staffMealCashYen, r.staffMealAlipayYen) }} 円
</el-descriptions-item>
```

在班次纵表的“支出”后加入：

```vue
<el-descriptions-item label="网管餐費（現金）">{{ b.staffMealCashYen }} 円</el-descriptions-item>
<el-descriptions-item label="网管餐費（支付宝）">{{ b.staffMealAlipayYen }} 円</el-descriptions-item>
<el-descriptions-item label="网管餐費合計">{{ b.staffMealTotalYen }} 円</el-descriptions-item>
```

柱状图继续只读取 `totalSalesYen`，不得把任一餐费序列叠加为销售。

- [ ] **Step 5: 运行 Web 回归并人工核对明细**

Run:

```bash
pnpm --filter @finance/web test
pnpm run typecheck:web
pnpm run build:web
```

Expected: 测试、typecheck、build 全部 PASS。浏览器人工核对 Task 4 的样例日报：管理员日报行显示 `1,200 / 800 / 2,000`；统计总计、单日班次明细、按班次合计完全一致；实际销售仍为 `21,800`。

- [ ] **Step 6: 提交管理员明细与统计 UI**

```bash
git add apps/web/src/views/admin/AdminDailyView.vue apps/web/src/views/admin/AnalyticsView.vue
git commit -m "feat(web): 展示网管餐费明细与统计"
```

---

### Task 7: 让 Excel/PDF 的日报、总计和班次汇总使用同一导出契约

**Files:**
- Create: `apps/api/src/export/export-report-data.ts`
- Create: `apps/api/test/export-report-data.spec.ts`
- Modify: `apps/api/src/export/export.service.ts:8-369`

**Interfaces:**
- Consumes: Task 1 的 `staffMealTotalYen()` 与 `deviationYenFromStoredFields()`；Task 5 的 byShift 三项字段。
- Produces: `aggregateGrandTotalsFromRows()`、`grandTotalPairs()`、`shiftDetailPairs()`、`byShiftSummaryPairs()`；Excel 与 PDF 同时复用这些纯函数。

- [ ] **Step 1: 写导出行数据失败测试**

创建 `apps/api/test/export-report-data.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  aggregateGrandTotalsFromRows,
  byShiftSummaryPairs,
  grandTotalPairs,
  shiftDetailPairs,
  type ExportReportRow,
} from '../src/export/export-report-data';

function row(overrides: Partial<ExportReportRow> = {}): ExportReportRow {
  return {
    reportDate: '2026-08-23',
    shiftNameSnapshot: '白班',
    responsiblePersonSnapshot: '厨房',
    timeRangeLabelSnapshot: '09:00 - 18:00',
    previousImosBalanceYen: 10_000,
    currentImosBalanceYen: 32_000,
    imosSalesYen: 22_000,
    newageYen: 8_000,
    cashTotalYen: 20_000,
    expenseYen: 1_000,
    expenseReason: '備品',
    staffMealCashYen: 1_200,
    staffMealAlipayYen: 800,
    totalSalesYen: 21_800,
    cashDepositYen: 15_000,
    createdBy: { username: 'kitchen' },
    ...overrides,
  };
}

describe('staff meal export data', () => {
  it('puts raw methods and derived total into every report detail', () => {
    expect(shiftDetailPairs(row(), 5_000)).toEqual(
      expect.arrayContaining([
        ['网管餐費（現金）', '1200 円'],
        ['网管餐費（支付宝）', '800 円'],
        ['网管餐費合計', '2000 円'],
        ['実際売上', '21800 円'],
      ]),
    );
  });

  it('aggregates both payment methods without changing stored actual sales', () => {
    const totals = aggregateGrandTotalsFromRows([
      row(),
      row({
        staffMealCashYen: 300,
        staffMealAlipayYen: 500,
        totalSalesYen: 10_000,
        imosSalesYen: 9_000,
        expenseYen: 0,
      }),
    ]);
    expect(totals).toMatchObject({
      staffMealCashYen: 1_500,
      staffMealAlipayYen: 1_300,
      staffMealTotalYen: 2_800,
      totalSalesYen: 31_800,
    });
    expect(grandTotalPairs(totals)).toEqual(
      expect.arrayContaining([
        ['网管餐費（現金）', '1500 円'],
        ['网管餐費（支付宝）', '1300 円'],
        ['网管餐費合計', '2800 円'],
      ]),
    );
  });

  it('adds all three values to each shift summary', () => {
    expect(
      byShiftSummaryPairs({
        count: 2,
        imosSalesYen: 31_000,
        totalSalesYen: 31_800,
        cashDepositYen: 25_000,
        expenseYen: 1_000,
        deviationYen: 1_800,
        staffMealCashYen: 1_500,
        staffMealAlipayYen: 1_300,
        staffMealTotalYen: 2_800,
      }),
    ).toEqual(
      expect.arrayContaining([
        ['网管餐費（現金）', '1500 円'],
        ['网管餐費（支付宝）', '1300 円'],
        ['网管餐費合計', '2800 円'],
      ]),
    );
  });
});
```

- [ ] **Step 2: 运行测试并确认纯函数模块不存在**

Run:

```bash
pnpm --filter @finance/api test -- test/export-report-data.spec.ts
```

Expected: FAIL，错误包含 `Cannot find module '../src/export/export-report-data'`。

- [ ] **Step 3: 创建可测试的导出数据模块**

创建 `apps/api/src/export/export-report-data.ts`：

```ts
import {
  deviationYenFromStoredFields,
  staffMealTotalYen,
} from '../calc/daily-report-calc';

export type ExportReportRow = {
  reportDate: string;
  shiftNameSnapshot: string;
  responsiblePersonSnapshot: string;
  timeRangeLabelSnapshot: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  imosSalesYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  expenseReason: string | null;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  totalSalesYen: number;
  cashDepositYen: number;
  createdBy: { username: string };
};

export type GrandTotalsAgg = {
  imosSalesYen: number;
  newageYen: number;
  cashDepositYen: number;
  expenseYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  staffMealTotalYen: number;
  totalSalesYen: number;
  deviationYen: number;
};

export type ByShiftExportSummary = {
  count: number;
  imosSalesYen: number;
  totalSalesYen: number;
  cashDepositYen: number;
  expenseYen: number;
  deviationYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  staffMealTotalYen: number;
};

export type ExportPair = [string, string | number];

export function aggregateGrandTotalsFromRows(
  rows: ExportReportRow[],
): GrandTotalsAgg {
  const totals: GrandTotalsAgg = {
    imosSalesYen: 0,
    newageYen: 0,
    cashDepositYen: 0,
    expenseYen: 0,
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
    staffMealTotalYen: 0,
    totalSalesYen: 0,
    deviationYen: 0,
  };
  for (const row of rows) {
    totals.imosSalesYen += row.imosSalesYen;
    totals.newageYen += row.newageYen;
    totals.cashDepositYen += row.cashDepositYen;
    totals.expenseYen += row.expenseYen;
    totals.staffMealCashYen += row.staffMealCashYen;
    totals.staffMealAlipayYen += row.staffMealAlipayYen;
    totals.staffMealTotalYen += staffMealTotalYen(
      row.staffMealCashYen,
      row.staffMealAlipayYen,
    );
    totals.totalSalesYen += row.totalSalesYen;
    totals.deviationYen += deviationYenFromStoredFields(row);
  }
  return totals;
}

export function grandTotalPairs(t: GrandTotalsAgg): ExportPair[] {
  return [
    ['Imos売上合計', `${t.imosSalesYen} 円`],
    ['Newage売上', `${t.newageYen} 円`],
    ['現金入金金額', `${t.cashDepositYen} 円`],
    ['支出', `${t.expenseYen} 円`],
    ['网管餐費（現金）', `${t.staffMealCashYen} 円`],
    ['网管餐費（支付宝）', `${t.staffMealAlipayYen} 円`],
    ['网管餐費合計', `${t.staffMealTotalYen} 円`],
    ['実際売上', `${t.totalSalesYen} 円`],
    ['偏差', `${t.deviationYen} 円`],
  ];
}

export function byShiftSummaryPairs(b: ByShiftExportSummary): ExportPair[] {
  return [
    ['件数', b.count],
    ['Imos売上合計', `${b.imosSalesYen} 円`],
    ['実際売上', `${b.totalSalesYen} 円`],
    ['現金入金金額', `${b.cashDepositYen} 円`],
    ['支出', `${b.expenseYen} 円`],
    ['网管餐費（現金）', `${b.staffMealCashYen} 円`],
    ['网管餐費（支付宝）', `${b.staffMealAlipayYen} 円`],
    ['网管餐費合計', `${b.staffMealTotalYen} 円`],
    ['偏差', `${b.deviationYen} 円`],
  ];
}

export function shiftDetailPairs(
  r: ExportReportRow,
  registerFloat: number,
): ExportPair[] {
  return [
    ['日付', r.reportDate],
    ['シフト', r.shiftNameSnapshot],
    ['責任者', r.responsiblePersonSnapshot],
    ['Newage時間', r.timeRangeLabelSnapshot],
    ['前期Imos残高', `${r.previousImosBalanceYen} 円`],
    ['現在Imos残高', `${r.currentImosBalanceYen} 円`],
    ['Imos売上合計', `${r.imosSalesYen} 円`],
    ['Newage売上', `${r.newageYen} 円`],
    ['お手元残高', `${r.cashTotalYen} 円`],
    ['レジ底銭（設定）', `${registerFloat} 円`],
    ['支出', `${r.expenseYen} 円`],
    ['支出理由', r.expenseReason?.trim() || '—'],
    ['网管餐費（現金）', `${r.staffMealCashYen} 円`],
    ['网管餐費（支付宝）', `${r.staffMealAlipayYen} 円`],
    [
      '网管餐費合計',
      `${staffMealTotalYen(r.staffMealCashYen, r.staffMealAlipayYen)} 円`,
    ],
    ['実際売上', `${r.totalSalesYen} 円`],
    ['現金入金金額', `${r.cashDepositYen} 円`],
    ['偏差', `${deviationYenFromStoredFields(r)} 円`],
    ['提出者', r.createdBy.username],
  ];
}
```

- [ ] **Step 4: 让 Excel 和 PDF 全部调用纯函数**

从 `export.service.ts` 删除 `deviationYenFromStoredFields` import、文件内 `GrandTotalsAgg` 类型，以及 `aggregateGrandTotalsFromRows`、`grandTotalPairs`、`shiftDetailPairs` 三个 private helper；保留 `verticalGrandTotalsTableHtml`、`verticalByShiftSummaryHtml` 和 `businessDayShiftSectionHtml` 负责 HTML 拼装。随后导入：

```ts
import {
  aggregateGrandTotalsFromRows,
  byShiftSummaryPairs,
  grandTotalPairs,
  shiftDetailPairs,
  type GrandTotalsAgg,
} from './export-report-data';
```

将调用精确替换为：

```ts
shiftDetailPairs(row, registerFloat)
aggregateGrandTotalsFromRows(data.rows)
grandTotalPairs(gt)
shiftDetailPairs(r, registerFloat)
```

`verticalGrandTotalsTableHtml` 内改为：

```ts
const rows = grandTotalPairs(t)
```

`verticalByShiftSummaryHtml` 的参数类型增加三项餐费字段，并把内部 `const rows = [...]` 改为：

```ts
const rows = byShiftSummaryPairs(b)
  .map(
    ([k, v]) =>
      `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`,
  )
  .join('');
```

聚合 XLSX 的班次循环改为：

```ts
for (const [label, value] of byShiftSummaryPairs(b)) {
  ws.addRow([`  ${label}`, value]);
}
ws.addRow([]);
```

`businessDayShiftSectionHtml` 内改为：

```ts
const rows = shiftDetailPairs(r, registerFloat)
```

日报 XLSX、日报 PDF、聚合 XLSX 明细、聚合 PDF 明细、聚合总计和按班次合计由此全部覆盖三项餐费。

- [ ] **Step 5: 运行导出测试、API 全量测试和 build**

Run:

```bash
pnpm --filter @finance/api test -- test/export-report-data.spec.ts
pnpm --filter @finance/api test
pnpm run typecheck:api
pnpm run build:api
```

Expected: 导出测试和 API 全量测试全部 PASS；typecheck 与 Nest build 成功。

- [ ] **Step 6: 人工打开 Excel 和 PDF 验证四个导出表面**

使用 Task 4 的样例日报依次导出：单份日报 Excel、单份日报 PDF、包含该日报的聚合 Excel、同期间聚合 PDF。Expected: 每个文件的日报明细都显示现金 `1200 円`、支付宝 `800 円`、合计 `2000 円`、实际销售 `21800 円`；聚合文件的总计和班次合计也出现三项餐费；现金入金仍为 `15000 円`。

- [ ] **Step 7: 提交导出契约**

```bash
git add apps/api/src/export/export-report-data.ts apps/api/src/export/export.service.ts apps/api/test/export-report-data.spec.ts
git commit -m "feat(api): 导出网管餐费明细与汇总"
```

---

### Task 8: 执行全量回归、旧数据检查与阶段 A 验收

**Files:**
- Verify only: `apps/api/prisma/schema.prisma`
- Verify only: `apps/api/src/**`
- Verify only: `apps/web/src/**`

**Interfaces:**
- Consumes: Tasks 1-7 的完整阶段 A 交付。
- Produces: 可进入阶段 B 的测试证据；不产生 AWS 资源、不提交本地数据库。

- [ ] **Step 1: 检查变更边界和数据库契约**

Run:

```bash
git status --short
git diff origin/main...HEAD -- apps/api/prisma/schema.prisma apps/api/src apps/api/test apps/web/src
rg -n "staffMeal(Cash|Alipay|Total)Yen" apps/api apps/web --glob '!**/dist/**'
```

Expected:

- schema 只新增 `staffMealCashYen`、`staffMealAlipayYen`，两者都是 `Int @default(0)`。
- `staffMealTotalYen` 只出现在纯函数、预览、统计和导出中，不出现在 Prisma schema 或日报 create/update `data`。
- 业务代码没有 AWS、Cognito、KITCHEN、Manifest 或 Service Worker 改动。

- [ ] **Step 2: 运行 Prisma 生成、两端全量测试、strict typecheck 和 build**

Run:

```bash
pnpm run db:generate
pnpm --filter @finance/api test
pnpm --filter @finance/web test
pnpm run typecheck
pnpm run build
```

Expected: 所有命令退出码为 `0`；API/Web Vitest 全绿；API `tsc --noEmit`、Web `vue-tsc -b`、Nest build 与 Vite build 全部成功。

- [ ] **Step 3: 验证旧日报默认值且不改写其他金额**

对数据库副本执行 `pnpm run db:push` 前，记录一条旧日报的 `id`、`totalSalesYen`、`cashDepositYen`、`deviationYen`；执行 db push 后通过管理员详情/API 重新读取同一 `id`。Expected:

- `staffMealCashYen === 0`。
- `staffMealAlipayYen === 0`。
- 原 `id`、`totalSalesYen`、`cashDepositYen`、`deviationYen`、班次和提交人完全不变。

- [ ] **Step 4: 用固定验收向量走完整业务闭环**

创建一份新日报：

```text
previousImosBalanceYen = 10000
currentImosBalanceYen = 32000
newageYen = 8000
cashTotalYen = 20000
registerFloatYen = 5000
expenseYen = 1000
staffMealCashYen = 1200
staffMealAlipayYen = 800
```

Expected:

```text
imosSalesYen = 22000
cashDepositYen = 15000
staffMealTotalYen = 2000
totalSalesYen = 21800
deviationYen = 800
```

逐项确认表单预览、确认页、保存后的日报、管理员日报明细、统计总计、按班次统计、单份 Excel/PDF 和聚合 Excel/PDF 的数值一致。

- [ ] **Step 5: 验证权限和阶段边界没有回归**

Expected:

- `WEBMASTER` 仍可新建日报但不能修改已提交日报。
- `ADMIN` 仍可补录和修改日报。
- 本地登录、JWT、路由和部署方式没有改变。
- 仓库中没有新增 `KITCHEN` 角色，没有创建 AWS 资源，没有修改 PWA 文件。
- iOS 15.8.4 的 standalone Manifest、Apple meta、图标、安全区和实体机验收继续保留在阶段 D 计划，不作为阶段 A 完成条件误报。

- [ ] **Step 6: 确认 Git 交付状态**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: 工作区没有未提交的阶段 A 文件；提交序列分别覆盖公式、API 持久化、Web 状态、填报 UI、统计 API、管理员明细和导出；没有提交 SQLite 数据库或导出产物。
