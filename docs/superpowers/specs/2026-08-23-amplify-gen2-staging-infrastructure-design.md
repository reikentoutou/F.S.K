# FSK Amplify Gen 2 Staging 基础设施设计书

## 1. 文档目的

本文档定义 FSK 迁移的阶段 B：为独立的 Amplify Gen 2 Web App 建立可重复部署、可验证、可清理的 staging 基础设施。

本文以 [`2026-08-23-fsk-amplify-gen2-migration-design.md`](./2026-08-23-fsk-amplify-gen2-migration-design.md) 为总体架构基线，并承接已经完成的网管餐费数据契约。阶段 B 只建立非生产云边界和最小端到端验证链路，不迁移真实数据、不切换店内入口，也不退役现有 NestJS、SQLite 或 JWT。

当前设计和后续实施计划的提交都不代表已创建 AWS 资源。首次 staging 部署必须另行通过成本和执行批准。

## 2. 已确认决策

| 决策项 | 结论 |
| --- | --- |
| 环境范围 | 只建设完整 staging；production 只保留参数与验收门槛，不创建资源 |
| AWS 区域 | `ap-northeast-1` |
| 数据库 | Aurora PostgreSQL Serverless v2，`0–2 ACU`，允许自动暂停 |
| 数据库网络 | 全程私有，不设置公网入口 |
| RDS Proxy | 初期不创建 |
| Schema 生成入口 | 临时 CloudShell VPC 环境；临时网络出口用完即删 |
| 身份认证 | Cognito User Pool，禁止自助注册 |
| 角色 | 只保留 `ADMIN`、`KITCHEN`，不创建 `WEBMASTER` |
| 密码迁移优先级 | 优先验证 bcrypt cost `10` Password Hash Import；不可用时才采用有限期 Migration Lambda |
| staging 数据 | 只使用合成账号、班次、日报和附件，不导入真实 SQLite、用户哈希或 uploads |
| 数据访问 | Amplify Data/AppSync 提供受控读取；自定义 Mutation + Functions 承担可信写入 |
| Storage | 独立 staging S3、Block Public Access、加密、Versioning、`keepOnDelete` |
| Hosting | 只连接 staging 分支；业务 API 必须登录，不叠加 Hosting Basic Auth |

## 3. 阶段范围

### 3.1 纳入阶段 B

- 新建独立 Amplify Gen 2 backend 的代码结构。
- 定义 staging 资源命名、标签、区域和环境参数。
- 定义 VPC、跨两个可用区的子网、安全组和私有 Aurora。
- 定义 Cognito User Pool、App Client、`ADMIN`/`KITCHEN` Groups 和授权边界。
- 定义 Amplify Data/AppSync 的管理员受控读取和厨房最小上下文读取。
- 建立厨房可信提交、管理员更正和健康检查 Function 的最小框架。
- 定义 Amplify Storage/S3 路径、访问规则、加密、版本和生命周期。
- 定义版本化 PostgreSQL migration、生成 SQL schema、合成 seed 和验证工具。
- 定义 CloudWatch 结构化日志、基础告警、成本检查和清理流程。
- 建立一条合成数据端到端链路：管理员读取、厨房提交、重复提交、越权拒绝。

### 3.2 不纳入阶段 B

- 不创建 production AWS 资源。
- 不导入真实 SQLite、Cognito 用户哈希或 `uploads/`。
- 不连接 production 数据库或 Bucket。
- 不切换当前店内入口，不建立长期双写。
- 不退役 NestJS、SQLite、JWT 或当前备份恢复能力。
- 不完成全部 Vue 业务页面迁移。
- 不生成正式 Excel/PDF，只验证异步导出和 Storage 边界所需的最小接口。
- 不执行真实账务切换、生产回滚或生产数据库恢复演练。
- 不在本阶段完成 iPhone 16 Pro Max、iPhone 7 Plus iOS 15.8.4 的完整 PWA 真机验收。

## 4. 目标拓扑

```text
Vue / PWA
  ├─ Cognito：登录、Token、ADMIN/KITCHEN Group
  ├─ Amplify Data / AppSync
  │    ├─ ADMIN 受控读取 → Amplify SQL Lambda → 私有 Aurora PostgreSQL
  │    └─ 自定义 Mutation → 可信业务 Function → 私有 Aurora PostgreSQL
  └─ Amplify Storage
       ├─ KITCHEN 自己的 pending 路径
       └─ Function 管理的正式附件、导出和迁移暂存路径
```

静态 Hosting 可以公开加载登录页、Manifest、图标和 Service Worker，但任何业务数据访问都必须通过 Cognito 授权。客户端不持有数据库凭据，也不能绕过 Function 直接执行通用写入。

## 5. 环境和资源隔离

- staging 使用独立 Amplify backend branch/sandbox、User Pool、Aurora、S3 和日志资源。
- production 的资源名、ARN、连接串和 Bucket 不得出现在 staging Secret 或环境变量中。
- 资源名称统一带 `fsk`、`staging` 和资源用途标识。
- 所有支持标签的资源至少包含 `Project=FSK`、`Environment=staging`、`ManagedBy=AmplifyGen2` 和成本归属标签。
- 当前 `main` 不连接 production backend；首次只连接 staging 发布分支。
- Amplify 输出文件按项目规则生成和使用，不手工伪造连接信息。

## 6. 网络设计

### 6.1 VPC 和数据库子网

- VPC 跨两个可用区，Aurora DB subnet group 至少包含两个可用区的私有数据库子网。
- Aurora `PubliclyAccessible=false`，不分配可从互联网直接访问的入口。
- 数据库安全组只接受指定 Amplify SQL Lambda 和可信业务 Functions 的 PostgreSQL `5432` 流量。
- 禁止 `0.0.0.0/0:5432`、`::/0:5432` 或开发机长期入站规则。
- 数据库强制 TLS；连接串和证书配置只保存在 Amplify Secret/Secrets Manager。

### 6.2 AWS 服务访问和临时出口

- S3 使用 Gateway Endpoint，避免 Function 为访问 S3 建立长期公网出口。
- 实施前通过 backend synth 和运行链路列出确实需要的 Interface VPC Endpoints；不预先堆叠无证据的 Endpoint。
- staging 不设置长期 NAT Gateway。
- 生成 PostgreSQL schema 时创建 CloudShell VPC 环境进入同一 VPC。
- 如果 CloudShell 需要下载依赖，只创建短时受控出口；资源必须带任务标签，并在 schema 生成结束后检查删除状态和费用状态。
- CloudShell VPC 使用临时文件系统；生成产物必须在会话结束前安全带回工作分支并进行 diff 验证。

### 6.3 Aurora 自动暂停

- Aurora Serverless v2 容量范围设置为 `0–2 ACU`，使用支持 0 ACU 的 Aurora PostgreSQL 版本。
- 不创建 RDS Proxy，避免代理维持连接而阻止暂停。
- 应用连接设置短空闲时间，Function 不建立无限期连接池。
- 验收必须观察空闲窗口之后的 `ServerlessV2Usage = 0`；仅配置最小 0 ACU 不算通过。
- 如果无法暂停，先定位 SQL Lambda、Function 或运维连接，再决定是否调整实现；不能在未说明的情况下接受持续计费。

## 7. PostgreSQL Schema 管理

### 7.1 权威来源

- 版本控制中的 SQL migration 是 PostgreSQL DDL 的权威来源。
- migration 建议放在 `amplify/database/migrations/`，文件使用递增版本和稳定名称。
- 数据库使用 `schema_migrations` 记录 migration 版本、校验和、执行时间和执行结果。
- migration 通过受控脚本执行，遇到错误立即停止；可事务化的 DDL 在事务中完成。
- 不依赖 Amplify Data 自动创建或修改 PostgreSQL 表。

### 7.2 初始模型边界

初始 migration 至少建立总体设计中确认的：

- `AppUser`
- `Shift`
- `ResponsiblePerson`
- `AppSettings`
- `DailyReport`
- `DailyReportRevision`
- `Attachment`
- `ExportJob`
- `MigrationRun`
- `MigrationItem`

`DailyReport` 保留 `[reportDate, shiftId]` 唯一约束、日元整数金额、网管餐费现金和支付宝字段；跨日报聚合使用 PostgreSQL `BIGINT`。所有表必须有显式主键，确保 Amplify 能生成 SQL schema。

### 7.3 Amplify SQL Schema

1. 在空 Aurora 执行已提交的 SQL migration。
2. 通过 CloudShell VPC 运行 `ampx generate schema-from-database`。
3. 将生成结果保存为 `amplify/data/schema.sql.ts`。
4. `schema.sql.ts` 只允许生成命令更新，禁止手工修改。
5. 授权规则、字段重命名和自定义 Query/Mutation 在外层资源文件组合。
6. CI 在相同 migration 上重新生成 schema；存在未提交差异时失败。

## 8. 数据访问和可信写入

### 8.1 Amplify Data 读取

- `ADMIN` 可以读取日报列表、日报详情、固定班次、负责人、设置和审计记录。
- `KITCHEN` 只能调用完成当前填报所需的最小上下文 Query。
- 厨房上下文只返回建议开始时间、前值、底钱、班次和是否已提交，不返回历史日报内容或销售金额列表。
- 禁止 public API key 和 guest access。
- 生成的 SQL 模型不向客户端开放通用 create/update/delete。

### 8.2 Function 可信写入

下列能力只通过自定义 Mutation/Function 或事务 SQL Handler：

- 厨房日报提交与幂等重试。
- 日报金额重新计算。
- 管理员补录、更正和审计快照。
- 设置、负责人和用户状态写入。
- 附件确认、正式路径转换和日报关联。
- 统计、导出和后续迁移任务。

Function 必须：

1. 从 Cognito Claims 获取调用身份和 Group。
2. 查询 `AppUser` 并确认 active 和角色映射一致。
3. 忽略客户端提交的角色、创建人、派生金额和审计身份。
4. 在服务器读取底钱、班次和负责人。
5. 重新计算 `cashDepositYen`、`staffMealTotalYen`、`totalSalesYen` 和 `deviationYen`。
6. 在单个 PostgreSQL 事务内执行幂等检查、唯一约束写入和审计记录。

`idempotencyKey` 处理规则：相同 Key 的安全重试返回同一结果，不创建第二份日报；不同 Key 对同一 `[reportDate, shiftId]` 的提交返回冲突，且不向 `KITCHEN` 泄露已存在日报内容。

## 9. Cognito 和角色

### 9.1 User Pool

- 禁止 self sign-up。
- 只允许用户名登录；用户名创建后不修改。
- 只建立 `ADMIN` 和 `KITCHEN` Groups。
- staging 的账号恢复由管理员控制，不依赖真实手机号或邮箱。
- MFA 在 staging 只验证兼容能力，不设为全员强制；production MFA 另行安全决策。

### 9.2 Cognito 与 AppUser 双重校验

- Cognito Group 是 API 入口授权依据。
- PostgreSQL `AppUser` 是业务 active 状态、角色和审计快照依据。
- 两者角色不一致时拒绝请求并记录结构化安全事件，不能任选一方继续执行。
- UI 菜单隐藏只属于体验层，不替代 AppSync 授权、Function 校验和数据库约束。

### 9.3 bcrypt Password Hash Import 能力探测

阶段 B 只使用 disposable 合成凭据：

1. 生成 bcrypt cost `10` 的测试哈希。
2. 创建 User Import Job，检查 User Pool 是否支持 `BCRYPT` Password Hash Import。
3. 验证首次登录可以使用原密码。
4. 首次登录使用 `USER_PASSWORD_AUTH`；凭据转换后验证后续 SRP 登录。
5. 删除 disposable 用户、CSV、临时文件和相关 Secret。

如果账号或 User Pool 尚不支持该能力，记录 Console/API 证据，并把有限期 Migration Lambda 作为后续正式用户迁移的回退路线。不得为了保留旧密码而长期保留 NestJS 登录服务。

正式迁移时的角色映射仍为 `ADMIN → ADMIN`、`WEBMASTER → KITCHEN`，并保留旧用户 ID、用户名快照、创建时间和日报关系；阶段 B 不执行这次真实迁移。

## 10. 合成测试数据

staging 只建立：

- `stage-admin`
- `stage-kitchen`
- 固定四班正式 ID、名称、顺序和 active 状态
- 合成负责人和底钱设置
- 覆盖零值、正常值、最大边界、网管餐费现金、支付宝和重复提交的合成日报
- 用于 Storage 验证的小型合成附件

seed 必须可重复运行，重复执行不能创建重复班次、用户或日报。seed 不读取本地 `dev.db`、备份 ZIP、真实 bcrypt 哈希或 `uploads/`。

## 11. Storage 和附件

### 11.1 路径

```text
pending/{cognitoSubject}/{draftId}/{attachmentId}/{sanitizedFileName}
daily-reports/{reportId}/{attachmentId}/{sanitizedFileName}
exports/{cognitoSubject}/{exportJobId}/{fileName}
migration-staging/{migrationRunId}/source.zip
```

### 11.2 权限和生命周期

- Bucket 启用 Block Public Access、静态加密、Versioning 和 `keepOnDelete`。
- `KITCHEN` 只可以操作自己 subject 下的 `pending/`。
- 提交成功后由 Function 校验大小、MIME、SHA-256 和日报关系，再转入正式路径。
- `KITCHEN` 提交成功后失去正式附件读取和删除能力。
- `ADMIN` 使用限时签名 URL 查看正式附件。
- `pending/`、测试导出和 migration staging 使用短生命周期；正式附件不自动过期。
- Phase B 只验证合成小文件、非法路径、跨用户访问和提交后的权限变化，不实现正式 Excel/PDF。

## 12. Hosting 和前端边界

- 新 Amplify App 首次只连接 staging 分支，不连接 `main` 的 production 发布。
- 使用 Amplify HTTPS 域名，不叠加 Hosting Basic Auth。
- 登录页、Manifest、图标和 Service Worker 可公开加载；业务数据必须登录。
- 公开静态产物中不得包含 Secret、连接串或合成账号密码。
- 每次部署前必须通过 typecheck、现有测试、构建和 backend synth。
- 本阶段只接入 Auth/Data/Storage 的最小验证页面或测试入口，不迁移全部业务页面。

## 13. 日志、告警和成本

### 13.1 日志

- Function 使用结构化 JSON 日志，记录请求 ID、业务动作、耗时和结果。
- 不记录密码、Token、数据库连接串、完整 Cognito 迁移事件、附件内容或完整请求体。
- 对需要追踪的 Cognito subject 使用最小必要标识，不把敏感属性复制进日志。

### 13.2 告警

至少监控：

- Function 错误率和超时。
- AppSync 5xx。
- Aurora 连接失败。
- Cognito 导入失败。
- Storage 转换失败。
- Aurora 长时间未降到 0 ACU。

### 13.3 成本门槛

- 首次部署前建立资源级月成本表。
- 启用 AWS Budget 和 Cost Anomaly Detection。
- 列出 Aurora 存储、活跃 ACU、VPC Endpoint、临时出口、Amplify build/hosting、日志和 S3 版本成本。
- 在用户批准月度预算上限前，不执行首次 staging 部署。
- 临时 NAT/出口、测试快照和保留 Bucket 必须进入部署后费用复查。

## 14. 代码结构

```text
amplify/
├── backend.ts
├── auth/resource.ts
├── data/
│   ├── resource.ts
│   └── schema.sql.ts
├── storage/resource.ts
├── functions/
│   ├── submit-kitchen-report/
│   ├── admin-correct-report/
│   └── health-check/
└── database/
    ├── migrations/
    ├── seeds/
    └── scripts/
```

实际文件拆分以实施计划为准，但不能改变以下所有权：SQL migration 管数据库结构，生成文件反映实际数据库，Function 持有可信写入，前端只持有用户输入和展示状态。

## 15. 实施顺序

1. 建立 Amplify Gen 2 最小 backend 和本地配置。
2. 定义 staging 环境参数、资源名称和标签。
3. 定义 Cognito、Groups 和禁止自助注册配置。
4. 定义 VPC、私有子网、安全组和 Aurora。
5. 执行版本化 SQL migration。
6. 从实际 Aurora 生成 `schema.sql.ts`。
7. 配置 ADMIN 受控读取和 KITCHEN 最小上下文读取。
8. 按测试驱动实现厨房可信提交 Function。
9. 定义 Storage 路径、权限和生命周期。
10. 建立合成 seed、权限矩阵测试和清理工具。
11. 生成成本表并等待首次部署批准。
12. 获批后部署 staging，执行云端验收和清理演练。

## 16. 验收标准

### 16.1 本地和静态验证

- API/Web 现有测试、typecheck 和构建继续通过。
- Amplify backend synth 成功，不依赖未记录的 Console 手改。
- migration 在空数据库执行成功，失败会停止且不留下半完成状态。
- 对同一数据库版本重新生成 `schema.sql.ts` 不产生意外 Git diff。
- 基础设施模板显示 Aurora 为私有，不存在公开 `5432` 入站。

### 16.2 云端端到端验证

- `stage-admin` 可以读取允许的日报、班次、设置和审计数据。
- `stage-kitchen` 可以读取最小上下文并提交一次完整日报。
- 服务器重新计算网管餐费和实际销售，忽略伪造派生值。
- 相同 `idempotencyKey` 重试返回同一结果。
- 不同 Key 对同一业务日和班次返回冲突。
- `KITCHEN` 访问历史、统计、设置、用户和正式附件失败。
- S3 不存在公开对象，跨用户 pending 路径访问失败。
- 空闲后观察到 Aurora `ServerlessV2Usage = 0`。
- 资源清理检查不遗留 NAT、闲置数据库、意外对象版本或未知费用资源。

## 17. 失败处理和回滚

- migration 失败：回滚当前事务，不手工修改生成 schema。
- schema 漂移：修正 SQL migration 后重新生成。
- Cognito 不支持 bcrypt Hash Import：保存证据并切换到已设计的有限期 Migration Lambda 回退，不强行导入。
- Aurora 无法暂停：检查 SQL Lambda、Function 和运维连接；未达到 0 ACU 不通过验收。
- Amplify 部署失败：只回滚 staging stack，不改变现有本地系统入口。
- 权限负向测试失败：停止验收，不以 UI 隐藏代替后端授权。
- 任一阶段都不能读取、覆盖或删除真实 SQLite 和 uploads。

阶段 B 没有生产流量，因此业务回滚就是停止或删除 staging 并继续使用现有本地系统，不建立双写或数据回灌链路。

## 18. 销毁流程

1. 确认 staging 不含真实数据。
2. 导出部署清单、CloudFormation 状态和测试结果。
3. 停止新的测试访问和异步任务。
4. 明确列出 S3 对象、版本和保留策略。
5. 关闭 Aurora 删除保护并创建命名 final snapshot。
6. 删除 backend stacks、数据库和临时网络资源。
7. 单独确认是否删除 final snapshot。
8. 再次检查 RDS、NAT、VPC Endpoint、S3 版本和 CloudWatch 日志费用。

任何清理脚本默认只执行 dry-run；实际删除必须再次明确确认。`keepOnDelete` 保留的 Bucket 和版本不能被普通 Amplify 删除动作静默移除。

## 19. 阶段 B 完成定义

只有同时满足以下条件，阶段 B 才算完成：

- 基础设施可以从版本控制中的代码部署到空 staging 环境。
- 不需要未记录的 Console 手工修改。
- 合成数据完成管理员读取、厨房可信提交、重复提交和越权拒绝验证。
- Aurora 确认私有且能够实际自动暂停。
- Storage 权限和清理边界通过验证。
- Cognito bcrypt Hash Import 能力得到明确的成功或失败证据。
- 成本、部署、验收和销毁证据完整。
- production 没有创建资源，真实本地数据没有被读取或迁移。

阶段 B 完成不等于 production 上线，也不等于现有 NestJS/SQLite 可以退役。

## 20. 后续阶段

- 阶段 C：业务读取、可信写入、统计、导出和附件流程迁移。
- 阶段 D：Vue/PWA 完整接入及 iPhone 16 Pro Max、iPhone 7 Plus iOS 15.8.4 真机验收。
- 阶段 E：真实 SQLite、用户和 uploads 的受控迁移演练。
- 阶段 F：production 成本审批、资源创建、最终切换、回滚窗口和 NestJS 退役。

每个阶段都必须单独建立实施计划和验收门槛，不能因为 staging 成功而自动扩大到 production。
