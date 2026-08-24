# FSK Amplify Data / DynamoDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 FSK 从本地 NestJS/SQLite 运行层迁移为独立的 Amplify Gen 2 WebApp，使老板通过 `OWNER` 账号管理历史、统计、设置和导出，厨房通过 `KITCHEN` 账号只能读取填报上下文并创建班次账务，同时完整迁移 SQLite、uploads、班次和设置。

**Architecture:** 新的活动后端由 Cognito、Amplify Data/AppSync/DynamoDB、Amplify Storage/S3 和一个最小的厨房上下文 Function 组成，Vue/PWA 由 Amplify Hosting 托管。`reportKey = businessDate + "#" + shiftId` 是确定性复合标识符，`businessDate + shiftId` GSI 用于老板逐日 Query；所有销售合计都由共享纯函数从原始金额即时计算。旧 NestJS/SQLite 在切换前继续可用，切换时冻结为只读；旧 Aurora 只在单独批准后删除。

**Tech Stack:** AWS Amplify Gen 2、AppSync、DynamoDB On-Demand、Cognito、S3、Lambda/Amplify Functions、AWS SDK v3、Vue 3 `<script setup>`、Pinia、Vue Router 4、Element Plus、Vite、TypeScript strict、Vitest、pnpm 9、Prisma/SQLite（仅迁移源）。

**Spec:** `docs/superpowers/specs/2026-08-24-fsk-amplify-data-dynamodb-architecture-design.md`

## Global Constraints

- 本计划取代旧 PostgreSQL/Data API 计划中尚未执行或失败的部署路径；旧设计文档、失败证据和已部署 Foundation 先保留为历史与回退依据。
- 新活动后端不得创建或依赖 Aurora、RDS Data API、VPC、NAT、RDS Proxy、PostgreSQL migration、常驻服务器或 NestJS API。
- 新 FSK App 与 GameList 必须拥有独立的 Amplify App、Cognito User Pool、AppSync API、DynamoDB 表、S3 bucket、CloudFormation stacks 和 outputs；不得引用 GameList ARN。
- Cognito 业务组只允许 `OWNER`、`KITCHEN`；不创建 `ADMIN`、`WEBMASTER` 或 `webmaster` 组。旧 SQLite 角色只存在于迁移源，不进入新授权契约。
- 厨房的后端权限只允许：读取启用的班次/责任人、调用安全的填报上下文查询、创建日报、向本人 submission 前缀写附件。禁止日报 get/list、历史、统计、设置、更新、删除、附件 list/read/delete。
- 老板可管理日报、班次、责任人、设置和附件；所有授权必须在 Amplify Data/Storage 规则中执行，路由隐藏只作为第二道 UI 约束。
- `reportKey` 必须由 `businessDate` 和 `shiftId` 通过共享函数构造；客户端不得生成随机日报 ID。同一营业日、同一班次第二次 create 必须得到冲突，不能覆盖。
- 日元金额为 `0..2_000_000_000` 的整数。`staffMealCashYen` 保留在现金入金中但从实际売上扣除；`staffMealAlipayYen` 独立保存且不进入实际売上。
- 不持久化 `staffMealTotalYen`、`imosSalesYen`、`cashDepositYen`、`totalSalesYen` 或 `deviationYen` 作为客户端权威字段；确认、统计、CSV、迁移核对共用 `@fsk/domain`。
- 新系统不实现 Service Worker、离线队列、后台重传或双写。明确失败时保留当前 Vue 表单；刷新或关闭页面可能丢失未提交内容。
- DynamoDB 表使用 On-Demand 并开启 PITR；S3 开启 versioning、SSE-S3 和 public access block。
- `amplify_outputs.json` 是环境生成物，不提交 Git；本地 sandbox 输出到 `apps/web/public/amplify_outputs.json`，Hosting 构建也在构建前生成同一路径。
- 修改 `apps/web` 前完整阅读 `.agents/skills/vue-best-practices/SKILL.md`；修改 Router、Pinia、Web 测试时分别阅读对应 Vue skill。仓库 `AGENTS.md` 优先。
- 每个实现任务都遵循 TDD：先加入失败测试并记录 RED，再做最小实现，运行该任务列出的 focused tests 与 `check:all`（审批门任务除外），最后只提交任务列出的文件。
- 任何 AWS 写入、Git remote 写入、真实 SQLite/uploads 导入、旧系统冻结或资源删除都必须停在对应审批门；设计确认、计划确认、旧方案批准和“已登录”均不构成新批准。
- `graphify-out/`、真实数据库副本、真实 uploads 副本、临时密码、Cognito token、AWS Secret、`amplify_outputs.json` 和导入报告中的个人凭据不得提交。

---

### Task 1: 建立共享账务领域包

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/daily-report.ts`
- Create: `packages/domain/src/daily-report.spec.ts`
- Create: `packages/domain/src/index.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/utils/daily-report-calc.ts`
- Modify: `apps/web/src/utils/daily-report-calc.spec.ts`

**Interfaces:**

```ts
export const MAX_YEN = 2_000_000_000;

export interface DailyReportRawAmounts {
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
}

export interface DailyReportTotals {
  imosSalesYen: number;
  cashDepositYen: number;
  totalSalesYen: number;
  deviationYen: number;
  staffMealTotalYen: number;
}

export function dailyReportKey(businessDate: string, shiftId: string): string;
export function assertDailyReportRawAmounts(value: DailyReportRawAmounts): void;
export function computeDailyReportTotals(
  value: DailyReportRawAmounts,
  registerFloatYen: number,
): DailyReportTotals;
```

- [ ] 在 `packages/domain/src/daily-report.spec.ts` 写 RED：固定向量 `cashTotal=20_000`、`registerFloat=5_000`、现金餐费 `1_200`、支付宝餐费 `800` 时，现金入金为 `15_000`、实际売上为 `21_800`、餐费合计为 `2_000`；支付宝变化不得改变实际売上。
- [ ] 增加日期/key 测试：`dailyReportKey('2026-08-24', 'shift-day') === '2026-08-24#shift-day'`；非法日期、空 shift、包含 `#` 的 shift 必须抛出稳定错误码。
- [ ] 增加边界测试：七个金额字段和 `registerFloatYen` 只接受安全整数 `0..MAX_YEN`；负数、小数、`NaN`、无穷值和上界外值全部拒绝。
- [ ] 在 workspace 添加 `packages/*`，并增加 root scripts：`typecheck:domain`、`test:domain`；让 `typecheck` 和 `check:all` 包含领域包。
- [ ] 运行 `pnpm run test:domain`，确认因包和函数尚不存在而 FAIL。
- [ ] 实现纯函数。实际销售公式必须是：

```ts
const imosSalesYen =
  value.currentImosBalanceYen - value.previousImosBalanceYen;
const cashDepositYen = value.cashTotalYen - registerFloatYen;
const totalSalesYen =
  value.newageYen + cashDepositYen - value.staffMealCashYen;
return {
  imosSalesYen,
  cashDepositYen,
  totalSalesYen,
  deviationYen: totalSalesYen + value.expenseYen - imosSalesYen,
  staffMealTotalYen:
    value.staffMealCashYen + value.staffMealAlipayYen,
};
```

- [ ] 让 Web 的旧 `daily-report-calc.ts` 只重导出 `@fsk/domain` 对应函数，保持当前调用点兼容；不得在 Web 再复制公式。
- [ ] 运行 `pnpm run test:domain`、`pnpm run test:web`、`pnpm run typecheck`、`pnpm run build:web` 和 `git diff --check`，期望全部 PASS。
- [ ] 提交：`git commit -m "refactor(domain): 统一账务计算契约"`

---

### Task 2: 定义 Amplify Data 模型、复合日报 key 与授权

**Files:**

- Create: `amplify/data/resource.ts`
- Create: `amplify/data/resource.spec.ts`
- Create: `amplify/infrastructure/application-config.ts`
- Create: `amplify/infrastructure/application-config.spec.ts`
- Modify: `amplify/backend.ts`
- Modify: `amplify/backend-composition.spec.ts`
- Modify: `amplify/tsconfig.json`

**Data contract:**

```ts
DailyReport: {
  reportKey, businessDate, shiftId, shiftNameSnapshot,
  responsiblePersonId, responsiblePersonSnapshot,
  startMinuteOfDay, endMinuteOfDay, timeRangeLabelSnapshot,
  previousImosBalanceYen, currentImosBalanceYen, newageYen,
  cashTotalYen, expenseYen, expenseReason,
  staffMealCashYen, staffMealAlipayYen,
  attachmentKeys, submittedAt,
  legacySubmittedByUsername
}

ShiftDefinition: { id, name, sortOrder, active }
ResponsiblePerson: { id, name, active }
AppSetting: { id, registerFloatAmount, setupCompleted }
```

- [ ] 在 `resource.spec.ts` 先写 schema contract RED，锁定四个模型、日报原始字段、`reportKey` identifier、`businessDate + shiftId` secondary index、金额类型以及授权矩阵。
- [ ] 日报授权必须精确为 `OWNER` 全操作加 create-only owner 规则；Shift/ResponsiblePerson 为 `OWNER` 全操作、`KITCHEN` 只读；AppSetting 只有 `OWNER`。
- [ ] 使用 `reportKey` 作为 identifier，并建立按营业日查询：

```ts
const DailyReport = a
  .model({
    reportKey: a.id().required(),
    businessDate: a.string().required(),
    shiftId: a.id().required(),
    shiftNameSnapshot: a.string().required(),
    responsiblePersonId: a.id().required(),
    responsiblePersonSnapshot: a.string().required(),
    startMinuteOfDay: a.integer().required(),
    endMinuteOfDay: a.integer().required(),
    timeRangeLabelSnapshot: a.string().required(),
    previousImosBalanceYen: a.integer().required(),
    currentImosBalanceYen: a.integer().required(),
    newageYen: a.integer().required(),
    cashTotalYen: a.integer().required(),
    expenseYen: a.integer().required(),
    expenseReason: a.string(),
    staffMealCashYen: a.integer().required(),
    staffMealAlipayYen: a.integer().required(),
    attachmentKeys: a.string().array(),
    submittedAt: a.datetime().required(),
    legacySubmittedByUsername: a.string(),
  })
  .identifier(['reportKey'])
  .secondaryIndexes((index) => [
    index('businessDate')
      .sortKeys(['shiftId'])
      .queryField('dailyReportsByBusinessDate'),
  ])
  .authorization((allow) => [
    allow.group('OWNER'),
    allow.owner().to(['create']),
  ]);
```

- [ ] `resource.ts` 导出 `type Schema = ClientSchema<typeof schema>`，默认授权模式只使用 Cognito User Pool；不得启用 API key、guest 或 unauthenticated identity。
- [ ] 将活动 `amplify/backend.ts` 从 `backend.foundation.ts` 切换为新 composition。旧 `backend.foundation.ts`、`amplify/database/**` 与 Foundation 文件暂不删除，但不得被活动入口 import。
- [ ] 新 `application-config.ts` 固定 `region=ap-northeast-1` 和 tags `Project=FSK`、`Environment=production`、`ManagedBy=AmplifyGen2`、`CostCenter=FSK`。
- [ ] 在 composition 测试断言活动模板不存在 RDS、VPC、NAT、EC2、Data API、RDS Secret、PostgreSQL Function；存在 AppSync 与四张 DynamoDB 表。
- [ ] 运行 focused Amplify tests，确认旧入口和缺失 schema 导致 RED；再做最小实现。
- [ ] 运行 `pnpm run test:amplify`、`pnpm run typecheck:amplify`、backend synth 和 `git diff --check`，期望全部 PASS。
- [ ] 提交：`git commit -m "feat(amplify): 建立 DynamoDB 数据模型"`

---

### Task 3: 收紧 Cognito、DynamoDB、Storage 与厨房上下文

**Files:**

- Modify: `amplify/auth/overrides.ts`
- Modify: `amplify/auth/overrides.spec.ts`
- Modify: `amplify/auth/resource.ts`
- Modify: `amplify/storage/resource.ts`
- Modify: `amplify/storage/key-policy.ts`
- Modify: `amplify/storage/key-policy.spec.ts`
- Create: `amplify/functions/kitchen-context/resource.ts`
- Create: `amplify/functions/kitchen-context/handler.ts`
- Create: `amplify/functions/kitchen-context/handler.spec.ts`
- Modify: `amplify/data/resource.ts`
- Modify: `amplify/backend.ts`
- Modify: `amplify/backend-composition.spec.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Kitchen context result:**

```ts
export interface KitchenContextResult {
  registerFloatAmount: number;
  shifts: Array<{ id: string; name: string; sortOrder: number }>;
  responsiblePersons: Array<{ id: string; name: string }>;
}
```

- [ ] 将 Cognito RED 测试改为只允许 `['OWNER', 'KITCHEN']`，继续锁定 username-only、admin-created users、无 self-signup、无未认证 identity；确认旧 `ADMIN` 期望失败。
- [ ] 为 Storage 写 RED：`submissions/{entity_id}/*` 对 identity 只允许 write；`OWNER` 可管理 `daily-reports/*` 和 `migration/*`；KITCHEN 对所有前缀都无 list/read/delete。
- [ ] 将现有 `pending/` key 改为 `submissions/{identityId}/{draftId}/{attachmentId}/{fileName}`，保留路径遍历、控制字符、Unicode 和 255-byte filename 防护测试。
- [ ] 为 `getKitchenContext` 写 handler RED：只返回 register float、启用班次和启用责任人；按 sortOrder 排序；不得返回其他 AppSetting 字段、历史日报或附件。
- [ ] Data schema 增加 `KitchenContext` custom type 和仅 `OWNER`/`KITCHEN` 可调用的 custom query；Function 通过环境变量获取三张表名，只进行 DynamoDB `GetItem`/`Query`/`Scan` 的只读访问。
- [ ] 在 backend composition 给 Function 精确 `grantReadData`，不授予 DailyReport、S3、Cognito 或 GameList 权限。
- [ ] 对每张活动 DynamoDB 表设置 On-Demand 与 PITR；S3 设置 versioning、SSE-S3、public access block、keep-on-delete。合成测试必须逐资源验证。
- [ ] 对活动 Auth/Data/Storage/Function stacks 施加四个 FSK production tags；测试不得把旧 Foundation 的 staging tags 当作活动资源证据。
- [ ] 运行 `pnpm run test:amplify`、`pnpm run typecheck:amplify`、`pnpm run check:all`、synth 和 `git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 落实厨房最小权限"`

---

### Task 4: 将 Vue 启动、认证与路由切换到 Amplify

**Files:**

- Create: `apps/web/src/amplify/bootstrap.ts`
- Create: `apps/web/src/amplify/bootstrap.spec.ts`
- Modify: `apps/web/src/main.ts`
- Modify: `apps/web/src/stores/auth.ts`
- Create: `apps/web/src/stores/auth.spec.ts`
- Modify: `apps/web/src/views/LoginView.vue`
- Modify: `apps/web/src/router/index.ts`
- Create: `apps/web/src/router/authorization.ts`
- Create: `apps/web/src/router/authorization.spec.ts`
- Modify: `apps/web/src/App.vue`
- Modify: `apps/web/src/views/NotFoundView.vue`
- Modify: `apps/web/src/env.d.ts`
- Modify: `.gitignore`
- Delete: `apps/web/src/stores/setup.ts`
- Delete: `apps/web/src/views/SetupView.vue`
- Delete: `apps/web/src/views/ServiceUnavailableView.vue`
- Modify: `apps/web/vite.config.ts`

**Auth state:**

```ts
export type AppRole = 'OWNER' | 'KITCHEN';

export interface AuthUser {
  subject: string;
  username: string;
  role: AppRole;
}
```

- [ ] 先读项目 Vue、Pinia、Router 和 testing skills；在任务报告记录已读路径。
- [ ] 为 bootstrap 写 RED：启动时 fetch `/amplify_outputs.json`，成功后只调用一次 `Amplify.configure`；404/非 JSON 时显示可恢复的配置错误，不能继续 mount 一个半配置应用。
- [ ] 将 `apps/web/public/amplify_outputs.json` 加入 `.gitignore`；本地 sandbox 和 Hosting build 只生成该文件，不允许提交占位 outputs。
- [ ] 为 auth store 写 RED：使用 `signIn`、`fetchAuthSession`、`getCurrentUser`、`signOut`；从 `cognito:groups` 只接受一个业务角色；无组、多组、旧 `ADMIN/WEBMASTER` 都 fail closed。
- [ ] 为纯路由授权函数写 RED：未登录到 login；OWNER 可进入 `/owner/**`；KITCHEN 只可进入 `/kitchen` 与 `/kitchen/report/**`；KITCHEN 请求历史、统计、设置或未知受保护路由时回到 `/kitchen`。
- [ ] 删除 `/setup` 探测与 localStorage JWT。Amplify 负责 token 持久化；store 不自行保存 access token 或用户 JSON。
- [ ] 路由改为 `/owner` 和 `/kitchen`，角色 meta 使用 `OWNER`/`KITCHEN`。暂时仍可复用现有 Vue 文件，但 UI 文案和 route name 不得出现“网管/Webmaster”。
- [ ] 首次临时密码必须处理 `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`，在 Login 页面要求输入新密码；错误文案区分凭据错误、密码更新、网络错误和配置错误。
- [ ] 运行 focused Web tests、`pnpm run typecheck:web`、`pnpm run build:web`、`pnpm run test:web` 和 `git diff --check`。
- [ ] 提交：`git commit -m "feat(web): 切换 Cognito 登录与角色路由"`

---

### Task 5: 建立 Web 的类型安全 Data/Storage repository

**Files:**

- Create: `apps/web/src/data/client.ts`
- Create: `apps/web/src/data/errors.ts`
- Create: `apps/web/src/data/daily-reports.ts`
- Create: `apps/web/src/data/daily-reports.spec.ts`
- Create: `apps/web/src/data/master-data.ts`
- Create: `apps/web/src/data/master-data.spec.ts`
- Create: `apps/web/src/data/attachments.ts`
- Create: `apps/web/src/data/attachments.spec.ts`
- Modify: `apps/web/tsconfig.app.json`

**Repository boundary:**

```ts
export interface CreateDailyReportCommand {
  businessDate: string;
  shiftId: string;
  shiftNameSnapshot: string;
  responsiblePersonId: string;
  responsiblePersonSnapshot: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  timeRangeLabelSnapshot: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  expenseReason?: string;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  attachmentKeys: string[];
}
```

- [ ] 使用 `generateClient<Schema>()` 建立单例 Data client；Repository 是 Vue 页面唯一可调用的持久化边界，页面不得直接调用 generated client。
- [ ] 写 create RED：repository 用共享 `dailyReportKey()` 构造 `reportKey`，设置 ISO `submittedAt`，不接收/发送 owner、角色或五个派生金额。
- [ ] 写 conflict RED：GraphQL conditional/duplicate key 错误统一映射为 `REPORT_ALREADY_EXISTS`；网络/未知结果映射为 `SUBMISSION_RESULT_UNKNOWN`，保留原始 cause 供日志但不显示敏感 payload。
- [ ] 写 owner query RED：`listByBusinessDate(date)` 必须调用 `dailyReportsByBusinessDate` index query，不可调用全表 list；分页读取直到 `nextToken` 为空。
- [ ] 写 master-data RED：厨房只调用 custom `getKitchenContext`；OWNER 的 shift/person/setting CRUD 使用模型 API，并在 UI repository 校验金额和启用状态。
- [ ] 写 attachment RED：上传 key 只能来自 `submissionKey(identityId, draftId, attachmentId, fileName)`；厨房代码没有 list/download/remove 方法导出；owner repository 才暴露读取与删除。
- [ ] 运行 focused tests 后实现最小 repository；所有 Data 返回的 `errors` 非空都必须作为失败处理，不能只检查 `data`。
- [ ] 运行 `pnpm run test:web`、`pnpm run typecheck:web`、`pnpm run build:web` 和 `git diff --check`。
- [ ] 提交：`git commit -m "feat(web): 建立 Amplify Data 访问层"`

---

### Task 6: 改造厨房 create-only 填报流程

**Files:**

- Create: `apps/web/src/views/kitchen/KitchenHomeView.vue`
- Create: `apps/web/src/views/kitchen/KitchenReportView.vue`
- Create: `apps/web/src/views/kitchen/submission-state.ts`
- Create: `apps/web/src/views/kitchen/submission-state.spec.ts`
- Delete: `apps/web/src/views/wm/WmHomeView.vue`
- Delete: `apps/web/src/views/wm/DailyFormView.vue`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/components/daily-report/DailyReportFormFields.vue`
- Modify: `apps/web/src/components/daily-report/DailyReportConfirmSummary.vue`
- Modify: `apps/web/src/composables/useDailyReportFormState.ts`
- Modify: `apps/web/src/composables/useDailyReportFormState.spec.ts`
- Modify: `apps/web/src/utils/daily-report-form-validate.ts`
- Modify: `apps/web/src/utils/daily-report-form-validate.spec.ts`

- [ ] 写状态机 RED，状态只允许 `editing -> confirming -> submitting -> succeeded|failed|unknown`；`submitting` 时第二次点击无效；失败/未知回到可重试状态且字段不重置。
- [ ] KitchenHome 只调用 `getKitchenContext`，显示营业日和启用班次入口；不得调用日报 list/get，也不显示“已提交数量、历史金额、统计或设置”。
- [ ] KitchenReport 用 context 中的底钱、班次和责任人构造快照，继续使用共享计算显示确认页；表单金额和网管餐费校验沿用 `MAX_YEN`。
- [ ] 成功后只展示本次 create 响应的摘要、`reportKey` 与提交时间；不得为了确认再次读取日报。用户可返回厨房首页开始另一班次。
- [ ] `REPORT_ALREADY_EXISTS` 显示“该营业日和班次可能已提交，请老板确认”；`SUBMISSION_RESULT_UNKNOWN` 显示“结果不确定，请勿反复修改数据，重试会检查同一营业日和班次冲突”。
- [ ] 为共享表单增加 `variant="kitchen"` 与 kitchen 时间提示；本任务先保留管理员页面仍使用的旧 submitter props，Task 7 在管理员迁移时一次删除，保证 Task 6 提交后仍可 typecheck/build。
- [ ] 通过静态测试或 repository spy 证明 kitchen views 未 import owner repository，未调用 DailyReport query/update/delete。
- [ ] 运行 `pnpm run test:web`、`pnpm run typecheck:web`、`pnpm run build:web`、`rg "WEBMASTER|Webmaster|/wm|網管側" apps/web/src/views/kitchen apps/web/src/router`（零命中）和 `git diff --check`。
- [ ] 提交：`git commit -m "feat(web): 实现厨房只提交账务流程"`

---

### Task 7: 将老板日报、修正与设置切换到 Amplify Data

**Files:**

- Modify: `apps/web/src/views/admin/AdminShellView.vue`
- Modify: `apps/web/src/views/admin/AdminDailyView.vue`
- Modify: `apps/web/src/views/admin/AdminReportFormView.vue`
- Modify: `apps/web/src/views/admin/AdminSettingsView.vue`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/components/daily-report/DailyReportFormFields.vue`
- Modify: `apps/web/src/components/daily-report/DailyReportConfirmSummary.vue`
- Modify: `apps/web/src/components/daily-report/daily-report-form.types.ts`
- Delete: `apps/web/src/components/daily-report/DailyReportSubmitterFields.vue`
- Delete: `apps/web/src/views/admin/AdminBackupView.vue`
- Create: `apps/web/src/data/date-range.ts`
- Create: `apps/web/src/data/date-range.spec.ts`

- [ ] 写日期范围 RED：生成东京营业日闭区间；最大一次读取 366 日，超过时拒绝，避免意外无限请求。
- [ ] AdminDaily 默认查询最近 90 天，并对每一天调用 index repository；保留按日分组、两种餐费明细、派生餐费合计和横向滚动。
- [ ] AdminReportForm 新建时由 OWNER 创建；编辑时通过 `reportKey` get/update。更新不得修改 `reportKey`、`businessDate`、`shiftId`、owner 或原 `submittedAt`。
- [ ] 设置页用 Amplify Data 管理 `AppSetting/default`、ShiftDefinition 和 ResponsiblePerson；停用用 `active=false`，不得删除已被历史日报快照引用的业务名称。
- [ ] 删除旧“提交元（网管）”选择。OWNER 补录时将当前 Cognito OWNER 作为创建主体，并可在备注/审计文案标示“老板补录”。
- [ ] AdminShell 显示角色“老板”，保留日报、设置、统计/导出三个菜单；删除旧 NestJS backup/restore 菜单，因为新备份由 PITR/S3 versioning 与迁移文件承担。
- [ ] 错误处理必须覆盖 unauthorized、not found、conflict、pagination 和网络错误；页面不得 import axios `http`。
- [ ] 删除 shared daily-report components 中的旧 webmaster submitter props/type/section；运行 `rg "WEBMASTER|Webmaster|/wm|網管側" apps/web/src -g '!api/http.ts'`，除“网管餐费”业务文案外零命中。
- [ ] 运行 `rg "@/api/http" apps/web/src/views/admin/AdminDailyView.vue apps/web/src/views/admin/AdminReportFormView.vue apps/web/src/views/admin/AdminSettingsView.vue`，期望零命中；再运行 Web 全测、typecheck、build 和 diff check。
- [ ] 提交：`git commit -m "feat(web): 迁移老板账务与设置"`

---

### Task 8: 在老板端重建统计与 CSV 导出

**Files:**

- Create: `apps/web/src/analytics/report-analytics.ts`
- Create: `apps/web/src/analytics/report-analytics.spec.ts`
- Create: `apps/web/src/export/report-csv.ts`
- Create: `apps/web/src/export/report-csv.spec.ts`
- Modify: `apps/web/src/views/admin/AnalyticsView.vue`
- Modify: `apps/web/src/composables/useEchartsBarChart.ts`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Delete: `apps/web/src/api/http.ts`
- Delete: `apps/web/src/utils/http-error-message.ts`

**Aggregation:**

```ts
export interface ReportAggregate {
  count: number;
  imosSalesYen: number;
  cashDepositYen: number;
  totalSalesYen: number;
  expenseYen: number;
  deviationYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  staffMealTotalYen: number;
}
```

- [ ] 写聚合 RED，覆盖区间总计、按班次合计、单日逐班明细、空数据和跨夜时间；每行必须先用 `@fsk/domain` 计算再累加。
- [ ] 特别锁定餐费：现金与支付宝分别汇总；图表“实际売上”只使用 `totalSalesYen`；支付宝变化不得改变销售柱状图。
- [ ] 写 CSV RED：UTF-8 BOM、RFC 4180 escaping、稳定列顺序、日文标题、两种餐费与派生合计；公式开头的备注必须加前导单引号防 CSV injection。
- [ ] AnalyticsView 使用 date-range + DailyReport index repository 获取数据，在浏览器计算；不得调用 `/analytics` 或 `/export`。
- [ ] 第一版导出按钮改为 CSV。Excel/PDF Function 不在本任务增加；只有老板确认仍需要这两种格式时才另开独立功能任务。
- [ ] 保留 period day/week/month/quarter/year 和东京日历边界；最大 366 日。
- [ ] 删除已无 import 的 axios HTTP 封装、HTTP error helper和 `axios` dependency；运行 `rg "@/api/http|/analytics|/export" apps/web/src`，期望零命中。
- [ ] 运行 analytics/export focused tests、Web 全测、typecheck、build 和 diff check。
- [ ] 提交：`git commit -m "feat(web): 重建老板统计与 CSV 导出"`

---

### Task 9: 增加 iOS 15.8.4 可用的 standalone PWA 壳

**Files:**

- Create: `apps/web/public/manifest.json`
- Create: `apps/web/public/app-icon.svg`
- Create: `apps/web/public/icons/icon-180.png`
- Create: `apps/web/public/icons/icon-192.png`
- Create: `apps/web/public/icons/icon-512.png`
- Create: `apps/web/scripts/generate-app-icons.mjs`
- Create: `apps/web/src/pwa-manifest.spec.ts`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/style.css`

- [ ] 写 RED，读取 `manifest.json` 和 `index.html`，断言 `display: "standalone"`、`start_url: "/"`、manifest link、`apple-mobile-web-app-capable=yes`、Apple title/status bar、180px touch icon、192/512 icons。
- [ ] 写负向测试：仓库与构建配置不得注册 Service Worker，不得包含 Workbox、offline queue、Background Sync 或 `display: fullscreen`。
- [ ] 创建方形 FSK 财务图标源文件；生成脚本用固定版本 `sharp` 输出三张 PNG，测试读取 PNG header/dimensions，避免把 SVG 当作 iOS 15 touch icon。
- [ ] `index.html` 增加：

```html
<link rel="manifest" href="/manifest.json" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="FSK財務" />
<link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png" />
```

- [ ] CSS 使用 `100dvh` + `-webkit-fill-available` 回退并保留 `viewport-fit=cover`/safe-area padding，避免 iPhone 7 Plus standalone 底部内容被遮挡。
- [ ] 运行 icon generation、PWA tests、Web 全测、typecheck、build；检查 `dist/manifest.json` 与三张 icons 实际存在且 MIME/尺寸正确。
- [ ] 提交：`git commit -m "feat(web): 支持 iOS 主屏幕独立运行"`

---

### Task 10: 建立 SQLite/uploads 的可重复 dry-run 转换

**Files:**

- Create: `apps/api/scripts/amplify-migration/contracts.ts`
- Create: `apps/api/scripts/amplify-migration/transform.ts`
- Create: `apps/api/scripts/amplify-migration/transform.spec.ts`
- Create: `apps/api/scripts/amplify-migration/inventory.ts`
- Create: `apps/api/scripts/amplify-migration/report.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`

**Migration bundle:**

```ts
export interface MigrationBundle {
  shifts: ShiftDefinitionRecord[];
  responsiblePersons: ResponsiblePersonRecord[];
  appSetting: AppSettingRecord;
  dailyReports: DailyReportRecord[];
  attachments: AttachmentManifestEntry[];
  sourceSummary: MigrationSummary;
}
```

- [ ] 写 RED：固定 SQLite fixture 转换后保留所有原始账务字段、快照、两个网管餐费字段、班次/责任人/设置；`reportDate` 映射为 `businessDate`。
- [ ] 锁定确定性：日报 `reportKey=dailyReportKey(reportDate, shiftId)`；同一输入两次转换 JSON byte-for-byte 相同；同一复合 key 的不同源记录必须报告冲突并停止。
- [ ] 旧日报没有可信 createdAt 时，`submittedAt` 使用源 `updatedAt`，同时在报告标为 `LEGACY_SUBMITTED_AT_FROM_UPDATED_AT`；不得伪造精确原提交时间。
- [ ] `createdBy.username` 只写 `legacySubmittedByUsername`，不得迁移 bcrypt hash、旧 role 或伪造 Cognito subject/owner。
- [ ] uploads inventory 只读遍历文件，记录相对 key、byte size、SHA-256、关联日报线索和 orphan 状态；路径逃逸、重复 key 或哈希失败必须 fail closed。
- [ ] dry-run 报告包含：各模型记录数、每日/全局原始金额和派生金额总计、现金/支付宝餐费分别合计、附件数/bytes/hash、冲突与 orphan 列表。
- [ ] CLI 必须要求显式 `--sqlite`、`--uploads`、`--out`；默认只读且不连接 AWS。输出目录不在仓库内时才能包含真实数据。
- [ ] 在临时复制的 fixture 上运行 focused tests 和 dry-run；不得读取或修改真实 `dev.db`。
- [ ] 运行 API tests、domain tests、typecheck、build 和 diff check。
- [ ] 提交：`git commit -m "feat(migration): 建立 SQLite 转换与盘点"`

---

### Task 11: 实现幂等 DynamoDB/S3 导入与 Cognito 新账号工具

**Files:**

- Create: `apps/api/scripts/amplify-migration/target.ts`
- Create: `apps/api/scripts/amplify-migration/target.spec.ts`
- Create: `apps/api/scripts/amplify-migration/import.ts`
- Create: `apps/api/scripts/amplify-migration/verify.ts`
- Create: `apps/api/scripts/amplify-migration/provision-users.ts`
- Create: `apps/api/scripts/amplify-migration/provision-users.spec.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] 定义可 mock 的 Target interface；先写 RED，证明首次 apply 创建、相同输入第二次 no-op、同 key 不同内容冲突、部分失败可恢复且不会静默覆盖。
- [ ] DynamoDB 写入使用条件表达式 `attribute_not_exists`；遇到已存在项时强一致读取并比较规范化内容，只有完全相同才计为 no-op。
- [ ] 导入顺序固定为 ShiftDefinition、ResponsiblePerson、AppSetting、DailyReport、S3 attachments；任一步失败停止后续阶段并输出可重跑 checkpoint。
- [ ] S3 key 固定为 `migration/daily-reports/{reportKey}/{sha256}-{safeFileName}`；上传后用 HeadObject 核对 size、checksum metadata，重复执行不得产生新 key。
- [ ] verify 从目标独立读取并重算：模型数、逐日金额、五个派生合计、两种餐费合计和附件 checksum；不能仅复用 importer 的成功计数。
- [ ] provision-users 只创建两个 username-only Cognito 用户并加入 `OWNER`/`KITCHEN`；临时密码只从进程环境读取，不输出、不写报告。旧 bcrypt、email、phone 和 `WEBMASTER/ADMIN` 不迁移。
- [ ] 所有 AWS 客户端显式检查账号 `444083008754`、region `ap-northeast-1`、FSK App/stack/table/bucket tags；任何目标与 GameList 或未知资源不一致立即退出。
- [ ] CLI 默认 `--dry-run`；只有同时提供 `--apply --approval-id <id>` 才能写入。单元测试使用 mock clients，当前任务不得调用 AWS。
- [ ] 运行 migration focused tests、API/domain tests、`pnpm run check:all` 和 diff check。
- [ ] 提交：`git commit -m "feat(migration): 实现幂等 Amplify 数据导入"`

---

### Task 12: 建立独立 Hosting 构建、部署与切换手册

**Files:**

- Create: `amplify.yml`
- Create: `customHttp.yml`
- Create: `docs/aws/dynamodb-deployment-runbook.md`
- Create: `docs/aws/dynamodb-cutover-runbook.md`
- Create: `docs/aws/dynamodb-retirement-runbook.md`
- Create: `amplify/dynamodb-deployment-contract.spec.ts`
- Modify: `README.md`
- Modify: `RELEASING.md`

- [ ] 写文档/构建契约 RED：新手册只允许独立 FSK App，活动架构不得出现 Aurora/RDS/VPC/NAT/PostgreSQL；三个审批门必须分开。
- [ ] `amplify.yml` 使用 frozen install，先部署/生成 backend outputs 到 `apps/web/public`，再运行 `pnpm run check:all` 与 Web build；artifact base directory 为 `apps/web/dist`。
- [ ] `customHttp.yml` 允许 `/manifest.json`、icons 和静态资源直接返回，其他无扩展名路由 rewrite 到 `index.html`；不得把 manifest rewrite 成 HTML。
- [ ] Deployment runbook 记录账号/region、独立 App 名、branch、commit、stack、Auth/Data/Storage/Hosting resource IDs、GameList 隔离证据、On-Demand/PITR/versioning、无 RDS/VPC 的 synth/live 证据。
- [ ] Cutover runbook 包含只读盘点、SQLite/uploads 备份、dry-run、旧系统冻结、最终副本、apply、独立 verify、权限负向测试、两机验收和失败回退边界。
- [ ] Retirement runbook 明确旧 NestJS/SQLite 先只读保留；Aurora/Foundation 销毁是 Gate C，不能由新部署或迁移批准隐含授权。
- [ ] README 的默认生产架构改为 Amplify Data/DynamoDB；NestJS/SQLite 标注为 legacy migration/source 和本地回退，不删除启动说明直到切换完成。
- [ ] 运行 runbook contract tests、每个 bash fence 的 `bash -n`、`pnpm run check:all`、Web build、synth 和 diff check。
- [ ] 提交：`git commit -m "docs(amplify): 定义 DynamoDB 部署与切换流程"`

---

### Task 13: 完整本地审查并创建部署恢复点

**Files:**

- Review: Task 1–12 的全部 committed diff
- Append evidence: `docs/aws/dynamodb-deployment-runbook.md`

- [ ] 使用 `superpowers:requesting-code-review` 做 spec compliance 与 code quality 两轮独立审查；任何 finding 用 `superpowers:receiving-code-review` 逐项验证，按 TDD 最小修正并重新 review。
- [ ] 从干净 checkout 运行 `pnpm install --frozen-lockfile`、`pnpm run check:all`、production build、Amplify synth、manifest MIME 检查、repository auth contract 和 migration fixture dry-run/second-run no-op。
- [ ] 生成 Graphify 架构图，确认 Vue 页面只通过 Amplify repositories，厨房无历史/设置路径，活动 backend 不 import Foundation/PostgreSQL。
- [ ] 检查 `git status --short` 干净；确认未提交 `amplify_outputs.json`、真实数据、uploads、凭据、Graphify 输出或临时报告。
- [ ] 将本地审查和验证证据追加到 deployment runbook，并提交：`git commit -m "docs(amplify): 记录 DynamoDB 本地验收"`。
- [ ] 创建 annotated local recovery tag `fsk-amplify-data-dynamodb-v1`；此任务不 push、不调用 AWS、不移动旧 Foundation tag。

---

### Task 14: 审批门 A——部署独立 FSK App 与合成数据

**Files:**

- Append evidence after approval: `docs/aws/dynamodb-deployment-runbook.md`

**Required approval scope:**

```text
批准将 fsk-amplify-data-dynamodb-v1 推送到远程，并在 AWS 账号 444083008754、ap-northeast-1 创建独立 FSK Amplify Gen 2 App，部署 Auth/Data/Storage/Function/Hosting 并只使用合成账号、合成账务和合成附件；不迁移真实 SQLite、users、uploads，不冻结旧系统，不删除旧 Aurora/Foundation。
```

- [ ] 未收到同等明确的本轮批准时停止；不复用旧 PostgreSQL 方案的批准。
- [ ] 只读确认账号/region、remote branch/tag、App 名未占用和 GameList 资源边界；CAS push 精确 commit/tag。
- [ ] 创建独立 Amplify App 并部署；保存 build/deploy ID、commit、outputs、CloudFormation stack 和资源清单。
- [ ] 创建合成 OWNER/KITCHEN 账号与合成记录；不要使用真实姓名、密码、账务或附件。
- [ ] 执行 live 权限矩阵：KITCHEN create 成功；DailyReport get/list/update/delete、AppSetting、统计/owner routes、附件 list/read/delete 全部失败；OWNER 正向能力成功。
- [ ] 验证复合 key 重复冲突、网管餐费公式、PITR、S3 versioning、Hosting `/manifest.json` JSON MIME、SPA route、无 RDS/VPC/NAT 和 GameList ARN 零引用。
- [ ] 删除合成业务数据但保留部署环境，记录残留清单；任何失败按 runbook 停止，不进入真实迁移。
- [ ] 提交部署证据：`git commit -m "docs(amplify): 记录 DynamoDB 合成验收"`

---

### Task 15: 审批门 B——迁移真实数据并一次切换

**Files:**

- Append evidence after approval: `docs/aws/dynamodb-cutover-runbook.md`

**Required approval scope:**

```text
批准在已验收的独立 FSK Amplify App 上创建新的 OWNER/KITCHEN Cognito 用户，读取并备份指定的真实 SQLite 和 uploads，在切换窗口冻结旧系统写入，执行 dry-run、幂等导入、独立核对和两台 iPhone 验收；不删除旧 SQLite/uploads 备份，不删除旧 Aurora/Foundation，不修改 GameList。
```

- [ ] 批准前只读定位权威 SQLite/uploads 路径、运行主机、备份位置和切换窗口；目标有歧义立即停止。
- [ ] 冻结前执行 inventory/dry-run，人工签认记录数、金额、两种餐费、附件和冲突/orphan 报告。
- [ ] 在下一班次提交前冻结旧系统写入，制作带 timestamp 与 SHA-256 的最终 SQLite/uploads 副本；保留旧系统只读访问。
- [ ] 创建新 Cognito 用户并强制临时密码更新；旧 bcrypt hash 不导入。
- [ ] 使用相同最终副本再跑 dry-run，然后 apply；第二次 apply 必须全 no-op；独立 verify 必须逐项等于签认报告。
- [ ] 权限负向测试必须用真实 KITCHEN token 重跑；OWNER 核对历史、修改、统计、CSV 和设置。
- [ ] 在 iPhone 16 Pro Max 当前 iOS 和 iPhone 7 Plus iOS 15.8.4 上分别：Safari 打开、添加主屏幕、从图标启动、确认无 Safari 地址栏、登录、填报/老板查看、旋转/安全区/键盘、重新启动 session。
- [ ] 首笔新账务前失败可解除冻结回旧系统；首笔新账务后不得直接回双写，必须先导出新记录并完成受控对账。
- [ ] 成功后把旧 NestJS/SQLite 标记只读，记录 cutover time、首笔新 `reportKey` 和验收人；提交证据：`git commit -m "docs(amplify): 记录 FSK DynamoDB 正式切换"`

---

### Task 16: 审批门 C——保留期后退役旧运行层与 Foundation

**Files:**

- Modify only after approval: `README.md`
- Modify only after approval: `RELEASING.md`
- Delete only after approval and verified retention: `amplify/backend.foundation.ts`
- Delete only after approval and verified retention: `amplify/infrastructure/staging-foundation.ts`
- Delete only after approval and verified retention: `amplify/infrastructure/staging-foundation.spec.ts`
- Delete only after approval and verified retention: `amplify/database/**`
- Append evidence after approval: `docs/aws/dynamodb-retirement-runbook.md`

- [ ] 至少完成约定观察期，确认 DynamoDB 导入、统计、权限、设备和备份恢复验收仍为 PASS；确认无流量或工具依赖旧 Aurora/Foundation。
- [ ] 另行请求明确销毁批准，范围必须列出精确 App/stack/resource IDs；不得使用模糊名称、glob 或账号级批量删除。
- [ ] 删除前导出 CloudFormation、Aurora snapshot/备份证据和最终成本清单；SQLite/uploads 原始备份继续按保留策略保存。
- [ ] 先删除旧云端 Foundation，再只读验证 Aurora/VPC/NAT/Secret/相关 stacks 归零且新 FSK App 正常；报告可恢复性与不可恢复边界。
- [ ] 只有云端销毁成功并确认不再需要 rollback tooling 后，才删除旧 Foundation/PostgreSQL 源码、依赖和 scripts；NestJS/Prisma 是否完全删除另开小范围任务，避免与云端销毁混在同一 commit。
- [ ] 运行 `pnpm install --frozen-lockfile`、`pnpm run check:all`、新 backend synth、production build 和 live smoke；提交：`git commit -m "chore(amplify): 退役旧 Data API foundation"`

---

## Final Acceptance Checklist

- [ ] 活动 Amplify backend 只包含 Cognito、AppSync/DynamoDB、S3 和必要的 Kitchen Context Function；无 Aurora/VPC/NAT/PostgreSQL/NestJS 运行依赖。
- [ ] Cognito 只有 `OWNER`、`KITCHEN`；厨房可提交但无法读取历史、统计、设置、修改或删除。
- [ ] 同一营业日/班次无法生成第二条日报，未知响应重试不会覆盖原记录。
- [ ] 网管餐费现金进入现金入金、两种餐费都不进入实际売上、支付宝独立保存；确认/统计/CSV/迁移核对一致。
- [ ] 老板可维护班次、责任人、底钱，查看/更正日报，查看期间与班次统计并导出 CSV。
- [ ] SQLite、设置、班次、责任人、日报和 uploads 的记录数、金额、两种餐费合计与附件 checksum 核对一致。
- [ ] FSK 与 GameList 的 App/Auth/Data/Storage/Hosting/stack/outputs 全部隔离。
- [ ] DynamoDB PITR、S3 versioning、public block 和 FSK production tags 已在 live 资源验证。
- [ ] 两台指定 iPhone 从主屏幕以 standalone 运行；iOS 15.8.4 不依赖 Service Worker 或新浏览器 API。
- [ ] 旧系统只读且无双写；旧 Aurora/Foundation 只有在 Gate C 单独批准并验证后才删除。
