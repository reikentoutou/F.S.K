# FSK Amplify Gen 2 Staging 基础设施实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `ap-northeast-1` 建成一套独立、私有、可重复部署和可销毁的 FSK Amplify Gen 2 staging，并用合成数据闭环验证 `ADMIN` 读取、`KITCHEN` 可信填报、网管餐费计算、幂等、越权拒绝、Storage 与 Cognito 密码迁移能力。

**Architecture:** 先从版本控制中的 foundation backend 建立 Cognito、Storage、VPC 和 Aurora，再从 VPC 内的 CloudShell 执行权威 SQL migration 并生成 `schema.sql.ts`，最后加入 Amplify Data 与可信写入 Functions 后进行第二次部署。Amplify Data 只开放受控读取，自定义 Mutation 调用 Functions；Functions 从 Cognito Claims 与 PostgreSQL `app_user` 双重鉴权，并通过 RDS Data API 在数据库事务内重算和写入。Hosting 只负责 Vue/PWA 静态资源及获取已经批准部署的 `amplify_outputs.json`，不会因普通前端构建自动修改后端。

**Tech Stack:** AWS Amplify Gen 2、AWS CDK、Cognito、AppSync/Amplify Data SQL、Aurora PostgreSQL Serverless v2、RDS Data API、Lambda/Amplify Functions、S3/Amplify Storage、CloudWatch、AWS Budgets、Vue 3、Vite、TypeScript strict、pnpm 9、Vitest 3、`pg`。

**Spec:** `docs/superpowers/specs/2026-08-23-amplify-gen2-staging-infrastructure-design.md`

## Global Constraints

- 本计划只实施阶段 B；不得创建 production 资源、导入真实 SQLite、真实用户哈希、真实 `uploads/`，也不得切换店内入口或退役 NestJS/SQLite/JWT。
- AWS 区域固定为 `ap-northeast-1`；资源必须带 `Project=FSK`、`Environment=staging`、`ManagedBy=AmplifyGen2` 标签。
- Aurora PostgreSQL Serverless v2 容量固定为 `0–2 ACU`，必须使用支持 0 ACU 的区域内引擎版本，`PubliclyAccessible=false`，无 RDS Proxy、无长期 NAT Gateway。
- 首次 AWS 写入、第二次全栈部署、预算/告警创建和销毁分别是独立审批门；没有用户明确批准时只执行本地测试和只读查询。
- Cognito 只建立 `ADMIN` 与 `KITCHEN` Groups，禁止 self sign-up，使用不可变用户名登录；不得创建 `WEBMASTER` Group。
- staging 只使用 `stage-admin`、`stage-kitchen` 和合成账务/附件；脚本必须拒绝 `dev.db`、备份 ZIP、真实 bcrypt 哈希和仓库 `uploads/` 作为输入。
- `staffMealCashYen` 保留在现金入金中但从实际销售扣除；`staffMealAlipayYen` 独立保存且不进入现金入金或实际销售；派生金额始终由可信 Function 重算。
- 生成的 `amplify/data/schema.sql.ts` 只能由 `ampx generate schema-from-database` 更新，禁止手工编辑。
- `amplify_outputs.json` 必须由 Amplify CLI 生成，不得手工伪造，并加入 Git ignore。
- 现有 Web 默认仍使用本地 NestJS/JWT 与 `WEBMASTER` 路由；阶段 B 的云端接入必须由 `VITE_RUNTIME_MODE=amplify-staging` 显式开启。
- 本阶段不做 iPhone 16 Pro Max 或 iPhone 7 Plus iOS 15.8.4 的完整 PWA 真机验收；Manifest、standalone 主屏幕模式、厨房页面适配和真机权限验收属于阶段 D。
- 修改 Vue 文件前遵循 `vue-best-practices`；Vue 测试使用黑盒行为断言、等待用户交互并在异步网络后 `flushPromises()`。
- 每个提交只暂存对应 Task 的 `Files`；不得提交数据库密码、Token、Cognito 导入 CSV、CloudShell 临时文件、`amplify_outputs.json` 或部署日志中的敏感内容。

## 文件结构与所有权

| 文件 | 单一职责 |
| --- | --- |
| `amplify/backend.ts` | 最终全栈 backend 组合、跨资源授权和输出 |
| `amplify/backend.foundation.ts` | 首次空环境部署入口，只组合 Auth/Storage/Foundation |
| `amplify/auth/resource.ts` | `defineAuth`、Groups、登录方式与自助注册配置 |
| `amplify/auth/overrides.ts` | 可测试的 Cognito L1 override 与 Group 常量 |
| `amplify/infrastructure/staging-foundation.ts` | VPC、Security Group、Aurora、Data API、标签和输出 |
| `amplify/infrastructure/staging-foundation.spec.ts` | 私网、0–2 ACU、无 Proxy/长期 NAT 的 CDK 断言 |
| `amplify/storage/resource.ts` | Storage 定义和 Function 资源授权 |
| `amplify/storage/key-policy.ts` | pending/正式/导出路径构造与越界拒绝纯函数 |
| `amplify/data/schema.sql.ts` | 从真实 staging Aurora 生成的 SQL 模型，生成物 |
| `amplify/data/resource.ts` | SQL 模型授权、自定义 Query/Mutation 与 Function handlers |
| `amplify/database/migrations/001_bootstrap.sql` | PostgreSQL 初始业务结构的权威 DDL |
| `amplify/database/scripts/migrate.ts` | migration 校验和、事务执行和失败停止 |
| `amplify/database/scripts/verify-schema.ts` | 表、主键、约束、金额类型和版本只读验证 |
| `amplify/database/scripts/seed-staging.ts` | 可重复执行的合成 staging seed |
| `amplify/functions/shared/*` | Claims、RDS Data API、计算、日志和错误映射共享代码 |
| `amplify/functions/submit-kitchen-report/*` | 厨房上下文和日报可信提交 |
| `amplify/functions/admin-correct-report/*` | 管理员更正和 revision 快照 |
| `amplify/functions/storage-upload/*` | subject 路径的签名上传与附件确认 |
| `amplify/functions/health-check/*` | 无敏感数据的依赖健康检查 |
| `amplify/tests/staging-smoke.ts` | 云端正向/负向端到端验收，仅合成账号 |
| `amplify/tests/password-hash-import.ts` | disposable bcrypt cost 10 能力探测与清理 |
| `apps/web/src/cloud/configure-amplify.ts` | 仅在 staging runtime mode 读取生成输出并配置客户端 |
| `amplify.yml` | Hosting 安装、获取输出、测试和 Web 构建；不部署后端 |
| `docs/aws/staging-cost-approval.md` | 部署前成本清单、预算上限与批准证据 |
| `docs/aws/staging-deployment-runbook.md` | 两阶段部署、CloudShell、验收和证据记录 |
| `docs/aws/staging-destroy-runbook.md` | dry-run、final snapshot、保留 Bucket 和费用复查 |

---

### Task 1: 建立 Amplify 工作区、严格检查和敏感产物边界

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Create: `amplify/tsconfig.json`
- Create: `amplify/vitest.config.ts`
- Create: `amplify/tests/repository-guard.spec.ts`

**Interfaces:**
- Consumes: 根工作区 pnpm 9 和现有 `typecheck`、`build`、API/Web Vitest。
- Produces: `pnpm run typecheck:amplify`、`pnpm run test:amplify`、`pnpm run check:all`；后续 Tasks 统一使用的 Amplify TypeScript/Vitest 环境。

- [ ] **Step 1: 写失败的仓库边界测试**

创建 `amplify/tests/repository-guard.spec.ts`，读取 `.gitignore` 并断言至少包含精确条目 `amplify_outputs.json`、`.amplify/`、`amplify/.env*`、`amplify/database/tmp/`、`amplify/tests/fixtures/private/`；同时断言 migration 目录下不存在 `.db`、`.zip`、`uploads` 路径。

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ignore = readFileSync('.gitignore', 'utf8').split(/\r?\n/);

describe('Amplify repository guard', () => {
  it.each([
    'amplify_outputs.json',
    '.amplify/',
    'amplify/.env*',
    'amplify/database/tmp/',
    'amplify/tests/fixtures/private/',
  ])('ignores %s', (entry) => expect(ignore).toContain(entry));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm exec vitest run --config amplify/vitest.config.ts amplify/tests/repository-guard.spec.ts`

Expected: FAIL，至少指出 `amplify_outputs.json` 尚未被 ignore。

- [ ] **Step 3: 安装并锁定依赖**

Run:

```bash
pnpm add -Dw @aws-amplify/backend @aws-amplify/backend-cli aws-cdk-lib constructs tsx pg bcryptjs @types/pg @types/aws-lambda @aws-sdk/client-rds-data @aws-sdk/client-cognito-identity-provider @aws-sdk/client-s3 @aws-sdk/client-cloudwatch
pnpm --filter @finance/web add aws-amplify
```

在 `package.json` 加入：

```json
{
  "scripts": {
    "typecheck:amplify": "tsc -p amplify/tsconfig.json --noEmit",
    "test:amplify": "vitest run --config amplify/vitest.config.ts",
    "test:api": "pnpm --filter @finance/api test",
    "check:all": "pnpm run typecheck && pnpm run typecheck:amplify && pnpm run test:api && pnpm run test:web && pnpm run test:amplify && pnpm run build"
  }
}
```

- [ ] **Step 4: 创建严格 TS/Vitest 配置并补 ignore**

`amplify/tsconfig.json` 使用 `strict: true`、`module: NodeNext`、`moduleResolution: NodeNext`、`target: ES2022`、`types: ["node", "aws-lambda"]`，include `./**/*.ts`。`amplify/vitest.config.ts` 的 include 固定为 `amplify/**/*.spec.ts`，environment 为 `node`。向 `.gitignore` 添加 Step 1 的五个精确条目。

- [ ] **Step 5: 验证最小工具链**

Run:

```bash
pnpm run test:amplify -- amplify/tests/repository-guard.spec.ts
pnpm run typecheck:amplify
pnpm run check
```

Expected: repository guard PASS；Amplify strict typecheck PASS；现有 API/Web 检查不回归。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml .gitignore amplify/tsconfig.json amplify/vitest.config.ts amplify/tests/repository-guard.spec.ts
git commit -m "build(amplify): 建立 staging 工具链"
```

---

### Task 2: 用 CDK 断言锁定私有 VPC 与 Aurora Foundation

**Files:**
- Create: `amplify/infrastructure/staging-config.ts`
- Create: `amplify/infrastructure/staging-foundation.ts`
- Create: `amplify/infrastructure/staging-foundation.spec.ts`

**Interfaces:**
- Consumes: `aws-cdk-lib.Stack`、在 `ap-northeast-1` 只读查询确认的 Aurora PostgreSQL engine version。
- Produces: `createStagingFoundation(scope, config): StagingFoundation`，返回 `vpc`、`cluster`、`clusterSecret`、`databaseSecurityGroup`、`databaseName`。

- [ ] **Step 1: 只读确定支持 0 ACU 的引擎版本**

Run:

```bash
aws rds describe-db-engine-versions --region ap-northeast-1 --engine aurora-postgresql --query 'DBEngineVersions[?ServerlessV2FeaturesSupport.MinCapacity==`0`].[EngineVersion,ServerlessV2FeaturesSupport.MinCapacity,ServerlessV2FeaturesSupport.MaxCapacity,Status]' --output table
```

从输出中选择状态为 `available` 的最高补丁版本，并把完整版本号作为 `AURORA_POSTGRES_ENGINE_VERSION` 的唯一允许值写入 `staging-config.ts`。随后把该值传给 `aws rds describe-orderable-db-instance-options --region ap-northeast-1 --engine aurora-postgresql --db-instance-class db.serverless --engine-version "$AURORA_POSTGRES_ENGINE_VERSION"`，确认 `ap-northeast-1` 存在返回项；只读查询不创建资源。

- [ ] **Step 2: 写失败的 CDK 断言**

测试必须断言：两 AZ；`NatGateways=0`；Aurora `ServerlessV2ScalingConfiguration` 为 `MinCapacity: 0`、`MaxCapacity: 2`；启用 Data API、存储加密、14 天备份和删除保护；不存在 `AWS::RDS::DBProxy`；任何 Security Group ingress 都不存在 `0.0.0.0/0:5432` 或 `::/0:5432`。

```ts
const app = new App();
const stack = new Stack(app, 'TestStack', { env: { region: 'ap-northeast-1' } });
createStagingFoundation(stack, STAGING_CONFIG);
const template = Template.fromStack(stack);

template.hasResourceProperties('AWS::RDS::DBCluster', {
  DatabaseName: 'fsk_staging',
  DeletionProtection: true,
  EnableHttpEndpoint: true,
  ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: 2 },
  StorageEncrypted: true,
});
template.resourceCountIs('AWS::RDS::DBProxy', 0);
template.resourceCountIs('AWS::EC2::NatGateway', 0);
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `pnpm run test:amplify -- amplify/infrastructure/staging-foundation.spec.ts`

Expected: FAIL，错误指向 `createStagingFoundation` 尚未定义。

- [ ] **Step 4: 实现最小 Foundation construct**

创建两个 AZ 的 VPC：`PRIVATE_WITH_EGRESS` 应用子网、`PRIVATE_ISOLATED` 数据库子网、`natGateways: 0`；添加 S3 Gateway Endpoint，并因 Amplify SQL Lambda 官方运行要求添加 SSM Interface Endpoint。创建 Aurora Serverless v2 writer、0–2 ACU、自动暂停、Data API、私有 endpoint、TLS 参数、14 天备份、删除保护和 generated credentials Secret。只允许数据库 Security Group 从后续 Amplify SQL Lambda Security Group 或受控运维 Security Group 访问 5432，不加入公网 CIDR；SSM Endpoint 的固定小时费用必须列入 Task 6 成本表。

- [ ] **Step 5: 运行断言和类型检查**

Run:

```bash
pnpm run test:amplify -- amplify/infrastructure/staging-foundation.spec.ts
pnpm run typecheck:amplify
```

Expected: 所有 CDK 断言 PASS；模板中无 DB Proxy、NAT Gateway 或公网 PostgreSQL ingress。

- [ ] **Step 6: 提交**

```bash
git add amplify/infrastructure
git commit -m "feat(amplify): 定义私有 staging foundation"
```

---

### Task 3: 定义 Cognito 用户名登录、双 Group 与禁止注册

**Files:**
- Create: `amplify/auth/resource.ts`
- Create: `amplify/auth/overrides.ts`
- Create: `amplify/auth/overrides.spec.ts`

**Interfaces:**
- Consumes: Amplify `defineAuth` 和 Cognito `CfnUserPool`。
- Produces: `auth` resource；`COGNITO_GROUPS = ['ADMIN', 'KITCHEN'] as const`；`applyStagingAuthOverrides(pool, client)`。

- [ ] **Step 1: 写失败的 override 测试**

```ts
expect(COGNITO_GROUPS).toEqual(['ADMIN', 'KITCHEN']);
applyStagingAuthOverrides(pool, client);
Template.fromStack(stack).hasResourceProperties('AWS::Cognito::UserPool', {
  AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  UsernameAttributes: [],
});
Template.fromStack(stack).hasResourceProperties('AWS::Cognito::UserPoolClient', {
  ExplicitAuthFlows: Match.arrayWith([
    'ALLOW_USER_PASSWORD_AUTH',
    'ALLOW_USER_SRP_AUTH',
    'ALLOW_REFRESH_TOKEN_AUTH',
  ]),
});
expect(COGNITO_GROUPS).not.toContain('WEBMASTER');
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `pnpm run test:amplify -- amplify/auth/overrides.spec.ts`

Expected: FAIL，模块或函数尚不存在。

- [ ] **Step 3: 实现 Auth 与 L1 override**

`defineAuth` 仅启用用户名/密码登录并声明 `ADMIN`、`KITCHEN` groups。`applyStagingAuthOverrides` 设置 `usernameAttributes = []`、`adminCreateUserConfig.allowAdminCreateUserOnly = true`，并让 App Client 明确允许 `USER_PASSWORD_AUTH`、SRP 和 refresh token；这保证 bcrypt 导入后的首次登录有受支持入口。保留管理员恢复流程，不要求真实邮箱或手机号；不得启用 guest access 或 self sign-up。

- [ ] **Step 4: 验证**

Run:

```bash
pnpm run test:amplify -- amplify/auth/overrides.spec.ts
pnpm run typecheck:amplify
```

Expected: PASS；模板只有管理员建用户，Groups 常量只有 ADMIN/KITCHEN。

- [ ] **Step 5: 提交**

```bash
git add amplify/auth
git commit -m "feat(amplify): 定义 staging Cognito 边界"
```

---

### Task 4: 定义 Storage 密钥空间和默认拒绝策略

**Files:**
- Create: `amplify/storage/key-policy.ts`
- Create: `amplify/storage/key-policy.spec.ts`
- Create: `amplify/storage/resource.ts`

**Interfaces:**
- Consumes: Cognito `sub`、业务对象 ID 和净化后的文件名。
- Produces: `pendingKey(subject, draftId, attachmentId, fileName)`、`formalAttachmentKey(reportId, attachmentId, fileName)`、`assertOwnedPendingKey(key, subject)`、`storage` resource。

- [ ] **Step 1: 写路径和越权失败测试**

覆盖路径穿越、控制字符、斜杠文件名、跨 subject、`daily-reports/` 冒充 pending、空 ID；合法结果必须精确为 `pending/{sub}/{draftId}/{attachmentId}/{sanitizedName}`。

```ts
expect(pendingKey('sub-a', 'draft-1', 'att-1', '../票据.jpg'))
  .toBe('pending/sub-a/draft-1/att-1/票据.jpg');
expect(() => assertOwnedPendingKey('pending/sub-b/d/a/x.jpg', 'sub-a'))
  .toThrow('PENDING_KEY_NOT_OWNED');
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/storage/key-policy.spec.ts`

Expected: FAIL，路径函数尚未定义。

- [ ] **Step 3: 实现路径纯函数和 Storage resource**

路径函数只接受非空 `[A-Za-z0-9_-]` ID，文件名使用 basename、去控制字符并限制 UTF-8 字节长度。`defineStorage` 保持客户端默认拒绝；Task 12 再通过最小 IAM grant 把正式 `daily-reports/*`、`migration-staging/*` 授予对应 Functions，`ADMIN` 只通过 Function 获取短时签名 URL；`KITCHEN` 不获得 Bucket 通配写权限。Bucket 通过 CDK override 启用 Block Public Access、SSE-S3、Versioning、`keepOnDelete: true`，pending 和测试导出配置短生命周期。

- [ ] **Step 4: 验证**

Run:

```bash
pnpm run test:amplify -- amplify/storage/key-policy.spec.ts
pnpm run typecheck:amplify
```

Expected: 合法路径 PASS，跨 subject 与路径穿越全部拒绝。

- [ ] **Step 5: 提交**

```bash
git add amplify/storage
git commit -m "feat(amplify): 定义 staging Storage 边界"
```

---

### Task 5: 建立可事务执行的 PostgreSQL migration 与合成 seed

**Files:**
- Create: `amplify/database/migrations/001_bootstrap.sql`
- Create: `amplify/database/scripts/migration-lib.ts`
- Create: `amplify/database/scripts/migration-lib.spec.ts`
- Create: `amplify/database/scripts/migrate.ts`
- Create: `amplify/database/scripts/verify-schema.ts`
- Create: `amplify/database/scripts/seed-staging.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DATABASE_URL`，只能是显式 staging PostgreSQL URI。
- Produces: `planMigrations(applied, files)`、`applyMigrations(client, files)`；CLI scripts `db:staging:migrate`、`db:staging:verify`、`db:staging:seed`。

- [ ] **Step 1: 写 migration 计划失败测试**

测试覆盖：空库执行 001；相同 checksum 跳过；已执行版本 checksum 改变时抛 `MIGRATION_CHECKSUM_MISMATCH`；001 失败时不记录成功；连接串 host 含 `localhost`、数据库名不是 `fsk_staging` 或路径含 `dev.db` 时拒绝。

```ts
expect(planMigrations([], [{ version: '001', checksum: 'abc' }]))
  .toEqual([{ version: '001', checksum: 'abc' }]);
expect(() => planMigrations(
  [{ version: '001', checksum: 'old' }],
  [{ version: '001', checksum: 'new' }],
)).toThrow('MIGRATION_CHECKSUM_MISMATCH');
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/database/scripts/migration-lib.spec.ts`

Expected: FAIL，migration library 尚不存在。

- [ ] **Step 3: 编写权威初始 DDL**

`001_bootstrap.sql` 必须创建 `schema_migrations`、`app_user`、`shift`、`responsible_person`、`app_settings`、`daily_report`、`daily_report_revision`、`attachment`、`export_job`、`migration_run`、`migration_item`。所有表使用显式 text 主键；日元原始值用 `integer` 且 `CHECK (value BETWEEN 0 AND 2000000000)`；跨日报聚合由查询 cast 为 `bigint`。`daily_report` 包含两项网管餐费、四项服务器派生金额、`idempotency_key UNIQUE`、`UNIQUE(report_date, shift_id)` 和外键；revision 保存 JSONB before/after 快照。

- [ ] **Step 4: 实现 migration/verify/seed**

runner 在单个事务内锁定 `schema_migrations`、按文件名排序、计算 SHA-256、执行 DDL、记录版本和执行时间；错误时 rollback 并非零退出。verify 精确检查 10 张业务表、全部主键、两个 unique、金额列类型和 001 checksum。seed 只接受数据库名 `fsk_staging`，upsert 固定四班、`stage-admin`、`stage-kitchen` AppUser、合成负责人和底钱，不读取任何本地文件。

- [ ] **Step 5: 验证纯逻辑与现有仓库**

Run:

```bash
pnpm run test:amplify -- amplify/database/scripts/migration-lib.spec.ts
pnpm run typecheck:amplify
pnpm run check
```

Expected: migration planning PASS；尚未连接 AWS 或执行数据库写入。

- [ ] **Step 6: 提交**

```bash
git add amplify/database package.json
git commit -m "feat(amplify): 建立 PostgreSQL migration 基线"
```

---

### Task 6: 组合 foundation backend 并建立成本审批文档

**Files:**
- Create: `amplify/backend.foundation.ts`
- Create: `amplify/backend.ts`
- Create: `amplify/backend-composition.spec.ts`
- Create: `docs/aws/staging-cost-approval.md`
- Create: `docs/aws/staging-deployment-runbook.md`

**Interfaces:**
- Consumes: Tasks 2–4 的 Auth、Storage、Foundation。
- Produces: 第一次部署入口 `amplify/backend.ts`（此提交阶段只 re-export foundation composition）；带审批编号、预算上限和资源清单的部署门。

- [ ] **Step 1: 写 composition 失败测试**

测试导出的 `FOUNDATION_RESOURCE_SET` 精确为 `auth, storage, vpc, aurora, dataApi`，并断言不包含 `data`、`submitKitchenReport` 或 production 字符串。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/backend-composition.spec.ts`

Expected: FAIL，backend composition 尚未存在。

- [ ] **Step 3: 实现 foundation backend**

`backend.foundation.ts` 使用 `defineBackend({ auth, storage })`，创建 `FskStagingFoundation` stack，调用 `createStagingFoundation`，应用 Cognito override、Storage bucket override、标签和 CloudFormation outputs。`backend.ts` 在第一次部署提交中只导入 `./backend.foundation.js`；不得先导入尚未生成的 SQL schema。

- [ ] **Step 4: 写成本审批和两阶段部署 runbook**

成本表逐项列出 Aurora 活跃 ACU/存储/备份、Amplify build/hosting、Lambda、AppSync、CloudWatch、S3 版本、VPC endpoints、CloudShell 临时出口；记录 `MonthlyCeilingJpy`、批准人、JST 时间、批准范围和过期条件。部署 runbook 固定顺序为：foundation deploy → CloudShell VPC migration → schema generation → full backend deploy → Hosting build；每一项记录命令、stack ID、region 和清理责任人。

- [ ] **Step 5: 本地验证**

Run:

```bash
pnpm run test:amplify
pnpm run typecheck:amplify
pnpm run check:all
git diff --check
```

Expected: 全部 PASS；AWS 仍无写入。

- [ ] **Step 6: 提交 foundation 部署点**

```bash
git add amplify/backend.foundation.ts amplify/backend.ts amplify/backend-composition.spec.ts docs/aws/staging-cost-approval.md docs/aws/staging-deployment-runbook.md
git commit -m "feat(amplify): 组合 staging foundation backend"
git tag fsk-staging-foundation-v1
```

---

### Task 7: 审批门 A——创建独立 Amplify App 并部署 Foundation

**Files:**
- Modify: `docs/aws/staging-cost-approval.md`
- Modify: `docs/aws/staging-deployment-runbook.md`

**Interfaces:**
- Consumes: 用户明确批准的月预算上限、AWS account `444083008754`、region `ap-northeast-1`、tag `fsk-staging-foundation-v1`。
- Produces: 独立 Amplify App ID、staging backend branch、Foundation stack outputs；不连接 production，不导入真实数据。

- [ ] **Step 1: 停止并取得明确批准**

向用户展示成本表、将创建的资源和估算月上限。没有“批准首次 staging AWS 写入及该月上限”的明确回复时，本 Task 不执行任何后续步骤。

- [ ] **Step 2: 只读预检账号、区域和现有资源**

Run:

```bash
aws sts get-caller-identity
aws configure get region
aws amplify list-apps --region ap-northeast-1 --query 'apps[].{name:name,id:appId}'
aws rds describe-db-clusters --region ap-northeast-1 --query 'DBClusters[].DBClusterIdentifier'
```

Expected: Account 为 `444083008754`；目标区域明确；没有同名 `fsk-staging` 资源冲突。发现冲突时停止并先审计，不复用未知资源。

- [ ] **Step 3: 创建独立 App，连接 staging 分支并立即关闭自动构建**

在 Amplify Console 创建独立 `fsk-staging` Gen 2 App，只连接 Git `staging` 分支；在 Branch settings 关闭 Auto build。不要连接 `main`，不要启用 PR preview，不添加 production 环境变量。记录 App ID、branch ARN 和截图路径。

- [ ] **Step 4: 部署 foundation tag**

Run:

```bash
git checkout fsk-staging-foundation-v1
CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id "$AMPLIFY_APP_ID" --outputs-out-dir apps/web/public
git switch RE/amplify-gen2-staging-infrastructure
```

Expected: CloudFormation 完成 Auth、Storage、VPC、Aurora foundation；不得生成 AppSync Data API。`apps/web/public/amplify_outputs.json` 只用于本地核对，保持 ignored。

- [ ] **Step 5: 验证实际资源边界**

检查 Aurora `PubliclyAccessible=false`、0–2 ACU、Data API enabled、无 RDS Proxy、无 NAT Gateway；检查 Bucket Block Public Access/Versioning；检查 User Pool 禁止 self-sign-up 且仅 ADMIN/KITCHEN Groups。将 ARN 只记录为非敏感证据，不记录 Secret 值。

- [ ] **Step 6: 提交脱敏证据**

```bash
git add docs/aws/staging-cost-approval.md docs/aws/staging-deployment-runbook.md
git commit -m "docs(amplify): 记录 staging foundation 部署证据"
```

---

### Task 8: 从 CloudShell VPC 迁移空库并生成 SQL schema

**Files:**
- Create: `amplify/data/schema.sql.ts`（CLI 生成）
- Modify: `docs/aws/staging-deployment-runbook.md`

**Interfaces:**
- Consumes: Foundation Aurora endpoint/Secret、CloudShell VPC environment、`001_bootstrap.sql`。
- Produces: 已执行且验证的空 staging schema；由真实 Aurora 生成的 `generatedSqlSchema`。

- [ ] **Step 1: 创建临时 CloudShell VPC 环境**

选择 Foundation VPC 的应用私有子网和临时运维 Security Group；DB Security Group 只允许该组到 5432。若安装依赖需要出口，单独记录短时出口资源并设完成即删检查；禁止把 DB 改成 Publicly Accessible。

- [ ] **Step 2: 执行 migration 与只读验证**

在 CloudShell 获取本提交并通过 Secret 构造仅进程内 `DATABASE_URL`，执行：

```bash
pnpm install --frozen-lockfile
pnpm run db:staging:migrate
pnpm run db:staging:verify
```

Expected: `001` 一次成功；第二次 migrate 为 no-op；verify 返回 10 张业务表、约束和 checksum 全部正确。

- [ ] **Step 3: 设置 branch secret 并生成 schema**

在 Amplify staging branch secrets 中设置 `SQL_CONNECTION_STRING`，值来自 Aurora Secret 与 private endpoint；不写入 shell history或仓库。CloudShell VPC 中运行：

```bash
pnpm exec ampx generate schema-from-database --connection-uri-secret SQL_CONNECTION_STRING --app-id "$AMPLIFY_APP_ID" --branch staging --out amplify/data/schema.sql.ts
```

Expected: 文件包含所有带主键的业务表；命令从 VPC 内连接 private Aurora，无公网 5432。

- [ ] **Step 4: 带回并验证生成物**

将 `schema.sql.ts` 安全带回工作分支，运行 `git diff -- amplify/data/schema.sql.ts`；扫描并确认不含 hostname、username、password、ARN、合成密码。第二次生成应无 Git diff。

- [ ] **Step 5: 删除临时访问**

移除临时运维 Security Group ingress 和短时出口；确认 NAT Gateway 为 0、CloudShell 临时文件已清除。保留 CloudShell 环境本身时也不得保留数据库凭据文件。

- [ ] **Step 6: 提交生成 schema 与证据**

```bash
git add amplify/data/schema.sql.ts docs/aws/staging-deployment-runbook.md
git commit -m "feat(amplify): 生成 staging PostgreSQL 数据模型"
```

---

### Task 9: 实现 Claims/AppUser 双重鉴权和服务器金额计算

**Files:**
- Create: `amplify/functions/shared/claims.ts`
- Create: `amplify/functions/shared/claims.spec.ts`
- Create: `amplify/functions/shared/daily-report-calculations.ts`
- Create: `amplify/functions/shared/daily-report-calculations.spec.ts`
- Create: `amplify/functions/shared/errors.ts`

**Interfaces:**
- Consumes: Cognito JWT claims、数据库 `app_user` 快照、阶段 A 公式向量。
- Produces: `authorizeActor(claims, appUser, allowedRoles): AuthorizedActor`；`computeTrustedTotals(input): TrustedTotals`。

- [ ] **Step 1: 写鉴权与公式失败测试**

覆盖缺失 sub、未知 group、多 group、inactive、Cognito/AppUser role 不一致、KITCHEN 调 ADMIN 动作；公式覆盖现金餐费 1,200、支付宝 800、现金入金 15,000、实际销售 21,800、偏差 800，并断言客户端伪造派生值没有输入位置。

```ts
expect(computeTrustedTotals({
  previousImosBalanceYen: 10_000,
  currentImosBalanceYen: 32_000,
  newageYen: 8_000,
  cashTotalYen: 20_000,
  registerFloatYen: 5_000,
  expenseYen: 1_000,
  staffMealCashYen: 1_200,
  staffMealAlipayYen: 800,
})).toEqual({
  imosSalesYen: 22_000,
  cashDepositYen: 15_000,
  staffMealTotalYen: 2_000,
  totalSalesYen: 21_800,
  deviationYen: 800,
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/functions/shared/claims.spec.ts amplify/functions/shared/daily-report-calculations.spec.ts`

Expected: FAIL，共享模块尚不存在。

- [ ] **Step 3: 实现最小纯函数**

`authorizeActor` 只接受一个受支持 Group，要求 AppUser active 且角色完全一致，错误使用稳定码 `UNAUTHENTICATED`、`ROLE_MISMATCH`、`USER_INACTIVE`、`FORBIDDEN`。金额函数校验所有日元值为 `0..2_000_000_000` 整数，再按已批准公式计算；不接受 `totalSalesYen`、`cashDepositYen` 或创建人字段。

- [ ] **Step 4: 验证并提交**

```bash
pnpm run test:amplify -- amplify/functions/shared/claims.spec.ts amplify/functions/shared/daily-report-calculations.spec.ts
pnpm run typecheck:amplify
git add amplify/functions/shared
git commit -m "feat(amplify): 建立可信鉴权与金额计算"
```

---

### Task 10: 以事务和幂等实现厨房上下文与日报提交

**Files:**
- Create: `amplify/functions/shared/rds-data.ts`
- Create: `amplify/functions/shared/structured-log.ts`
- Create: `amplify/functions/submit-kitchen-report/service.ts`
- Create: `amplify/functions/submit-kitchen-report/service.spec.ts`
- Create: `amplify/functions/submit-kitchen-report/handler.ts`
- Create: `amplify/functions/submit-kitchen-report/resource.ts`

**Interfaces:**
- Consumes: `authorizeActor`、`computeTrustedTotals`、RDS Data API cluster/database/secret 环境变量。
- Produces: `getKitchenContext(input, deps)` 与 `submitKitchenReport(input, deps)`；Function handlers `kitchenReportContext`、`submitKitchenDailyReport`。

- [ ] **Step 1: 写 service 失败测试**

用 fake transaction repository 覆盖：KITCHEN 只得到班次、建议起时、前值、底钱、负责人、已提交布尔值；不返回历史金额。提交覆盖服务器快照、派生值重算、相同 idempotencyKey 返回同一 reportId、不同 key 同日同班冲突且响应不含旧日报、inactive/role mismatch 拒绝且不开始事务。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/functions/submit-kitchen-report/service.spec.ts`

Expected: FAIL，service 尚未定义。

- [ ] **Step 3: 实现事务 service**

事务顺序固定为：按 subject 读取并鉴权 AppUser → `SELECT ... FOR UPDATE` 读取班次/设置/负责人 → 查询 idempotencyKey → 相同 key 返回原 reportId → 检查业务日+班次冲突 → 服务器计算 → INSERT daily_report → COMMIT。唯一冲突统一映射为 `REPORT_ALREADY_EXISTS`，KITCHEN 响应只含错误码。

- [ ] **Step 4: 实现 handler 与 RDS Data API adapter**

handler 只从 AppSync identity 取 claims，生成 requestId，使用结构化 JSON 日志且不记录 Token/密码/连接串/完整 payload。adapter 使用 `BeginTransaction`、参数化 `ExecuteStatement`、`CommitTransaction`/`RollbackTransaction`；Lambda 不放入 VPC，不创建连接池。

- [ ] **Step 5: 验证并提交**

```bash
pnpm run test:amplify -- amplify/functions/submit-kitchen-report/service.spec.ts
pnpm run typecheck:amplify
git add amplify/functions/shared/rds-data.ts amplify/functions/shared/structured-log.ts amplify/functions/submit-kitchen-report
git commit -m "feat(amplify): 实现厨房可信日报提交"
```

---

### Task 11: 实现管理员更正、健康检查和 Storage 签名流程

**Files:**
- Create: `amplify/functions/admin-correct-report/service.ts`
- Create: `amplify/functions/admin-correct-report/service.spec.ts`
- Create: `amplify/functions/admin-correct-report/handler.ts`
- Create: `amplify/functions/admin-correct-report/resource.ts`
- Create: `amplify/functions/health-check/handler.ts`
- Create: `amplify/functions/health-check/resource.ts`
- Create: `amplify/functions/storage-upload/service.ts`
- Create: `amplify/functions/storage-upload/service.spec.ts`
- Create: `amplify/functions/storage-upload/handler.ts`
- Create: `amplify/functions/storage-upload/resource.ts`

**Interfaces:**
- Consumes: Tasks 4、9、10 的路径、鉴权、计算和 Data API adapters。
- Produces: `adminCorrectReport`、`healthCheck`、`issuePendingUpload`、`confirmAttachment` handlers。

- [ ] **Step 1: 写失败测试**

管理员更正必须在同一事务写 before/after revision 并重新计算；KITCHEN 调用拒绝。上传必须把 key 固定在调用者 sub 下，限制 size/MIME/SHA-256；确认时验证对象 metadata、移动到正式路径并使 KITCHEN 不再获得读取 URL。健康检查只返回 Auth/Data/Storage 状态和 requestId，不返回 endpoint/Secret。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/functions/admin-correct-report/service.spec.ts amplify/functions/storage-upload/service.spec.ts`

Expected: FAIL，services 尚不存在。

- [ ] **Step 3: 实现最小 services 与 handlers**

管理员更正锁定日报，保存 JSONB 快照、应用允许字段、服务器重算并写 revision。上传 URL 有效期 5 分钟，最大 5 MiB，仅允许 `image/jpeg`、`image/png`、`application/pdf`；确认后正式 key 由服务器生成。健康检查对数据库执行 `SELECT 1`，对 S3 执行只读 metadata 调用，错误只映射成依赖名称。

- [ ] **Step 4: 验证并提交**

```bash
pnpm run test:amplify -- amplify/functions/admin-correct-report/service.spec.ts amplify/functions/storage-upload/service.spec.ts
pnpm run typecheck:amplify
git add amplify/functions/admin-correct-report amplify/functions/health-check amplify/functions/storage-upload
git commit -m "feat(amplify): 添加管理更正与附件边界"
```

---

### Task 12: 组合 Amplify Data 的受控读取和自定义 Mutation

**Files:**
- Create: `amplify/data/resource.ts`
- Create: `amplify/data/access-contract.ts`
- Create: `amplify/data/access-contract.spec.ts`
- Modify: `amplify/backend.ts`

**Interfaces:**
- Consumes: 生成的 `generatedSqlSchema`、Tasks 10–11 Functions、Auth/Foundation resources。
- Produces: `Schema` type；ADMIN SQL 模型读取；KITCHEN 最小 context query；可信写入 mutations；最终 full backend composition。

- [ ] **Step 1: 写访问矩阵失败测试**

```ts
expect(canInvoke('KITCHEN', 'kitchenReportContext')).toBe(true);
expect(canInvoke('KITCHEN', 'submitKitchenDailyReport')).toBe(true);
expect(canInvoke('KITCHEN', 'listDailyReports')).toBe(false);
expect(canInvoke('KITCHEN', 'adminCorrectReport')).toBe(false);
expect(canInvoke('ADMIN', 'listDailyReports')).toBe(true);
expect(canInvoke('ADMIN', 'adminCorrectReport')).toBe(true);
expect(canInvoke(undefined, 'healthCheck')).toBe(false);
```

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/data/access-contract.spec.ts`

Expected: FAIL，access contract 尚不存在。

- [ ] **Step 3: 实现 SQL 模型授权与自定义操作**

对生成 SQL 模型只授予 `ADMIN` read；显式排除 generic create/update/delete 给客户端。使用 `.addToSchema()` 定义 `kitchenReportContext`、`submitKitchenDailyReport`、`adminCorrectReport`、`issuePendingUpload`、`confirmAttachment`、`healthCheck`，每项返回最小自定义类型并用 `a.handler.function(...)` 绑定对应 Function；不得启用 apiKey/guest authorization。

- [ ] **Step 4: 组合最终 backend 和跨资源授权**

`backend.ts` 改为最终 `defineBackend` 组合；将 cluster ARN、secret ARN、database name、bucket name 通过环境变量注入 Functions，授予最小 `grantDataApiAccess`、Secret read 和指定 Bucket action。SQL Lambda 只允许从自己的 Security Group 进入数据库 5432。保留 `backend.foundation.ts` 和 tag，供空环境第一阶段恢复。

- [ ] **Step 5: 验证并提交**

```bash
pnpm run test:amplify -- amplify/data/access-contract.spec.ts
pnpm run typecheck:amplify
pnpm run check:all
git add amplify/data/resource.ts amplify/data/access-contract.ts amplify/data/access-contract.spec.ts amplify/backend.ts
git commit -m "feat(amplify): 接入受控 SQL Data API"
```

---

### Task 13: 建立合成 Cognito/数据库 seed 与 bcrypt 能力探测

**Files:**
- Create: `amplify/tests/synthetic-fixtures.ts`
- Create: `amplify/tests/synthetic-fixtures.spec.ts`
- Create: `amplify/tests/create-staging-users.ts`
- Create: `amplify/tests/password-hash-import.ts`
- Create: `amplify/tests/password-hash-import.spec.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: staging User Pool ID、ADMIN/KITCHEN Groups、Aurora Data API、一次性测试密码环境变量。
- Produces: 可重复执行的 `stage-admin`/`stage-kitchen` 创建和清理；`BCRYPT_IMPORT_SUPPORTED=true|false` 脱敏证据。

- [ ] **Step 1: 写 fixture 与清理失败测试**

断言 fixture 只能生成 `stage-*` 用户，role 只有 ADMIN/KITCHEN，bcrypt rounds 精确为 10，CSV 不写仓库，finally 无论成功失败都调用删除 disposable user/job artifacts；环境变量出现 `prod`、用户名不是 `stage-` 或 hash 来源是文件时立即拒绝。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/tests/synthetic-fixtures.spec.ts amplify/tests/password-hash-import.spec.ts`

Expected: FAIL，fixture/probe 尚不存在。

- [ ] **Step 3: 实现合成账号脚本**

使用 Cognito Admin API 创建 `stage-admin`、`stage-kitchen`，加入对应 Group，再调用数据库 seed upsert 相同 subject。密码只从进程环境读取，不输出；脚本重复执行时校验既有 Group，不创建第三个角色。

- [ ] **Step 4: 实现 bcrypt cost 10 probe**

生成 disposable `stage-hash-probe-${Date.now()}` 和 cost 10 hash，创建/import/start job，首次使用 `USER_PASSWORD_AUTH` 验证原密码，成功转换后使用 SRP 客户端验证；记录 success 或 AWS 明确错误码。`finally` 删除用户、临时 CSV 和临时 Secret；不把失败自动解释为支持或不支持。

- [ ] **Step 5: 本地验证并提交**

```bash
pnpm run test:amplify -- amplify/tests/synthetic-fixtures.spec.ts amplify/tests/password-hash-import.spec.ts
pnpm run typecheck:amplify
git add amplify/tests package.json
git commit -m "test(amplify): 添加合成身份迁移探测"
```

---

### Task 14: 最小接入 Vue runtime 与 Hosting 构建

**Files:**
- Create: `apps/web/src/cloud/configure-amplify.ts`
- Create: `apps/web/src/cloud/configure-amplify.spec.ts`
- Modify: `apps/web/src/main.ts`
- Modify: `apps/web/src/env.d.ts`
- Create: `amplify.yml`

**Interfaces:**
- Consumes: CLI 生成且被 Hosting 作为静态配置发布的 `apps/web/public/amplify_outputs.json`、`VITE_RUNTIME_MODE`。
- Produces: `configureCloudRuntime(mode): Promise<'local' | 'amplify-staging'>`；Hosting 从已部署 staging backend 获取 outputs 后构建 Vue。

- [ ] **Step 1: 写 runtime mode 失败测试**

用 mock `fetch` 和 `Amplify.configure` 断言 local 模式不请求 outputs、不调用配置；`amplify-staging` 才请求 `/amplify_outputs.json` 并配置；缺失/无效 outputs 时在 mount 前抛稳定错误，不回退到本地 API。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm --filter @finance/web test -- src/cloud/configure-amplify.spec.ts`

Expected: FAIL，cloud runtime module 尚不存在。

- [ ] **Step 3: 实现条件配置且不改路由/角色**

`main.ts` 在创建 Vue app 前 await `configureCloudRuntime(import.meta.env.VITE_RUNTIME_MODE ?? 'local')`。local 默认继续使用现有 NestJS/JWT、`WEBMASTER` 路由和 setup store；本 Task 不改 `stores/auth.ts`、`router/index.ts`、业务 views。

- [ ] **Step 4: 编写 Hosting build spec**

`amplify.yml` 使用 pnpm frozen lockfile；backend phase 只运行：

```bash
pnpm exec ampx generate outputs --branch "$AWS_BRANCH" --app-id "$AWS_APP_ID" --out-dir apps/web/public
```

frontend phase 运行 `pnpm run check:all` 和 `pnpm --filter @finance/web build`，artifact baseDirectory 为 `apps/web/dist`。不得包含 `ampx pipeline-deploy`，从而让普通 Hosting build 无权修改 backend。

- [ ] **Step 5: 验证并提交**

```bash
pnpm --filter @finance/web test -- src/cloud/configure-amplify.spec.ts
pnpm run typecheck:web
pnpm run build:web
git add apps/web/src/cloud apps/web/src/main.ts apps/web/src/env.d.ts amplify.yml
git commit -m "feat(web): 接入 staging Amplify runtime"
```

---

### Task 15: 审批门 B——部署完整 backend、Hosting 和合成数据

**Files:**
- Modify: `docs/aws/staging-deployment-runbook.md`

**Interfaces:**
- Consumes: 用户明确批准的第二次部署、最终 backend commit、branch secrets、合成账号密码环境变量。
- Produces: 部署完成的 Data/Functions/Hosting staging，不包含 production 或真实数据。

- [ ] **Step 1: 停止并展示变更集**

先用只读/无执行模式查看 Git diff、CDK assertions、现有 stack 和预计新增资源；向用户列出 AppSync、SQL Lambda、Updater Lambda、业务 Functions、日志和预估费用变化。没有明确批准时不执行 deployment。

- [ ] **Step 2: 执行完整 backend deploy**

Run:

```bash
CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id "$AMPLIFY_APP_ID" --outputs-out-dir apps/web/public
```

Expected: Data、Functions 和跨资源权限部署成功；不出现 production stack；generated outputs 保持 ignored。

- [ ] **Step 3: 创建合成用户和 seed**

Run:

```bash
pnpm run db:staging:seed
pnpm exec tsx amplify/tests/create-staging-users.ts
```

Expected: 只有两个 stage 用户、固定四班和合成设置；重复运行无重复记录。

- [ ] **Step 4: 手动触发 Hosting build**

保持 branch Auto build 关闭，由 Console 手动 Start build。构建环境设 `VITE_RUNTIME_MODE=amplify-staging`；检查公开 bundle 不含 Secret、连接串或合成密码。记录 HTTPS staging URL 和 build ID。

- [ ] **Step 5: 运行 bcrypt probe 并记录结果**

Run: `pnpm exec tsx amplify/tests/password-hash-import.ts`

Expected: 得到明确 supported 成功链路，或保存 AWS 返回的明确错误码并把有限期 Migration Lambda 标记为正式迁移回退；disposable 用户和文件已删除。

- [ ] **Step 6: 提交脱敏部署证据**

```bash
git add docs/aws/staging-deployment-runbook.md
git commit -m "docs(amplify): 记录 staging 全栈部署证据"
```

---

### Task 16: 执行合成端到端、越权和 Aurora 自动暂停验收

**Files:**
- Create: `amplify/tests/staging-smoke.ts`
- Create: `amplify/tests/staging-smoke-contract.spec.ts`
- Modify: `docs/aws/staging-deployment-runbook.md`

**Interfaces:**
- Consumes: staging URL/outputs、stage 用户环境密码、部署后的 AppSync/Auth/Storage/Aurora。
- Produces: 机器可读脱敏验收结果，覆盖正向、幂等、冲突、负向授权、Storage 和 0 ACU。

- [ ] **Step 1: 写 smoke case 清单失败测试**

测试强制 case IDs 完整且不能跳过：`ADMIN_READ_ALLOWED`、`KITCHEN_CONTEXT_MINIMAL`、`KITCHEN_SUBMIT_RECALCULATED`、`IDEMPOTENT_RETRY_SAME_RESULT`、`DUPLICATE_SHIFT_CONFLICT_NO_LEAK`、`KITCHEN_HISTORY_DENIED`、`KITCHEN_ANALYTICS_DENIED`、`KITCHEN_SETTINGS_DENIED`、`KITCHEN_USERS_DENIED`、`CROSS_SUBJECT_PENDING_DENIED`、`FORMAL_ATTACHMENT_DENIED`、`PUBLIC_S3_DENIED`、`AURORA_REACHES_ZERO_ACU`。

- [ ] **Step 2: 实现 smoke runner**

runner 登录两个合成账号，先用 KITCHEN 读取最小上下文并断言响应没有销售/历史字段；提交带现金餐费 1,200 和支付宝 800 的日报，管理员读取确认数据库值和服务器派生值；重放相同 key、再用不同 key 冲突；逐项执行越权和 Storage 负向请求。输出仅含 caseId、PASS/FAIL、requestId、耗时，不含 Token/密码/完整日报。

- [ ] **Step 3: 本地检查 runner contract**

Run: `pnpm run test:amplify -- amplify/tests/staging-smoke-contract.spec.ts`

Expected: case IDs 完整，任何 case 不得软跳过。

- [ ] **Step 4: 运行云端 smoke**

Run: `pnpm exec tsx amplify/tests/staging-smoke.ts`

Expected: 前 12 项全部 PASS；失败即停止阶段完成声明，保留 requestId 查 CloudWatch。

- [ ] **Step 5: 验证真实自动暂停**

停止 smoke、CloudShell 和运维连接，等待配置的 auto-pause 窗口后查询 `ServerlessV2Usage` 与 cluster 状态；必须观察 usage 为 0。未到 0 时检查 SQL Lambda、Functions 和运维连接，不提高最小 ACU 来掩盖问题。

- [ ] **Step 6: 提交 runner 与脱敏结果**

```bash
git add amplify/tests/staging-smoke.ts amplify/tests/staging-smoke-contract.spec.ts docs/aws/staging-deployment-runbook.md
git commit -m "test(amplify): 验证 staging 权限与账务闭环"
```

---

### Task 17: 审批门 C——告警、预算和可恢复销毁流程

**Files:**
- Create: `amplify/observability/resource.ts`
- Create: `amplify/observability/resource.spec.ts`
- Create: `docs/aws/staging-destroy-runbook.md`
- Modify: `amplify/backend.ts`
- Modify: `docs/aws/staging-cost-approval.md`

**Interfaces:**
- Consumes: 实际 Function/AppSync/Aurora/Storage resources、批准的月预算上限和通知目标。
- Produces: 最小 CloudWatch alarms、AWS Budget/Cost Anomaly evidence、默认 dry-run 的销毁 runbook。

- [ ] **Step 1: 写 alarm 断言失败测试**

CDK tests 断言 Function errors/timeouts、AppSync 5xx、Aurora connection failure、Storage conversion failure 和长时间未降 0 ACU 均有 alarm；日志保留天数明确；alarm payload 不含 Secret。

- [ ] **Step 2: 运行并确认失败**

Run: `pnpm run test:amplify -- amplify/observability/resource.spec.ts`

Expected: FAIL，observability resource 尚不存在。

- [ ] **Step 3: 实现 alarms 和销毁 runbook**

报警阈值保持 staging 低流量可解释，并标出 insufficient-data 行为。销毁 runbook 首先只读列出 stacks、NAT、endpoints、RDS、snapshots、S3 versions、logs；实际销毁前再次批准，先创建命名 final snapshot，再关闭删除保护、删除 stack，最后单独询问是否删除 snapshot/Bucket versions。

- [ ] **Step 4: 停止并取得预算/告警写入批准**

向用户展示 Budget amount、通知对象、alarms 数量和预计日志费用；没有明确批准时只提交代码和 runbook，不创建 Budget、Anomaly Monitor 或新 alarms。

- [ ] **Step 5: 获批后部署并验证**

Run:

```bash
CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id "$AMPLIFY_APP_ID" --outputs-out-dir apps/web/public
```

Expected: alarms 状态可见，Budget/Anomaly Detection 已记录，未创建 NAT/RDS Proxy/production 资源。

- [ ] **Step 6: 提交**

```bash
git add amplify/observability amplify/backend.ts docs/aws/staging-destroy-runbook.md docs/aws/staging-cost-approval.md
git commit -m "feat(amplify): 添加 staging 成本与清理护栏"
```

---

### Task 18: 最终回归、证据审计和 Phase B 完成判定

**Files:**
- Modify: `docs/aws/staging-deployment-runbook.md`
- Modify: `docs/aws/staging-cost-approval.md`
- Modify: `docs/aws/staging-destroy-runbook.md`

**Interfaces:**
- Consumes: Tasks 1–17 的测试、部署 ID、CloudWatch 指标、bcrypt probe 和成本证据。
- Produces: 明确的 `PASS` 或 `BLOCKED` Phase B 结论；不自动进入 Phase C/production。

- [ ] **Step 1: 运行完整本地验证**

Run:

```bash
pnpm install --frozen-lockfile
pnpm run check:all
git diff --check
git status --short
```

Expected: API/Web/Amplify tests、strict typecheck、API/Web builds 全部通过；仅存在本 Task 的文档改动。

- [ ] **Step 2: 审计云端证据**

逐项确认：独立 staging App；无 production；private Aurora；0–2 ACU 且实际到 0；无 Proxy/NAT；schema 重生成无 diff；ADMIN/KITCHEN 权限矩阵；服务器餐费计算；幂等/冲突；S3 非公开和跨用户拒绝；bcrypt probe 明确结果；Budget/alarms；临时 CloudShell 访问已清理。

- [ ] **Step 3: 执行只读费用残留检查**

列出 RDS clusters/snapshots、NAT gateways、VPC endpoints、S3 buckets/versions、CloudWatch log groups、Amplify branches 和当月 Cost Explorer；未知或意外持续费用使结论为 `BLOCKED`，不得口头忽略。

- [ ] **Step 4: 写完成判定**

只有所有验收项有证据时写 `Phase B: PASS`。任一项失败时写 `Phase B: BLOCKED`、失败 caseId、资源 ARN/stack ID、下一次安全动作；不得把 staging PASS 描述成 production 上线、真实迁移或 NestJS 退役。

- [ ] **Step 5: 提交最终证据**

```bash
git add docs/aws/staging-deployment-runbook.md docs/aws/staging-cost-approval.md docs/aws/staging-destroy-runbook.md
git commit -m "docs(amplify): 完成 staging 阶段验收审计"
```

## 官方实施依据

- Amplify SQL/PostgreSQL 连接、VPC 内 schema 生成、生成 schema 与授权：<https://docs.amplify.aws/nextjs/build-a-backend/data/connect-to-existing-data-sources/connect-postgres-mysql-database/>
- Amplify CLI `pipeline-deploy`、`generate outputs`、`generate schema-from-database`：<https://docs.amplify.aws/vue/reference/cli-commands/>
- Amplify Gen 2 monorepo/共享 backend：<https://docs.amplify.aws/vue/deploy-and-host/fullstack-branching/monorepos/>
- 禁止 Hosting 自动构建并拆分 backend deploy 与 outputs：<https://docs.amplify.aws/javascript/deploy-and-host/fullstack-branching/custom-pipelines/>
- Cognito 用户名登录 override：<https://docs.amplify.aws/nextjs/build-a-backend/auth/concepts/usernames/>
- Cognito Groups 授权：<https://docs.amplify.aws/nextjs/build-a-backend/auth/concepts/user-groups/>
- Cognito Password Hash Import 与 bcrypt 首次登录限制：<https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-using-import-tool.html>
- Amplify Storage 设置和授权：<https://docs.amplify.aws/vue/build-a-backend/storage/set-up-storage/>、<https://docs.amplify.aws/javascript/build-a-backend/storage/authorization/>
