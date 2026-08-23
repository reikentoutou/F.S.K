# FSK Amplify Gen 2 Data API 成本优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不影响现有 NestJS/SQLite 本地运行层的前提下，建立一个低固定成本的 FSK staging Web App：Vue/PWA 由 Amplify Hosting 托管，Cognito 仅提供 `ADMIN` 与 `KITCHEN`，API Gateway HTTP API 将厨房与管理员请求路由到 Amplify Functions，Functions 只通过 RDS Data API 访问私有 Aurora PostgreSQL `0–1 ACU`。

**Architecture:** 以提交 `6aea03d` 为起点，保留已完成的 Auth、Storage、VPC、Aurora、SQL migration 和合成 seed 基础；先删除长期 SSM Interface Endpoint 并把 Aurora 上限降至 1 ACU，再用共享业务契约、参数化 Data API 适配器和分离的 Kitchen/Admin/Export Functions 构建 HTTP API。厨房端只获取当前填报上下文并提交，不能读取历史、统计或设置；管理员端拥有列表、更正、统计、导出和附件下载。前端保留本地 NestJS 模式作为回滚路径，staging 模式切换到 Cognito 与 HTTP API。首次 AWS 写入、完整 backend、Hosting、监控和销毁分别经过独立审批门。

**Tech Stack:** TypeScript 5、AWS Amplify Gen 2、AWS CDK、API Gateway v2 HTTP API、Cognito User Pool、Amplify Functions/Lambda、AWS SDK v3 RDS Data API、Aurora PostgreSQL Serverless v2、S3/Amplify Storage、Vue 3、Pinia、Vue Router 4、Element Plus、Vite、Vitest、pnpm 9。

**Spec:** `docs/superpowers/specs/2026-08-23-amplify-gen2-data-api-cost-optimization-design.md`

## Global Constraints

- 本计划取代 `docs/superpowers/plans/2026-08-23-amplify-gen2-staging-infrastructure.md` 尚未执行的 Task 7–18；旧计划 Task 1–6 的本地成果是输入，不重做。
- 云端只允许 AWS account `444083008754`、region `ap-northeast-1`、独立 staging App/branch；不得创建 production、PR preview 或连接 `main` 自动部署。
- 云端角色只有 `ADMIN`、`KITCHEN`。现有本地 `WEBMASTER` 只作为 NestJS/SQLite 回滚兼容，不得进入 Cognito group、PostgreSQL role 或新 HTTP API 契约。
- 不创建 Amplify Data/AppSync、SQL Lambda、Updater Lambda、`schema.sql.ts`、RDS Proxy、长期 NAT 或长期 SSM Interface Endpoint。
- Aurora 必须为 `MinCapacity=0`、`MaxCapacity=1`、Data API enabled、private、deletion protection enabled。
- Function 不进入 VPC、不建立 PostgreSQL TCP 连接池；SQL 必须固定且参数化，客户端不能提交 SQL 片段、派生金额、角色、审计身份或正式 S3 key。
- 网管餐费契约不变：`staffMealCashYen` 计入 `cashDepositYen`；`staffMealCashYen` 与 `staffMealAlipayYen` 都不计入 `totalSalesYen`；支付宝独立保存；统计和导出显示现金、支付宝及派生合计。
- Kitchen 只允许当前填报上下文、提交和本人 pending 附件预签名；历史日报、统计、设置、正式附件读取和 `/admin/*` 必须由服务端返回 `403`。
- 写入请求必须携带稳定 `idempotencyKey`。Aurora 唤醒中的暂时错误统一映射为 `503 DATABASE_RESUMING`；前端必须复用同一个 key 有限重试，并保留表单。
- 真实 SQLite、用户、bcrypt hash 和 uploads 的迁移属于后续 Phase C；本计划只使用合成账号、合成账务和合成文件。
- 每个任务先写失败测试，再做最小实现；任务末尾运行目标测试和 `pnpm run check:all`，然后只提交该任务范围。
- 任何 AWS/Git remote 写入都必须停在对应审批任务，获得本轮明确授权后才可执行；计划文档本身不构成授权。
- `graphify-out/` 是本地分析产物，不纳入本计划的 Git 提交。

---

### Task 1: 把已完成 Foundation 修正为 Data API 低成本边界

**Files:**

- Modify: `amplify/infrastructure/staging-foundation.ts`
- Modify: `amplify/infrastructure/staging-foundation.spec.ts`
- Modify: `amplify/backend-composition.spec.ts`

**Interfaces:**

```ts
export interface StagingFoundation {
  readonly cluster: rds.DatabaseCluster;
  readonly clusterSecret: secretsmanager.ISecret;
  readonly databaseName: string;
  // 不新增 SQL connection string、SSM parameter 或 Function SG 输出。
}
```

- [ ] 在 `staging-foundation.spec.ts` 先将期望改为：只有 1 个 `AWS::EC2::VPCEndpoint`，类型为 S3 Gateway；SSM Interface Endpoint 数量为 0；Aurora `MaxCapacity` 为 1。
- [ ] 在 `backend-composition.spec.ts` 添加负向断言：合成模板中不存在 `com.amazonaws.ap-northeast-1.ssm`、`AWS::RDS::DBProxy`、`AWS::EC2::NatGateway`、AppSync API、SQL/Updater Lambda。
- [ ] 运行 `pnpm exec vitest run --config amplify/vitest.config.ts amplify/infrastructure/staging-foundation.spec.ts amplify/backend-composition.spec.ts`，确认因旧的 SSM endpoint 和 `MaxCapacity: 2` 失败。
- [ ] 从 `createStagingFoundation()` 删除 `vpc.addInterfaceEndpoint('SsmEndpoint', ...)`，将 `serverlessV2MaxCapacity` 改为 `1`；不改 S3 Gateway、私有子网、Data API、自动暂停和 deletion protection。
- [ ] 更新 taggable resource count，确保仍对所有实际存在的资源检查四个成本标签。
- [ ] 重新运行 focused tests，期望全部通过；再运行 `pnpm run check:all` 和 `git diff --check`。
- [ ] 提交：`git commit -m "fix(amplify): 收紧 Data API staging foundation"`

---

### Task 2: 将成本审批和部署手册改写为无 Connector 流程

**Files:**

- Modify: `docs/aws/staging-cost-approval.md`
- Modify: `docs/aws/staging-deployment-runbook.md`
- Create: `docs/aws/staging-migration-runbook.md`
- Modify: `amplify/backend-composition.spec.ts`

**Documentation contract:**

```text
Foundation: Auth + Storage + VPC + Aurora/Data API
Migration: CloudShell VPC + 临时 NAT/IGW/EIP + 临时运维 SG
Full backend: HTTP API + Kitchen/Admin/Export Functions
Hosting: Vue/PWA
Persistent network: no NAT, no Interface Endpoint, no 5432 ingress
MonthlyCeilingJpy: 5000
GateStatus: NOT_APPROVED
```

- [ ] 先在 `backend-composition.spec.ts` 将旧 runbook 契约改为读取两份文档，并断言旧术语 `ampx generate schema-from-database`、`schema.sql.ts`、`SQL_CONNECTION_STRING`、AppSync、SQL Lambda、长期 SSM endpoint 不得出现于可执行步骤。
- [ ] 添加新契约：migration 手册必须有 operation token、deadline、失败 trap、临时出口所有权标签、残留发现、migration 第一次 apply/第二次 no-op、verify 和最终 cleanup。
- [ ] 运行 `pnpm run test:amplify`，确认旧成本表和旧 2918 行手册使测试失败。
- [ ] 将长期部署步骤压缩到 `staging-deployment-runbook.md`；把临时网络和数据库迁移的可执行流程移动到 `staging-migration-runbook.md`，避免继续在单一文档叠加控制逻辑。
- [ ] 在成本表删除 SSM Interface Endpoint 和 AppSync 成本项，新增 API Gateway HTTP API、Data API 调用、业务 Functions；记录低使用约 `¥1,000`、1 ACU 指定最坏月约 `¥19,600`、治理上限 `¥5,000`，并明确后者超限时自动使审批失效、停止新增写入并进入复查，以及部署日重新计算。
- [ ] 保持 `GateStatus=NOT_APPROVED`，审批字段不得预填为已批准；分别列出 Foundation、Migration、Full backend、Hosting、Budget/alarms、Destroy 六个写入阶段。
- [ ] 运行 `pnpm run test:amplify`、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "docs(amplify): 改写 Data API staging 部署流程"`

---

### Task 3: 独立审查修正后的 Foundation 并建立新恢复点

**Files:**

- Review only: `amplify/infrastructure/staging-foundation.ts`
- Review only: `amplify/infrastructure/staging-foundation.spec.ts`
- Review only: `amplify/backend.ts`
- Review only: `docs/aws/staging-cost-approval.md`
- Review only: `docs/aws/staging-deployment-runbook.md`
- Review only: `docs/aws/staging-migration-runbook.md`

**Recovery point:**

```text
tag: fsk-staging-data-api-foundation-v1
resource set: auth, storage, vpc, aurora, dataApi
forbidden: appSync, sqlLambda, updaterLambda, interfaceEndpoint, natGateway
```

- [ ] 使用 `superpowers:requesting-code-review` 对 Task 1–2 的 diff 做独立 spec/code-quality review；有 finding 时使用 `superpowers:receiving-code-review`，按 TDD 最小修正后重新 review。
- [ ] 运行 `pnpm install --frozen-lockfile`、`pnpm run check:all`、foundation synth、`git diff --check`，保存命令、退出码、测试数量和合成资源计数。
- [ ] 确认工作树干净、HEAD 包含 `6aea03d`，且新 tag 名在本地和 remote 都不存在。
- [ ] 创建 annotated local tag：`git tag -a fsk-staging-data-api-foundation-v1 -m "FSK staging Data API foundation recovery point"`。
- [ ] 不移动或删除旧的 `fsk-staging-foundation-v1`；它继续标识旧设计的最后恢复点。
- [ ] 此任务不 push、不创建 Amplify App、不调用 AWS 写 API。

---

### Task 4: 审批门 A——推送恢复点并部署 Foundation

**Files:**

- Modify after approval: `docs/aws/staging-cost-approval.md`
- Append evidence after execution: `docs/aws/staging-deployment-runbook.md`

**Required user approval statement:**

```text
批准将 fsk-staging-data-api-foundation-v1 推送到远程，并在 AWS 账号 444083008754、ap-northeast-1 创建独立 FSK staging Foundation；月治理上限 ¥5,000，不包含完整 backend、Hosting、Budget/alarms、销毁或真实数据迁移。
```

- [ ] 未收到上面同等明确的本轮授权时停止；不得把设计确认、计划确认或旧登录状态当作部署批准。
- [ ] 只读确认调用者账号、region、Aurora PostgreSQL 目标版本在东京支持 `db.serverless` 与 0 ACU、Amplify App 名称未占用、remote staging/tag 未占用。
- [ ] 用 CAS 方式创建 remote `staging` branch 并推送精确 tag；竞态或 remote 指针不一致立即停止。
- [ ] 创建独立 Amplify Gen 2 App 和 staging branch，关闭 Auto build；只部署 foundation 组合。
- [ ] 核对 CloudFormation：Aurora `0–1 ACU`、Data API enabled、private、无 Proxy/NAT/Interface Endpoint；Cognito 仅 `ADMIN`/`KITCHEN`；Storage private/versioned/keepOnDelete。
- [ ] 将实际 App ID、branch、stack、资源 ARN、部署 commit、价格证据和 ApprovalId 写回成本审批文档；Secret 值不得写入文件或日志。
- [ ] 失败时按 runbook 执行获准范围内的恢复；任何销毁仍需单独批准。
- [ ] 提交证据：`git commit -m "docs(amplify): 记录 Data API foundation 部署证据"`

---

### Task 5: 审批并执行 CloudShell VPC 数据库迁移

**Files:**

- Use: `amplify/database/migrations/001_bootstrap.sql`
- Create: `amplify/database/migrations/002_data_api_runtime_contract.sql`
- Modify: `amplify/database/scripts/migration-lib.spec.ts`
- Use: `amplify/database/scripts/migrate.ts`
- Modify: `amplify/database/scripts/verify-schema.ts`
- Modify: `amplify/database/scripts/seed-staging.ts`
- Append evidence: `docs/aws/staging-migration-runbook.md`

**Runtime schema additions:**

```text
pending_attachment: presign ownership, expected MIME/size/hash, expiry, consumed_at
admin_change_log: settings/master-data before/after, actor subject, request_id, JST timestamp
daily_report_revision: initial submission and admin correction audit snapshots
```

**Required user approval statement:**

```text
批准在已部署的 FSK staging Foundation 上创建带 operation token 的临时 CloudShell VPC 出口和运维 5432 访问，执行合成数据库 migration/verify 后立即清理；不导入真实 SQLite、用户、bcrypt hash 或 uploads。
```

- [ ] 先在本地为 002 写 RED 测试：migration version/checksum/transaction token 有效；pending ownership 唯一；admin audit 必填 actor/request ID/before-after；initial/correction revision 可区分。
- [ ] 实现 002，并扩展 schema verifier 和 synthetic seed；运行 migration 测试、临时 PostgreSQL 验证（如本机能力可用）与 `pnpm run check:all`。这一小步不调用 AWS。
- [ ] 未收到本轮明确授权时在本地验证后停止；临时 NAT、IGW、EIP、SG、ingress 和 SSM parameter 都属于 AWS 写入。
- [ ] 从精确 remote tag/commit 获取源码；control 会话生成唯一 operation token 和 deadline，worker 会话只使用临时凭据与临时网络。
- [ ] 临时创建 NAT/IGW/EIP 和运维 SG/ingress；每次 mutation 后记录可恢复状态，任何失败触发 control cleanup。
- [ ] 从 Aurora generated Secret 在内存中构造 `DATABASE_URL`，不持久化、不输出；运行 `pnpm run db:staging:migrate` 两次，第二次必须 no-op。
- [ ] 运行 `pnpm run db:staging:verify`，核对表、约束、索引、网管餐费字段、idempotency、pending ownership、admin audit 和 revision/export/attachment 表。
- [ ] 不运行 schema-from-database，不生成 `schema.sql.ts`，不创建 `SQL_CONNECTION_STRING` branch secret。
- [ ] control 会话按 ownership tuple 清理所有临时网络、SG ingress、SSM state/status 参数和临时凭据；连续稳定零观察窗口必须通过。
- [ ] 记录 migration checksum、apply/no-op/verify 结果和 cleanup 证据，不记录 Secret 或连接串。
- [ ] 提交证据：`git commit -m "docs(amplify): 记录 staging PostgreSQL 迁移证据"`

---

### Task 6: 建立共享 HTTP、身份和金额契约

**Files:**

- Create: `amplify/functions/shared/api-contract.ts`
- Create: `amplify/functions/shared/api-contract.spec.ts`
- Create: `amplify/functions/shared/errors.ts`
- Create: `amplify/functions/shared/daily-report-calculations.ts`
- Create: `amplify/functions/shared/daily-report-calculations.spec.ts`
- Reference: `apps/api/src/calc/daily-report-calc.ts`

**Interfaces:**

```ts
export type AppRole = 'ADMIN' | 'KITCHEN';

export interface TrustedActor {
  subject: string;
  username: string;
  groups: readonly AppRole[];
  requestId: string;
}

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REPORT_CONFLICT'
  | 'DATABASE_RESUMING'
  | 'INTERNAL_ERROR';

export interface DailyReportInput {
  idempotencyKey: string;
  reportDate: string;
  shiftId: string;
  responsiblePersonId: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  expenseReason?: string;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  pendingAttachmentIds?: readonly string[];
}
```

- [ ] 先写金额测试，覆盖现金餐费计入 `cashDepositYen`、两类餐费都不进入 `totalSalesYen`、支付宝独立、整数边界、负数拒绝和派生合计。
- [ ] 先写 API schema 测试，拒绝客户端字段 `role`、`createdByUserId`、`totalSalesYen`、`cashDepositYen`、正式 `s3ObjectKey` 和未知字段。
- [ ] 运行 focused tests，确认共享模块尚不存在而失败。
- [ ] 从现有 NestJS 计算契约提取等价的纯函数实现；不要让 Amplify Functions 导入 NestJS 或 Prisma。
- [ ] 定义一致的成功 envelope、错误 envelope、JST timestamp 和 request ID 传播；错误响应不得包含 SQL、Secret、连接串或完整 payload。
- [ ] 运行 `pnpm exec vitest run --config amplify/vitest.config.ts amplify/functions/shared/*.spec.ts`、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 定义 Data API 业务共享契约"`

---

### Task 7: 用参数化命令实现 RDS Data API 适配器

**Files:**

- Create: `amplify/functions/shared/rds-data.ts`
- Create: `amplify/functions/shared/rds-data.spec.ts`
- Create: `amplify/functions/shared/data-api-errors.ts`
- Modify if needed: `package.json`
- Modify if needed: `pnpm-lock.yaml`

**Interfaces:**

```ts
export type SqlScalar = string | number | boolean | null;

export interface ParameterizedStatement {
  sql: string;
  parameters?: Readonly<Record<string, SqlScalar>>;
}

export interface DataApiExecutor {
  execute<T>(statement: ParameterizedStatement): Promise<readonly T[]>;
  transaction<T>(work: (tx: DataApiTransaction) => Promise<T>): Promise<T>;
}

export interface DataApiTransaction {
  execute<T>(statement: ParameterizedStatement): Promise<readonly T[]>;
}

export function createDataApiExecutor(config: {
  clusterArn: string;
  secretArn: string;
  databaseName: string;
}): DataApiExecutor;
```

- [ ] 用 mock `RDSDataClient` 先写失败测试：参数编码/行解码、BEGIN→EXECUTE→COMMIT、异常时 ROLLBACK、commit 失败、rollback 失败保留原错误、空结果、bigint 安全范围。
- [ ] 添加负向测试：SQL 只能来自服务端常量；所有用户值进入 `SqlParameter[]`，不得使用字符串拼接产生 WHERE/ORDER BY。
- [ ] 添加 Aurora resume 错误分类测试，只把已确认的暂时 unavailable/paused/resuming 类错误映射为 `DATABASE_RESUMING`，权限、语法和校验错误不得伪装成 503。
- [ ] 运行 focused test，确认适配器不存在而失败。
- [ ] 使用 `BeginTransactionCommand`、`ExecuteStatementCommand`、`CommitTransactionCommand`、`RollbackTransactionCommand` 做最小实现；不引入 `pg`、Prisma 或连接池到 Function 运行路径。
- [ ] 运行 focused tests、`pnpm run typecheck:amplify`、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 实现 RDS Data API 事务适配器"`

---

### Task 8: 实现 Claims 与 PostgreSQL AppUser 双重授权

**Files:**

- Create: `amplify/functions/shared/authorization.ts`
- Create: `amplify/functions/shared/authorization.spec.ts`

**Interfaces:**

```ts
export interface ActiveAppUser {
  id: string;
  cognitoSubject: string;
  usernameSnapshot: string;
  role: AppRole;
}

export async function authorizeActor(input: {
  claims: Record<string, unknown>;
  requiredRole: AppRole;
  requestId: string;
  db: DataApiExecutor;
}): Promise<ActiveAppUser>;
```

- [ ] 先写失败测试：缺失 subject、无 group、多个冲突 group、未知 group、inactive app_user、subject 不存在、数据库 role 与 Cognito group 不一致均为 `403`。
- [ ] 添加正向测试：只信任 API Gateway authorizer claims，用户名只作 snapshot；请求体伪造 role/userId 不影响 actor。
- [ ] 运行 focused test，确认模块不存在而失败。
- [ ] 用固定参数化 SQL 查询 `public.app_user`，严格比较 `active`、subject 和 role；不得在日志输出 token/claims 全文。
- [ ] 运行 focused tests、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 建立 Cognito 与 AppUser 双重授权"`

---

### Task 9: 实现只能填报的 Kitchen Function

**Files:**

- Create: `amplify/functions/kitchen-api/resource.ts`
- Create: `amplify/functions/kitchen-api/handler.ts`
- Create: `amplify/functions/kitchen-api/service.ts`
- Create: `amplify/functions/kitchen-api/service.spec.ts`
- Create: `amplify/functions/kitchen-api/handler.spec.ts`

**Interfaces:**

```ts
export interface KitchenContext {
  reportDate: string;
  shifts: readonly { id: string; name: string; sortOrder: number; submitted: boolean }[];
  responsiblePersons: readonly { id: string; name: string }[];
  registerFloatAmount: number;
  previousShiftEndMinute: number | null;
}

// GET  /kitchen/context?reportDate=YYYY-MM-DD&shiftId=...
// POST /kitchen/daily-reports
// POST /kitchen/attachments/presign
```

- [ ] 先写 service 失败测试：context 不返回日报 ID、销售金额、历史列表或其他用户资料；只返回当前业务日填报元数据和 submitted 布尔值。
- [ ] 写提交事务测试：授权→读取 shift/person/settings→服务器计算→检查 idempotency→插入日报/revision/附件 ownership→commit。
- [ ] 覆盖相同 key 返回同一服务器结果；不同 key 对相同 `[report_date, shift_id]` 返回 `409 REPORT_CONFLICT` 且 body 不包含已有日报。
- [ ] 覆盖 `DATABASE_RESUMING` 为 503、校验错误为 400、未知路径为 404；`ADMIN`、匿名或错误 group 调用 Kitchen handler 都明确返回 403。
- [ ] 运行 focused tests，确认资源/handler/service 尚不存在而失败。
- [ ] 实现固定路由分发、严格 body/query validation 和参数化 SQL；Function 不进入 VPC。
- [ ] presign 只允许 `pending/{subject}/...`，限制 MIME、大小、过期时间；不接受客户端正式 key。
- [ ] 运行 focused tests、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 实现受限 Kitchen Data API"`

---

### Task 10: 实现 Admin 日报、更正、统计与健康检查

**Files:**

- Create: `amplify/functions/admin-api/resource.ts`
- Create: `amplify/functions/admin-api/handler.ts`
- Create: `amplify/functions/admin-api/service.ts`
- Create: `amplify/functions/admin-api/service.spec.ts`
- Create: `amplify/functions/admin-api/handler.spec.ts`
- Reference: `apps/api/src/analytics/analytics.service.ts`
- Reference: `apps/api/src/analytics/period-range.ts`

**Routes:**

```text
GET  /admin/daily-reports
GET  /admin/daily-reports/{reportId}
POST /admin/daily-reports/{reportId}/corrections
GET  /admin/analytics
GET  /admin/settings
PATCH /admin/settings
GET  /admin/shifts
GET  /admin/responsible-persons
POST /admin/responsible-persons
PATCH /admin/responsible-persons/{personId}
GET  /admin/health
```

- [ ] 先写授权测试：`KITCHEN`、匿名、错误 group 对所有 `/admin/*` 返回 403；前端隐藏菜单不参与判定。
- [ ] 写列表/详情测试：日期和分页参数有上限；排序字段只能来自服务端 allowlist；返回现金/支付宝/合计餐费，但图表销售序列继续只使用 `totalSalesYen`。
- [ ] 写 correction 事务测试：锁定日报、服务器重算、保存 before/after JSON、reason、actor subject/username、request ID/JST 时间，再更新日报并 commit。
- [ ] 写 analytics 测试：日报、期间合计、按班次合计均包含三种餐费指标；空结果与数据库唤醒错误区分。
- [ ] 写 settings/master-data 测试：只有 Admin 可读取/修改底钱、负责人和 active 状态；固定班次只读且顺序稳定；每次修改记录 actor 和更新时间。
- [ ] 写 health 测试：只返回最小状态与 request ID，不返回 cluster ARN、Secret ARN、SQL 或连接信息。
- [ ] 运行 focused tests，确认模块不存在而失败。
- [ ] 实现固定 SQL 和服务端聚合；对日期、period、page size 做严格枚举/范围校验。
- [ ] 运行 focused tests、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 实现管理员账务与统计 API"`

---

### Task 11: 实现附件正式化和异步导出

**Files:**

- Create: `amplify/functions/shared/storage-keys.ts`
- Create: `amplify/functions/shared/storage-keys.spec.ts`
- Create: `amplify/functions/export-api/resource.ts`
- Create: `amplify/functions/export-api/handler.ts`
- Create: `amplify/functions/export-api/service.ts`
- Create: `amplify/functions/export-api/service.spec.ts`
- Modify: `amplify/functions/admin-api/handler.ts`
- Modify: `amplify/functions/admin-api/service.ts`
- Modify: `amplify/functions/admin-api/handler.spec.ts`

**Routes:**

```text
POST /admin/exports
GET  /admin/exports/{exportJobId}
GET  /admin/attachments/{attachmentId}/download
```

- [ ] 先写 key-policy 测试：validated key 视为 opaque，不 percent-decode；拒绝 traversal、错误 subject、错误 prefix、超长 key 和正式 key 注入。
- [ ] 写附件正式化测试：head pending object，校验 ownership/MIME/size/hash，复制到受控正式 key，写 `attachment`，再删除 pending；任一步失败不产生数据库假成功。
- [ ] 写 Admin 下载测试：按 attachment ID 查库，生成短期 URL；Kitchen 永远不能读取正式附件。
- [ ] 写 export job 测试：Admin 创建 `PENDING` job 后以异步调用启动非公开 Export Function；worker 原子转换 RUNNING→SUCCEEDED/FAILED，将文件写入受控 key；重复调用不重复生成。
- [ ] 运行 focused tests，确认模块不存在而失败。
- [ ] 复用现有导出字段定义，确保现金/支付宝/餐费合计出现在 Excel/PDF/HTML 数据模型；不要让 Function 依赖 Express response 或本地文件系统 uploads。
- [ ] 运行 focused tests、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 实现受控附件和导出任务"`

---

### Task 12: 组合 HTTP API、JWT Authorizer、IAM 与 Amplify outputs

**Files:**

- Create: `amplify/api/http-api.ts`
- Create: `amplify/api/http-api.spec.ts`
- Modify: `amplify/backend.ts`
- Modify: `amplify/backend-composition.spec.ts`

**Composition contract:**

```ts
export const FULL_BACKEND_RESOURCE_SET = [
  'auth',
  'storage',
  'vpc',
  'aurora',
  'dataApi',
  'httpApi',
  'kitchenFunction',
  'adminFunction',
  'exportFunction',
] as const;
```

- [ ] 先写 CDK 失败测试：每条 Kitchen/Admin route 都绑定 Cognito `HttpJwtAuthorizer`，issuer/audience 来自当前 User Pool；不存在未授权 duplicate route、API key 或公开 default route。
- [ ] 写 Lambda 断言：三个业务 Function 均无 VPC config；环境变量只有非秘密的 cluster ARN、secret ARN、database name、bucket name；没有连接串或 Secret 值。
- [ ] 写 IAM 断言：Data API actions 限定目标 cluster；Secrets read 限定 generated Secret；S3 action 按 pending/formal/export prefix 分开；Kitchen 无正式 read、Admin 无任意 bucket wildcard。
- [ ] 写全模板负向断言：无 AppSync、Amplify Data SQL Lambda、Updater Lambda、RDS Proxy、NAT、SSM Interface Endpoint、业务 5432 ingress。
- [ ] 运行 focused tests，确认 HTTP API 未组合而失败。
- [ ] 用 `backend.createStack()`、`HttpApi`、`HttpLambdaIntegration`、`HttpJwtAuthorizer` 组合资源，并分别 grant 三个 Function 最小权限。
- [ ] 用 Amplify custom outputs 暴露 HTTP API URL、Cognito region/userPoolId/userPoolClientId 和 Storage bucket 标识；不输出 Secret ARN 到 public bundle。
- [ ] 运行 focused tests、完整 synth、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(amplify): 组合 Cognito HTTP API backend"`

---

### Task 13: 建立合成 Cognito/PostgreSQL seed 与 API smoke 工具

**Files:**

- Modify: `amplify/database/scripts/seed-staging.ts`
- Create: `amplify/database/scripts/seed-staging.spec.ts`
- Create: `scripts/staging-api-smoke.ts`
- Create: `scripts/staging-api-smoke.spec.ts`
- Modify: `package.json`

**Synthetic identities:**

```text
fsk-stage-admin   -> Cognito ADMIN   -> app_user ADMIN
fsk-stage-kitchen -> Cognito KITCHEN -> app_user KITCHEN
No WEBMASTER group or cloud role
```

- [ ] 先写 seed 测试：只接受明确 `--synthetic-only`；拒绝 `dev.db`、backup ZIP、uploads 路径和无 staging guard 的数据库。
- [ ] 写 Cognito/AppUser reconciliation 测试：subject 是权威关联；重复执行幂等；错误 group/role 不静默修正为更高权限。
- [ ] 写 smoke client 测试：获取 token、调用 Kitchen context/submit、调用 Admin list/analytics、检查越权 403；Secret 和密码不出现在日志或命令参数快照。
- [ ] 运行 focused tests，确认工具缺失或旧 seed 接口不满足契约而失败。
- [ ] 实现 Data API 模式 seed 和 smoke；本地 PostgreSQL direct 模式仅保留给获批 CloudShell migration，不用于业务 Function。
- [ ] 加入脚本 `staging:seed:synthetic` 和 `staging:smoke`，默认 dry-run，执行写入必须显式带 App ID/region/approved commit。
- [ ] 运行 focused tests、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "test(amplify): 建立合成 staging seed 与 smoke"`

---

### Task 14: 将 Vue/PWA 接到 Cognito 与 HTTP API，同时保留本地回滚模式

**Files:**

- Create: `apps/web/src/api/runtime-config.ts`
- Create: `apps/web/src/api/runtime-config.spec.ts`
- Create: `apps/web/src/api/cloud-api.ts`
- Create: `apps/web/src/api/cloud-api.spec.ts`
- Create: `apps/web/src/composables/useKitchenContext.ts`
- Create: `apps/web/src/composables/useKitchenContext.spec.ts`
- Create: `apps/web/src/composables/useIdempotentDailyReportSubmit.ts`
- Create: `apps/web/src/composables/useIdempotentDailyReportSubmit.spec.ts`
- Modify: `apps/web/src/api/http.ts`
- Modify: `apps/web/src/stores/auth.ts`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/views/LoginView.vue`
- Move: `apps/web/src/views/wm/WmHomeView.vue` → `apps/web/src/views/kitchen/KitchenHomeView.vue`
- Move: `apps/web/src/views/wm/DailyFormView.vue` → `apps/web/src/views/kitchen/DailyFormView.vue`
- Modify: `apps/web/src/views/admin/AdminShellView.vue`
- Modify: `apps/web/src/views/admin/AdminDailyView.vue`
- Modify: `apps/web/src/views/admin/AdminReportFormView.vue`
- Modify: `apps/web/src/views/admin/AnalyticsView.vue`
- Modify: `apps/web/src/views/admin/AdminSettingsView.vue`
- Modify: `apps/web/src/views/admin/AdminBackupView.vue`
- Modify: `apps/web/src/main.ts`
- Modify: `apps/web/index.html`
- Create: `apps/web/public/manifest.webmanifest`
- Create: `apps/web/public/apple-touch-icon.png`
- Create: `apps/web/public/icons/icon-192.png`
- Create: `apps/web/public/icons/icon-512.png`
- Create: `apps/web/src/pwa-contract.spec.ts`

**Runtime modes:**

```ts
export type RuntimeMode = 'local-nest' | 'amplify-staging';

export interface CloudRuntimeConfig {
  mode: 'amplify-staging';
  apiBaseUrl: string;
  region: 'ap-northeast-1';
  userPoolId: string;
  userPoolClientId: string;
}
```

- [ ] 先写 runtime config 测试：本地默认继续指向 NestJS；staging 缺任一 output 时 fail closed；public config/bundle 不含 Secret ARN、连接串、密码或 synthetic token。
- [ ] 写 auth/router 测试：Cognito `KITCHEN` 只能进入厨房填报；不能导航到 admin、历史、统计、设置、备份；云端不接受 `WEBMASTER` group。
- [ ] 写路由迁移测试：厨房正式路径为 `/kitchen` 和 `/kitchen/report/:date/:shiftId`，不再注册 `wm-report-edit` 或任何厨房历史编辑路由；本地旧登录成功后也导航到 `/kitchen`。
- [ ] 写 Kitchen UI 测试：主页不请求 `/daily-reports` 历史列表，不显示销售汇总和历史日期浏览，只请求 `/kitchen/context` 并进入未提交班次的表单。
- [ ] 写重试测试：第一次/第二次 `503 DATABASE_RESUMING` 使用相同 idempotency key 退避；成功只产生一次导航；超过总等待上限保留表单并允许人工用同 key 重试。
- [ ] 写 PWA 契约测试：manifest `display: "standalone"`、正确 `start_url`/icons；HTML 有 `apple-mobile-web-app-capable=yes`、`apple-mobile-web-app-status-bar-style`、`apple-touch-icon`、`viewport-fit=cover`。
- [ ] 运行 `pnpm run test:web`，确认 cloud adapter、composables 和 manifest 尚不存在而失败。
- [ ] 使用 `aws-amplify` v6 Auth API 获取/刷新 token；axios interceptor 在每次请求读取当前 session，而不是永久缓存 token。
- [ ] 将厨房/管理员页面的数据读取切换到按角色 API adapter；保留共享表单 composable 和金额预览，服务器返回值仍为最终权威。
- [ ] 本地 `WEBMASTER` 只在 `local-nest` adapter 内映射为 UI 的厨房能力；界面文案统一使用厨房，不在 cloud payload 暴露 `WEBMASTER`。
- [ ] staging 隐藏并禁用本地 SQLite backup/import 页面；管理员云端导出走 `/admin/exports`，真实 backup/import 留在后续真实数据迁移阶段。
- [ ] 生成并核对 192/512/Apple 主屏幕图标；不引入 Service Worker 离线写入缓存，避免离线重复提交。
- [ ] 针对 iPhone 7 Plus iOS 15.8.4 与 iPhone 16 Pro Max 当前 iOS 添加 safe-area、触控尺寸、键盘/滚动和 standalone CSS；设备实测留到 Task 17。
- [ ] 运行 `pnpm run test:web`、`pnpm run typecheck:web`、`pnpm run build:web`、`pnpm run check:all`、`git diff --check`。
- [ ] 提交：`git commit -m "feat(web): 接入 Cognito Data API PWA 运行模式"`

---

### Task 15: 审批门 B——部署完整 Backend 与合成数据

**Files:**

- Modify after approval: `docs/aws/staging-cost-approval.md`
- Append evidence: `docs/aws/staging-deployment-runbook.md`

**Required user approval statement:**

```text
批准在现有 FSK staging 上部署 HTTP API、Kitchen/Admin/Export Functions、最小 IAM和合成账号/数据；继续执行 ¥5,000 月治理上限，不包含 Hosting、真实数据迁移、production、Budget/alarms 或销毁。
```

- [ ] 未收到本轮明确授权时停止；Task 4 的 foundation 批准不能自动覆盖本任务。
- [ ] 在干净 commit 上重新运行 `pnpm install --frozen-lockfile`、`pnpm run check:all`、完整 synth 和 public bundle secret scan。
- [ ] 只读核对部署 diff：新资源只能是 HTTP API、三个业务 Function 和必要 IAM/log groups；出现 Hosting job、AppSync、SQL/Updater Lambda、Interface Endpoint、NAT、Proxy 或 VPC Function 立即停止。
- [ ] 部署 full backend，核对每条 route 都有 Cognito JWT authorizer、Function env/IAM 最小、CloudWatch 日志不含账务 payload/Secret。
- [ ] 创建两个合成 Cognito 用户和对应 app_user；运行 synthetic seed 两次，第二次必须幂等。
- [ ] 运行 API smoke：Kitchen context/submit、同 key 重试、不同 key 冲突、Admin list/detail/correction/analytics/export、Kitchen 越权 403。
- [ ] 记录资源、成本预测和测试证据；失败时停止新写入，保留现有 NestJS/SQLite 回滚层。
- [ ] 提交证据：`git commit -m "docs(amplify): 记录完整 backend 部署证据"`

---

### Task 16: 审批门 C——构建并发布 Amplify Hosting

**Files:**

- Modify after approval: `docs/aws/staging-cost-approval.md`
- Append evidence: `docs/aws/staging-deployment-runbook.md`

**Required user approval statement:**

```text
批准从已验收的精确 commit 构建并发布 FSK staging Amplify Hosting，供两台指定 iPhone 做 PWA 验收；继续执行 ¥5,000 月治理上限，不包含真实数据迁移、production、Budget/alarms 或销毁。
```

- [ ] 未收到本轮明确授权时停止；Task 15 的 backend 批准不能自动覆盖 Hosting build 和发布。
- [ ] 核对精确 commit 已包含 Task 14 的 PWA、runtime config 和 public bundle secret scan；branch Auto build 保持关闭。
- [ ] 启动一次明确的 Amplify Hosting job，记录 build ID、commit、构建分钟、outputs、public URL 和响应 headers。
- [ ] 验证 `/manifest.webmanifest` 返回 manifest JSON 而不是 SPA HTML；Apple touch icon、192/512 icons、入口 HTML 和深链接均返回正确 content type。
- [ ] 用桌面浏览器完成登录、Kitchen submit、Admin list/analytics/export 的最小 smoke；失败时不继续手机验收。
- [ ] 提交证据：`git commit -m "docs(amplify): 记录 staging Hosting 发布证据"`

---

### Task 17: 云端验收、手机 PWA 验收、成本观察与 Phase B 判定

**Files:**

- Create: `docs/aws/staging-acceptance-report.md`
- Modify after separate approval: `docs/aws/staging-cost-approval.md`
- Modify after separate approval: `docs/aws/staging-deployment-runbook.md`

**Acceptance matrix:**

```text
Security: Cognito + app_user + route/function authorization
Accounting: staff meal cash/alipay formulas and persistence
Reliability: same-key DATABASE_RESUMING retry, no duplicate report
PWA: iPhone 7 Plus iOS 15.8.4 + iPhone 16 Pro Max current iOS
Cost: Aurora returns to 0 ACU, no persistent NAT/Interface Endpoint/Proxy
Cleanup: no temporary migration resources or synthetic probe leftovers
```

- [ ] 在无业务流量窗口等待 Aurora 自动暂停，确认 `ServerlessV2Usage=0`；记录时间线，不用定时 warm-up 干扰结果。
- [ ] 从暂停状态执行 Kitchen 首次提交，验证 UI 显示安全唤醒重试、复用同一 key、最终成功且数据库只有一条日报。
- [ ] 用 Kitchen token 逐一请求 `/admin/*`、历史、统计、设置和正式附件下载，全部必须 403；context body 不得泄露历史销售数据。
- [ ] 用 Admin token验证列表、详情、更正 revision、三类餐费统计、导出和短期附件下载；图表销售曲线仍只基于 `totalSalesYen`。
- [ ] 在 iPhone 7 Plus iOS 15.8.4 Safari 添加到主屏幕：图标正确、从图标启动无 Safari 地址栏、状态栏/safe-area 正常、表单可滚动、键盘不遮挡提交、退出重开可登录。
- [ ] 在 iPhone 16 Pro Max 当前 iOS 重复相同验收，覆盖灵动岛 safe-area、纵横屏、触控区域和长表单确认页。
- [ ] 核对 Aurora private/Data API/0–1、无 Proxy、无长期 NAT、无 Interface Endpoint、无业务 5432 ingress、Functions 无 VPC config。
- [ ] 核对临时 NAT/IGW/EIP/SG/ingress/SSM parameters 和 CloudShell 临时凭据全部清零；记录 S3 pending/test lifecycle 与 noncurrent versions。
- [ ] 只读获取当前月预测并与 `¥5,000` 比较。若超限，自动使当前审批失效、停止新增部署并进入成本/清理复查；该治理上限不是 AWS 硬停止。
- [ ] Budget、Cost Anomaly Detection、alarms 属于新的 AWS 写入：另行取得“批准创建 staging 成本/运行告警”的明确授权后才执行；销毁也必须单独授权。
- [ ] 运行最终 `pnpm install --frozen-lockfile`、`pnpm run check:all`、完整 synth、secret scan、`git diff --check`，并由独立 reviewer 检查 spec compliance 与 evidence chain。
- [ ] 只有本任务全部通过才在 `staging-acceptance-report.md` 标记 Phase B complete；否则逐项记录 `FAILED`/`NOT_RUN`，不得宣称 staging 完成。
- [ ] 提交：`git commit -m "docs(amplify): 完成 Data API staging 验收审计"`

---

## Completion Boundary

本计划完成时，FSK 只达到“合成数据 staging Web App 可用、两台指定 iPhone 完成 PWA 验收”的 Phase B。以下工作仍需新的设计、计划和批准：

- 本地 SQLite、真实用户/bcrypt、真实账务和 uploads 的一次性迁移；
- 店内入口切换、DNS/自定义域名、production 环境；
- NestJS/SQLite 退役与只读归档；
- 真实数据回滚演练、保留期和删除策略；
- 将成本治理上限改为其他金额或提高 Aurora 最大 ACU。

## Required Final Evidence

- 精确 branch、commit、tag、Amplify App/branch、CloudFormation stack 和 region/account。
- 每个审批门的用户原文、范围、时间、批准 commit、月上限和清理责任人。
- 全量本地测试/类型检查/build/synth 退出码与测试数量。
- Foundation 与 full backend 的资源清单和禁止资源为零的证据。
- migration apply/no-op/verify 和临时资源稳定清零证据。
- Kitchen/Admin 权限矩阵、幂等/冲突、网管餐费、统计、导出、附件和冷唤醒证据。
- iPhone 7 Plus iOS 15.8.4 与 iPhone 16 Pro Max 当前 iOS 的主屏幕 standalone 实机证据。
- Aurora 回到 0 ACU、当前月预测低于 `¥5,000`、无长期网络固定成本资源的证据。
