# 固定四班实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将系统从固定白班、夜班扩展为固定的网管早班、白班、夜班、网管夜班，同时只保留夜班对同一业务日白班结束时间的自动承接。

**Architecture:** 在 API 新建无状态班次规则模块，集中定义固定名称、顺序和唯一的承接映射；启动校准通过独立函数在 Prisma 事务内复用、创建、排序和停用班次。现有日报、首页、统计与导出继续消费 `Shift` 和 `sortOrder`，仅删除班次写接口及管理员改名界面。

**Tech Stack:** NestJS 10、Prisma 6、SQLite、Vue 3 `<script setup>`、Element Plus、TypeScript strict、pnpm 9、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-08-05-fixed-four-shifts-design.md`

## Global Constraints

- 固定顺序必须是 `网管早班(1) → 白班(2) → 夜班(3) → 网管夜班(4)`。
- 四个班次使用同一套完整财务日报，不强制每天全部提交。
- 唯一自动承接关系是 `夜班 → 同一业务日白班结束时间`；网管早班、白班、网管夜班均不自动承接。
- 必须保留现有白班、夜班 ID 和全部历史日报；额外班次只能停用，不能删除。
- 不修改 Prisma schema，不重写历史日报，不为空缺班次创建零值日报。
- 班次数量、名称和顺序不可由管理员修改；删除 `PATCH /meta/shifts`，保留 `GET /meta/shifts`。
- Vitest 只作为 `apps/api` 开发依赖，不能增加生产依赖。
- 修改 `apps/web` 前必须阅读 `.agents/skills/vue-best-practices/SKILL.md`；若本机使用全局技能目录，则阅读对应的 `vue-best-practices/SKILL.md`。
- 只修改本计划列出的任务文件，不顺带重构日报、统计或导出模块。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `apps/api/src/shifts/fixed-shifts.ts` | 固定四班定义和唯一时间承接映射 |
| `apps/api/src/shifts/reconcile-fixed-shifts.ts` | 在 Prisma 事务中幂等校准班次主数据 |
| `apps/api/test/fixed-shifts.spec.ts` | 固定定义与承接映射单元测试 |
| `apps/api/test/reconcile-fixed-shifts.spec.ts` | ID 保留、创建、停用、幂等与事务接线测试 |
| `apps/api/test/daily-reports-business-day-hint.spec.ts` | 日报默认开始时间规则测试 |
| `apps/api/vitest.config.ts` | API Vitest 的 Node 环境和测试目录 |
| `apps/api/src/setup/setup.service.ts` | 在启动种子流程中调用事务校准 |
| `apps/api/src/daily-reports/daily-reports.service.ts` | 按显式映射读取白班结束时间 |
| `apps/api/src/meta/meta.controller.ts` | 删除班次修改 DTO 与路由 |
| `apps/web/src/views/admin/AdminSettingsView.vue` | 删除班次名称编辑区，保留底钱与负责人设置 |
| `README.md` | 将两班说明更新为固定四班及时间承接规则 |

---

### Task 1: 建立 API 测试入口与固定班次规则

**Files:**
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/shifts/fixed-shifts.ts`
- Create: `apps/api/test/fixed-shifts.spec.ts`
- Modify: `apps/api/package.json:9-16,46-58`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: 无。
- Produces: `FIXED_SHIFT_NAMES`、`FIXED_SHIFTS`、`FixedShiftName`、`previousShiftNameFor(shiftName: string): FixedShiftName | null`。

- [ ] **Step 1: 安装 API Vitest 并增加测试脚本**

Run:

```bash
pnpm --filter @finance/api add --save-dev vitest@^3.0.5
```

在 `apps/api/package.json` 的 `scripts` 中加入：

```json
"test": "vitest run"
```

创建 `apps/api/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
```

- [ ] **Step 2: 写固定班次规则的失败测试**

创建 `apps/api/test/fixed-shifts.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  FIXED_SHIFTS,
  FIXED_SHIFT_NAMES,
  previousShiftNameFor,
} from '../src/shifts/fixed-shifts';

describe('fixed shifts', () => {
  it('defines the four immutable shifts in display order', () => {
    expect(FIXED_SHIFTS).toEqual([
      { name: '网管早班', sortOrder: 1 },
      { name: '白班', sortOrder: 2 },
      { name: '夜班', sortOrder: 3 },
      { name: '网管夜班', sortOrder: 4 },
    ]);
  });

  it('only lets night shift inherit from day shift', () => {
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.night)).toBe(
      FIXED_SHIFT_NAMES.day,
    );
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.webmasterMorning)).toBeNull();
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.day)).toBeNull();
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.webmasterNight)).toBeNull();
    expect(previousShiftNameFor('临时班')).toBeNull();
  });
});
```

- [ ] **Step 3: 运行测试并确认因规则模块不存在而失败**

Run:

```bash
pnpm --filter @finance/api test -- test/fixed-shifts.spec.ts
```

Expected: FAIL，错误包含 `Cannot find module '../src/shifts/fixed-shifts'` 或同等的模块不存在信息。

- [ ] **Step 4: 实现最小固定班次规则**

创建 `apps/api/src/shifts/fixed-shifts.ts`：

```ts
export const FIXED_SHIFT_NAMES = {
  webmasterMorning: '网管早班',
  day: '白班',
  night: '夜班',
  webmasterNight: '网管夜班',
} as const;

export type FixedShiftName =
  (typeof FIXED_SHIFT_NAMES)[keyof typeof FIXED_SHIFT_NAMES];

export const FIXED_SHIFTS = [
  { name: FIXED_SHIFT_NAMES.webmasterMorning, sortOrder: 1 },
  { name: FIXED_SHIFT_NAMES.day, sortOrder: 2 },
  { name: FIXED_SHIFT_NAMES.night, sortOrder: 3 },
  { name: FIXED_SHIFT_NAMES.webmasterNight, sortOrder: 4 },
] as const satisfies readonly {
  name: FixedShiftName;
  sortOrder: number;
}[];

export function previousShiftNameFor(
  shiftName: string,
): FixedShiftName | null {
  return shiftName === FIXED_SHIFT_NAMES.night
    ? FIXED_SHIFT_NAMES.day
    : null;
}
```

- [ ] **Step 5: 运行测试并确认通过**

Run:

```bash
pnpm --filter @finance/api test -- test/fixed-shifts.spec.ts
```

Expected: PASS，2 个测试通过。

- [ ] **Step 6: 提交固定班次规则与测试基础设施**

```bash
git add apps/api/package.json apps/api/vitest.config.ts apps/api/src/shifts/fixed-shifts.ts apps/api/test/fixed-shifts.spec.ts pnpm-lock.yaml
git commit -m "feat(api): 定义固定班次规则"
```

---

### Task 2: 幂等校准固定四班并保留历史关联

**Files:**
- Create: `apps/api/src/shifts/reconcile-fixed-shifts.ts`
- Create: `apps/api/test/reconcile-fixed-shifts.spec.ts`
- Modify: `apps/api/src/setup/setup.service.ts:7-80`

**Interfaces:**
- Consumes: Task 1 的 `FIXED_SHIFTS`。
- Produces: `reconcileFixedShifts(tx: Prisma.TransactionClient): Promise<void>`；`SetupService.ensureSeedData()` 在交互式 Prisma 事务内调用它。

- [ ] **Step 1: 写校准与事务接线的失败测试**

创建 `apps/api/test/reconcile-fixed-shifts.spec.ts`：

```ts
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { SetupService } from '../src/setup/setup.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { reconcileFixedShifts } from '../src/shifts/reconcile-fixed-shifts';

type ShiftRow = {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
};

function fakeShiftTransaction(seed: ShiftRow[]) {
  const rows = seed.map((row) => ({ ...row }));
  let nextId = 1;
  const tx = {
    shift: {
      findMany: vi.fn(async () =>
        [...rows].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
        ),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Pick<ShiftRow, 'sortOrder' | 'active'>>;
        }) => {
          const row = rows.find((item) => item.id === where.id);
          if (!row) throw new Error(`missing shift ${where.id}`);
          Object.assign(row, data);
          return { ...row };
        },
      ),
      create: vi.fn(
        async ({ data }: { data: Omit<ShiftRow, 'id'> }) => {
          const row = { id: `created-${nextId++}`, ...data };
          rows.push(row);
          return { ...row };
        },
      ),
    },
  } as unknown as Prisma.TransactionClient;

  return { rows, tx };
}

describe('reconcileFixedShifts', () => {
  it('reuses day and night ids, creates missing shifts, and deactivates extras', async () => {
    const { rows, tx } = fakeShiftTransaction([
      { id: 'extra', name: '临时班', sortOrder: 0, active: true },
      { id: 'day', name: '白班', sortOrder: 1, active: true },
      { id: 'night', name: '夜班', sortOrder: 2, active: true },
      { id: 'day-copy', name: '白班', sortOrder: 5, active: true },
    ]);

    await reconcileFixedShifts(tx);

    expect(
      rows
        .filter((row) => row.active)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    ).toEqual([
      { id: 'created-1', name: '网管早班', sortOrder: 1 },
      { id: 'day', name: '白班', sortOrder: 2 },
      { id: 'night', name: '夜班', sortOrder: 3 },
      { id: 'created-2', name: '网管夜班', sortOrder: 4 },
    ]);
    expect(rows.find((row) => row.id === 'extra')?.active).toBe(false);
    expect(rows.find((row) => row.id === 'day-copy')?.active).toBe(false);

    await reconcileFixedShifts(tx);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.active)).toHaveLength(4);
  });

  it('runs shift reconciliation through a Prisma transaction during setup', async () => {
    const { rows, tx } = fakeShiftTransaction([]);
    const transaction = vi.fn(
      async (callback: (client: Prisma.TransactionClient) => Promise<void>) =>
        callback(tx),
    );
    const prisma = {
      $transaction: transaction,
      appSettings: { upsert: vi.fn() },
      responsiblePerson: { count: vi.fn().mockResolvedValue(1) },
    } as unknown as PrismaService;

    await new SetupService(prisma).ensureSeedData();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rows.filter((row) => row.active)).toHaveLength(4);
  });
});
```

- [ ] **Step 2: 运行测试并确认因校准模块不存在而失败**

Run:

```bash
pnpm --filter @finance/api test -- test/reconcile-fixed-shifts.spec.ts
```

Expected: FAIL，错误包含 `Cannot find module '../src/shifts/reconcile-fixed-shifts'`。

- [ ] **Step 3: 实现幂等校准函数**

创建 `apps/api/src/shifts/reconcile-fixed-shifts.ts`：

```ts
import type { Prisma } from '@prisma/client';
import { FIXED_SHIFTS } from './fixed-shifts';

export async function reconcileFixedShifts(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const existingShifts = await tx.shift.findMany({
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const activeFixedIds = new Set<string>();

  for (const fixedShift of FIXED_SHIFTS) {
    const existing = existingShifts.find(
      (shift) =>
        shift.name === fixedShift.name && !activeFixedIds.has(shift.id),
    );
    if (existing) {
      activeFixedIds.add(existing.id);
      await tx.shift.update({
        where: { id: existing.id },
        data: { sortOrder: fixedShift.sortOrder, active: true },
      });
      continue;
    }

    const created = await tx.shift.create({
      data: {
        name: fixedShift.name,
        sortOrder: fixedShift.sortOrder,
        active: true,
      },
    });
    activeFixedIds.add(created.id);
  }

  for (const shift of existingShifts) {
    if (activeFixedIds.has(shift.id) || !shift.active) continue;
    await tx.shift.update({
      where: { id: shift.id },
      data: { active: false },
    });
  }
}
```

- [ ] **Step 4: 将 SetupService 接到交互式事务**

在 `apps/api/src/setup/setup.service.ts`：

1. 删除 `DEFAULT_SHIFT_NAMES` 和整个私有 `ensureShifts()`。
2. 加入导入：

```ts
import { reconcileFixedShifts } from '../shifts/reconcile-fixed-shifts';
```

3. 将 `ensureSeedData()` 开头替换为：

```ts
async ensureSeedData() {
  await this.prisma.$transaction(async (tx) => {
    await reconcileFixedShifts(tx);
  });
  await this.prisma.appSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', registerFloatAmount: 0, setupCompleted: false },
    update: {},
  });
```

保留原有 `AppSettings` 与默认负责人的后续逻辑不变。

- [ ] **Step 5: 运行校准测试、类型检查并确认通过**

Run:

```bash
pnpm --filter @finance/api test -- test/reconcile-fixed-shifts.spec.ts
pnpm --filter @finance/api exec tsc --noEmit
```

Expected: 2 个校准测试 PASS；TypeScript 退出码为 0。

- [ ] **Step 6: 提交启动校准**

```bash
git add apps/api/src/shifts/reconcile-fixed-shifts.ts apps/api/src/setup/setup.service.ts apps/api/test/reconcile-fixed-shifts.spec.ts
git commit -m "feat(api): 启动时校准固定四班"
```

---

### Task 3: 将开始时间承接限制为夜班读取白班

**Files:**
- Create: `apps/api/test/daily-reports-business-day-hint.spec.ts`
- Modify: `apps/api/src/daily-reports/daily-reports.service.ts:284-313`

**Interfaces:**
- Consumes: Task 1 的 `FIXED_SHIFT_NAMES` 与 `previousShiftNameFor(shiftName: string)`。
- Produces: 保持现有 `businessDayHint(reportDate: string, shiftId: string): Promise<{ previousShiftEndMinute: number | null }>` 契约。

- [ ] **Step 1: 写时间承接规则的失败测试**

创建 `apps/api/test/daily-reports-business-day-hint.spec.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { DailyReportsService } from '../src/daily-reports/daily-reports.service';
import { PrismaService } from '../src/prisma/prisma.service';

function buildService() {
  const shiftFindFirst = vi.fn();
  const dailyReportFindUnique = vi.fn();
  const prisma = {
    shift: { findFirst: shiftFindFirst },
    dailyReport: { findUnique: dailyReportFindUnique },
  } as unknown as PrismaService;
  return {
    service: new DailyReportsService(prisma),
    shiftFindFirst,
    dailyReportFindUnique,
  };
}

describe('DailyReportsService.businessDayHint', () => {
  it.each(['网管早班', '白班', '网管夜班'])(
    'does not inherit a start time for %s',
    async (name) => {
      const { service, shiftFindFirst, dailyReportFindUnique } = buildService();
      shiftFindFirst.mockResolvedValueOnce({ name });

      await expect(service.businessDayHint('2026-08-05', 'current')).resolves.toEqual({
        previousShiftEndMinute: null,
      });
      expect(shiftFindFirst).toHaveBeenCalledTimes(1);
      expect(dailyReportFindUnique).not.toHaveBeenCalled();
    },
  );

  it('returns the same-day day-shift end time for night shift', async () => {
    const { service, shiftFindFirst, dailyReportFindUnique } = buildService();
    shiftFindFirst
      .mockResolvedValueOnce({ name: '夜班' })
      .mockResolvedValueOnce({ id: 'day-id' });
    dailyReportFindUnique.mockResolvedValueOnce({ endMinuteOfDay: 1020 });

    await expect(service.businessDayHint('2026-08-05', 'night-id')).resolves.toEqual({
      previousShiftEndMinute: 1020,
    });
    expect(shiftFindFirst).toHaveBeenNthCalledWith(2, {
      where: { name: '白班', active: true },
      select: { id: true },
    });
    expect(dailyReportFindUnique).toHaveBeenCalledWith({
      where: {
        reportDate_shiftId: {
          reportDate: '2026-08-05',
          shiftId: 'day-id',
        },
      },
    });
  });

  it('returns null when the day-shift report is missing', async () => {
    const { service, shiftFindFirst, dailyReportFindUnique } = buildService();
    shiftFindFirst
      .mockResolvedValueOnce({ name: '夜班' })
      .mockResolvedValueOnce({ id: 'day-id' });
    dailyReportFindUnique.mockResolvedValueOnce(null);

    await expect(service.businessDayHint('2026-08-05', 'night-id')).resolves.toEqual({
      previousShiftEndMinute: null,
    });
  });

  it('does not query the database for invalid parameters', async () => {
    const { service, shiftFindFirst, dailyReportFindUnique } = buildService();

    await expect(service.businessDayHint('08-05-2026', '')).resolves.toEqual({
      previousShiftEndMinute: null,
    });
    expect(shiftFindFirst).not.toHaveBeenCalled();
    expect(dailyReportFindUnique).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试并确认旧的相邻班次查询不符合测试**

Run:

```bash
pnpm --filter @finance/api test -- test/daily-reports-business-day-hint.spec.ts
```

Expected: FAIL；旧实现调用 `shift.findMany`，而测试只提供 `shift.findFirst`，错误体现旧的 `sortOrder` 相邻逻辑尚未替换。

- [ ] **Step 3: 实现显式承接映射查询**

在 `apps/api/src/daily-reports/daily-reports.service.ts` 加入：

```ts
import { previousShiftNameFor } from '../shifts/fixed-shifts';
```

将 `businessDayHint()` 替换为：

```ts
/**
 * 只有夜班默认承接同一业务日白班的结束时间；网管班是独立业务班次。
 * 不跨日回看，也不按填报人过滤，以支持管理员代填白班后由网管填写夜班。
 */
async businessDayHint(reportDate: string, shiftId: string) {
  if (!reportDate?.match(/^\d{4}-\d{2}-\d{2}$/) || !shiftId) {
    return { previousShiftEndMinute: null as number | null };
  }

  const shift = await this.prisma.shift.findFirst({
    where: { id: shiftId, active: true },
    select: { name: true },
  });
  const previousShiftName = shift
    ? previousShiftNameFor(shift.name)
    : null;
  if (!previousShiftName) {
    return { previousShiftEndMinute: null as number | null };
  }

  const previousShift = await this.prisma.shift.findFirst({
    where: { name: previousShiftName, active: true },
    select: { id: true },
  });
  if (!previousShift) {
    return { previousShiftEndMinute: null as number | null };
  }

  const row = await this.prisma.dailyReport.findUnique({
    where: {
      reportDate_shiftId: {
        reportDate,
        shiftId: previousShift.id,
      },
    },
  });
  return { previousShiftEndMinute: row?.endMinuteOfDay ?? null };
}
```

- [ ] **Step 4: 运行目标测试和全部 API 测试**

Run:

```bash
pnpm --filter @finance/api test -- test/daily-reports-business-day-hint.spec.ts
pnpm --filter @finance/api test
```

Expected: 目标文件 6 个参数化/独立用例 PASS；API 全部测试 PASS。

- [ ] **Step 5: 提交时间承接规则**

```bash
git add apps/api/src/daily-reports/daily-reports.service.ts apps/api/test/daily-reports-business-day-hint.spec.ts
git commit -m "fix(api): 限定夜班承接白班结束时间"
```

---

### Task 4: 收口班次修改接口与管理员界面

**Files:**
- Modify: `apps/api/src/meta/meta.controller.ts:1-66`
- Modify: `apps/web/src/views/admin/AdminSettingsView.vue:1-120`

**Interfaces:**
- Consumes: Task 2 产生的只读固定四班主数据。
- Produces: `GET /meta/shifts` 保持不变；`PATCH /meta/shifts` 不再注册；管理员设置页不再请求或修改班次。

- [ ] **Step 1: 阅读 Vue 项目技能约束**

Run（使用仓库技能目录存在时）：

```bash
sed -n '1,260p' .agents/skills/vue-best-practices/SKILL.md
```

若该文件不存在，读取当前 Codex 会话列出的全局 `vue-best-practices/SKILL.md` 完整内容。执行时遵守仓库 `AGENTS.md` 对小范围修改的优先约束。

- [ ] **Step 2: 运行删除行为的失败验收检查**

Run:

```bash
rg -n "PatchShiftDto|@Patch\('shifts'\)|patchShift|saveShift|シフト名|meta/shifts" apps/api/src/meta/meta.controller.ts apps/web/src/views/admin/AdminSettingsView.vue
```

Expected: 命中班次 DTO、PATCH 路由、`saveShift`、班次编辑标题和管理员页面中的 `/meta/shifts` 请求，说明写能力仍存在。

- [ ] **Step 3: 删除后端班次写接口**

在 `apps/api/src/meta/meta.controller.ts`：

- 删除 `IsBoolean`、`IsOptional` 导入。
- 删除整个 `PatchShiftDto`。
- 删除 `@Patch('shifts')`、`@Roles(Role.ADMIN)` 和 `patchShift()` 方法。
- 保留 Nest 的 `Patch` 导入，因为负责人停用和底钱设置仍使用它。
- 保留 `Role` 与 `Roles`，因为其他管理员接口仍使用它们。
- 保持以下只读查询原样：

```ts
@Get('shifts')
shifts() {
  return this.prisma.shift.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
  });
}
```

- [ ] **Step 4: 删除管理员班次编辑状态与模板**

在 `apps/web/src/views/admin/AdminSettingsView.vue`：

1. 删除：

```ts
const shifts = ref<{ id: string; name: string; sortOrder: number }[]>([]);
```

2. 将 `load()` 的请求和赋值收窄为：

```ts
const [{ data: s }, { data: p }] = await Promise.all([
  http.get('/meta/settings'),
  http.get<{ id: string; name: string }[]>('/meta/responsible-persons'),
]);
registerFloat.value = s?.registerFloatAmount ?? 0;
persons.value = Array.isArray(p) ? p : [];
```

3. 删除整个 `saveShift()`。
4. 删除 `<h3>シフト名</h3>` 及其紧随的班次 `<el-table>`，保留底钱和负责人区域。

- [ ] **Step 5: 重新运行验收检查并构建两端**

Run:

```bash
rg -n "PatchShiftDto|@Patch\('shifts'\)|patchShift|saveShift|シフト名|meta/shifts" apps/api/src/meta/meta.controller.ts apps/web/src/views/admin/AdminSettingsView.vue
pnpm --filter @finance/api exec tsc --noEmit
pnpm --filter @finance/web run build
```

Expected: `rg` 无输出并以 1 退出；API 类型检查退出码 0；Web 构建成功。只读接口以 `@Get('shifts')` 注册，不会匹配上述写接口和管理员请求检查模式。

- [ ] **Step 6: 提交接口与界面收口**

```bash
git add apps/api/src/meta/meta.controller.ts apps/web/src/views/admin/AdminSettingsView.vue
git commit -m "refactor(web,api): 固定班次并移除修改入口"
```

---

### Task 5: 更新说明并执行完整验收

**Files:**
- Modify: `README.md:3,25-29`

**Interfaces:**
- Consumes: Tasks 1-4 的固定四班行为。
- Produces: 与实际班次规则一致的仓库说明和完整验证证据。

- [ ] **Step 1: 运行文档陈旧内容检查**

Run:

```bash
rg -n "一日两班次|固定四班|网管早班" README.md
```

Expected: 仅命中 `一日两班次`，说明 README 仍描述旧规则。

- [ ] **Step 2: 更新 README 的班次契约**

将 README 第 3 行改为：

```md
> **东京时区**业务日、固定四班日报；管理员集计与导出。
```

在概述表的“用途”行后加入：

```md
| **固定班次** | 网管早班 → 白班 → 夜班 → 网管夜班；仅夜班默认承接同一业务日白班结束时间 |
```

- [ ] **Step 3: 运行自动化测试与静态验证**

Run:

```bash
pnpm --filter @finance/api test
pnpm --filter @finance/web run test
pnpm run typecheck
pnpm run build
git diff --check
```

Expected: API 测试全部 PASS；现有 Web 测试全部 PASS；API/Web 类型检查和构建退出码均为 0；`git diff --check` 无输出。

- [ ] **Step 4: 用测试结论核对业务验收矩阵**

逐项记录结果：

| 验收项 | 预期证据 |
| --- | --- |
| 固定顺序 | `fixed-shifts.spec.ts` 断言四班及 1-4 顺序 |
| 历史 ID | `reconcile-fixed-shifts.spec.ts` 断言白班 ID=`day`、夜班 ID=`night` |
| 幂等 | 校准执行两次后仍只有 4 个有效班次且总记录不增加 |
| 额外记录 | 临时班与重复白班均为 `active: false`，记录仍存在 |
| 时间承接 | 夜班得到白班结束分钟；其他三班和缺少白班日报时返回 `null` |
| 非强制提交 | 没有新增业务日关闭或四班齐全校验；首页继续按实际日报计算 `filledCount` |
| 统计导出 | 未修改统计和导出代码；两者继续按 `shift.sortOrder` 与实际日报工作 |
| 班次不可修改 | API 无 `PATCH /meta/shifts`，管理员设置页无班次编辑区 |

- [ ] **Step 5: 检查最终改动范围**

Run:

```bash
git status --short
git diff --stat
git diff -- apps/api/src apps/api/test apps/api/package.json apps/api/vitest.config.ts apps/web/src/views/admin/AdminSettingsView.vue README.md pnpm-lock.yaml
```

Expected: 只包含本计划列出的文件；没有 Prisma schema、日报表单、统计或导出实现改动。

- [ ] **Step 6: 提交 README 与最终验证收口**

```bash
git add README.md
git commit -m "docs: 更新固定四班说明"
```

- [ ] **Step 7: 确认分支交付状态**

Run:

```bash
git status --short --branch
git log -6 --oneline --decorate
```

Expected: 工作区干净；历史中依次包含设计书提交、本计划的四个代码提交和一个 README 提交。除非用户另行明确要求，不推送、不创建 PR、不部署。
