# FSK Amplify Gen 2 staging 成本审批门

## 当前状态

| 字段 | 值 |
| --- | --- |
| Gate | 首次 staging AWS 写入 |
| GateStatus | `FOUNDATION_DEPLOYED_VERIFIED` |
| ApprovalId | `FSK-FOUNDATION-20260823-221547-JST` |
| Approver | `reiken` |
| ApprovedAtJst | `2026-08-23 22:15:47 JST` |
| ExpiresAtJst | `2026-08-24 22:15:47 JST` |
| ApprovalScope | `Foundation only: remote tag/staging branch + Auth/Storage/VPC/Aurora/Data API` |
| AWS Account | `444083008754` |
| Region | `ap-northeast-1` |
| Git deployment point | `fsk-staging-data-api-foundation-v1` |
| MonthlyCeilingJpy | `5000` |

`MonthlyCeilingJpy=5000` 是用户修订的治理上限，不是 AWS 硬停止。Foundation 已按本页批准范围完成部署和只读验收：远程恢复标签/`staging` branch、Auth、Storage、VPC、Aurora/Data API。Migration 的首次批准和 retry 批准均已消费：首次在 TLS 握手失败，retry 在数据库命令前被 clean-worktree guard 拒绝；两次均无 DDL，持续计费临时资源均已清理。新的 source/operation tuple 和独立批准前不得再次执行。完整 backend、Hosting、Budget/alarms、Destroy 和真实数据迁移仍未批准，也未执行。

## 成本模型

金额必须在每次部署批准前使用部署当日的 AWS 官方定价或 AWS Pricing Calculator 及当日可审计汇率重新计算。免费额度不能作为成本上限，临时资源必须按实际存活时间计入。

| 字段 | 值 |
| --- | --- |
| PricingBaseline | `2026-08-23_DESIGN_ESTIMATE_ONLY` |
| LowUseMonthlyJpy | `约 ¥1,000` |
| OneAcuWorstMonthJpy | `约 ¥19,600` |
| OneAcuWorstMonthGateAction | `AUTO_INVALIDATE_STOP_REVIEW` |
| MonthlyCeilingJpy | `5000` |
| DeploymentDayLowUseMonthlyJpy | `约 ¥1,065` |
| DeploymentDayOneAcuWorstMonthJpy | `约 ¥19,552` |
| PricingCapturedAtJst | `2026-08-23 23:24:20 JST` |
| USDJPYRateAndSource | `158.697325; ECB reference rates dated 2026-08-21 (EUR/JPY 185.66 divided by EUR/USD 1.1699)` |
| CostOwner | `reiken` |
| CleanupOwner | `reiken` |

部署日重算使用 AWS 东京公开价格 `US$0.15/ACU-hour`、ECB 最近营业日参考汇率和日本消费税 10%。低使用模型按每月 24 ACU-hour 加 `US$2.50` 的其他服务保守额度，得到约 `¥1,065`；指定最坏月按 `1 ACU × 730h` 加同一额度，得到约 `¥19,552`。后者不是容量承诺，而且明确高于 `¥5,000` 治理上限；若出现该情景，必须自动使审批失效、停止新增写入并进入成本/清理复查。

## 月成本清单

| 成本项 | 阶段 | 计费驱动与边界 | 部署日价格证据 | 部署后实际复查 |
| --- | --- | --- | --- | --- |
| Aurora Serverless v2 活跃 ACU | Foundation | `0–1 ACU`；按活跃 ACU 秒计费；空闲必须实测回到 0 | `AWS Price List APN1 Aurora PostgreSQL ServerlessV2Usage: US$0.15/ACU-hour` | `DEPLOYED_VERIFIED: 0.0 ACU observed at 2026-08-24 05:47 UTC` |
| Aurora 数据库存储/I/O/自动备份 | Foundation | `fsk_staging` 合成数据；备份保留 14 天 | `AWS Price List APN1: US$0.12/GB-month; US$0.24/million I/O; US$0.023/backup GB-month over allocation` | `DEPLOYED: one encrypted Aurora cluster and one db.serverless writer; no data migration` |
| Aurora final snapshot | Destroy | 仅在单独批准的销毁流程创建；按 GB-month 持续计费 | `PENDING_RATE_LOOKUP` | `PENDING_DESTROY_GATE` |
| S3 Gateway VPC Endpoint | Foundation | 无固定小时费；仍计算 S3 请求和传输 | `PENDING_RATE_LOOKUP` | `DEPLOYED_VERIFIED: exactly one Gateway endpoint; no Interface endpoint` |
| Cognito | Foundation | 仅合成 staging 用户；按当期 MAU 规则复核 | `PENDING_RATE_LOOKUP` | `DEPLOYED: admin-created users only; no guest identities; no users seeded` |
| S3 对象、请求和版本 | Foundation/Hosting | pending、test、migration 使用短生命周期；正式对象及版本可能持续保留 | `PENDING_RATE_LOOKUP` | `DEPLOYED: private, versioned, retained; no uploads migrated` |
| Secrets Manager | Foundation/Full backend | Aurora generated Secret 的 secret-month 和 API 调用 | `PENDING_RATE_LOOKUP` | `DEPLOYED: generated Aurora Secret; migration worker read it only into process memory; value was not printed or recorded` |
| Amplify 平台 custom-resource Functions/Logs | Foundation | branch linker/provider 的部署调用、执行时间和日志 | `PENDING_RATE_LOOKUP` | `DEPLOYED_VERIFIED: exactly two platform linker/provider Functions` |
| CloudShell VPC 临时 NAT/IGW/EIP/运维 SG | Migration | 只在批准窗口内存在；从创建到稳定零残留计费 | `PENDING_RATE_LOOKUP` | `FAILED_CLEANED: SG/5432 ingress/IGW/subnet/route table/EIP absent; NAT deleted; application default routes absent` |
| RDS Data API calls | Full backend | 参数化语句、事务和返回数据量；不建立业务 TCP 连接池 | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| API Gateway HTTP API | Full backend | Kitchen/Admin API 请求和数据传输 | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| Kitchen/Admin/Export Functions | Full backend | 调用次数、执行时间、内存、日志和指标 | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| Amplify Hosting build | Hosting | 构建分钟、实例规格和产物 | `PENDING_RATE_LOOKUP` | `PENDING_HOSTING` |
| Amplify Hosting delivery/storage | Hosting | 托管存储、请求和出站流量 | `PENDING_RATE_LOOKUP` | `PENDING_HOSTING` |
| Budgets、Cost Anomaly Detection、alarms | Budget/alarms | 预算、通知、指标和日志；单独写入批准 | `PENDING_RATE_LOOKUP` | `PENDING_BUDGET_GATE` |

持续网络固定为：无 NAT Gateway、无 Interface Endpoint、无数据库 `5432` ingress。Migration 可在审批窗口内创建带 operation token 的临时 NAT/IGW/EIP 和临时运维 SG；临时状态参数只能经该临时出口访问，并在稳定零残留确认前删除。任何长期网络资源都会使批准立即失效。

## Foundation 部署执行证据

| 字段 | 值 |
| --- | --- |
| DeploymentStatus | `FOUNDATION_DEPLOYED_VERIFIED` |
| DeployedAtUtc | `2026-08-24 05:44:30 UTC` |
| AWS Account | `444083008754` |
| Region | `ap-northeast-1` |
| AmplifyAppId | `d2ztmb4nlq3clr` |
| AmplifyBranch | `staging` |
| DeployedCommit | `dcff57ebc9bc6d77fbb51072b996834f5a5ca715` |
| DeployedTag | `fsk-staging-data-api-foundation-v1` |
| FoundationStackStatus | `FskStagingFoundation / CREATE_COMPLETE` |
| AmplifyStackStatus | `amplify-d2ztmb4nlq3clr-staging-branch-08a82c5fa9 / CREATE_COMPLETE` |
| AutoBuild | `false` |
| InitialHostingJobStatus | `1 / CANCELLED / commit HEAD` |
| AuroraEngineVersion | `aurora-postgresql 18.4` |
| AuroraAcuRange | `0–1 ACU` |
| AuroraAutoPauseSeconds | `300` |
| AuroraIdleObservedAcu | `0.0 at 2026-08-24 05:47:00 UTC` |
| PersistentNatGateways | `0` |
| PersistentInternetGateways | `0` |
| PersistentInterfaceEndpoints | `0` |
| DatabaseIngressRuleCount | `0` |
| HostingStatus | `NOT_DEPLOYED` |
| MigrationStatus | `TWO_FAILED_OPERATIONS / DDL_ABSENT / COST_RESOURCES_ZERO / SSM_FAILURE_EVIDENCE_RETAINED` |
| FullBackendStatus | `NOT_DEPLOYED` |

权威部署来自 target-account CloudShell 的 detached approved commit。首次 Amplify bootstrap job 的 commit 只显示 `HEAD`，因此在发布 Hosting 前已取消；随后关闭 Auto build，并用 `ampx pipeline-deploy` 完成 Foundation reconciliation。两个 CloudFormation 栈均为 `CREATE_COMPLETE`。

只读运行态验收确认：Data API 和 deletion protection 开启；Writer 为私有、加密的 `db.serverless`，无 RDS Proxy；VPC 没有 NAT、IGW、默认公网路由或公网子网，只有一个 S3 Gateway Endpoint，数据库安全组无入站规则。CloudWatch `ServerlessDatabaseCapacity` 在 `05:47 UTC` 为 `0.0`，RDS 事件在 `05:46:48 UTC` 记录 Writer 成功暂停。Migration 第一次连接因缺少 Amazon RDS CA 信任而在 TLS 握手阶段失败；Data API 只读复查确认 `schema_migrations` 不存在，临时持续计费资源已归零，三个 Standard SSM 参数保留失败证据。该次批准已经消费；下方独立 retry 批准只授权新的 operation tuple。

Storage 为私有、SSE-S3、versioned、`Retain`，三个临时前缀均为 7 天生命周期；Cognito 只允许管理员创建用户、禁止 guest，只有 `ADMIN`/`KITCHEN` 两组且未 seed 用户。主栈只有两个 Amplify Branch Linker 平台 Functions，没有业务 Function、HTTP API 或 Hosting 发布。Migration worker 只在进程内读取 Secret 并构造连接串；证据没有打印或记录 Secret 值、连接串、用户名、密码、真实用户或账务 payload。

## 六个独立写入阶段

后一阶段的批准不能追溯授权前一阶段，也不能替代销毁批准。

| 写入阶段 | 资源范围 | ApprovalId |
| --- | --- | --- |
| Foundation | Auth + Storage + VPC + Aurora/Data API | `FSK-FOUNDATION-20260823-221547-JST` |
| Migration | CloudShell VPC + 临时 NAT/IGW/EIP + 临时运维 SG | `FSK-MIGRATION-20260824-161030-JST` |
| Full backend | HTTP API + Kitchen/Admin/Export Functions | `PENDING_USER_APPROVAL` |
| Hosting | Vue/PWA | `PENDING_USER_APPROVAL` |
| Budget/alarms | Budget、费用异常检测、指标和告警 | `PENDING_USER_APPROVAL` |
| Destroy | App/branch/stacks/保留资源/远程 ref 的逐项销毁 | `PENDING_USER_APPROVAL` |

## 首次 Migration 批准与失败证据

| 字段 | 值 |
| --- | --- |
| MigrationUserApprovalStatement | `批准在已部署的 FSK staging Foundation 上创建带 operation token 的临时 CloudShell VPC 出口和运维 5432 访问，执行合成数据库 migration/verify 后立即清理；不导入真实 SQLite、用户、bcrypt hash 或 uploads。` |
| MigrationApprovalMessageOrTaskId | `Codex task user message at 2026-08-24 14:58:58 JST` |
| MigrationApprovalId | `FSK-MIGRATION-20260824-145858-JST` |
| MigrationApprovedStage | `Migration` |
| MigrationApprovedAtJst | `2026-08-24 14:58:58 JST` |
| MigrationExpiresAtJst | `2026-08-24 17:43:58 JST` |
| MigrationApprovedCommit | `dcff57ebc9bc6d77fbb51072b996834f5a5ca715` |
| MigrationApprovedTag | `fsk-staging-data-api-foundation-v1` |
| MigrationTaskId | `migration-20260824` |
| MigrationOperationToken | `c4c4eb7f-5665-4039-975f-554f36a8fae0` |
| MigrationOperationDeadlineEpoch | `1787558338 / 2026-08-24 16:58:58 JST` |
| MigrationCleanupDeadlineEpoch | `1787561038 / 2026-08-24 17:43:58 JST` |
| MigrationTemporaryPublicCidr/Az | `10.42.4.0/24 / ap-northeast-1a` |
| MigrationApplicationRouteTableIds | `rtb-0bbea56ee741ffe5f / rtb-0b08168b07de52b49` |
| MigrationCostOwner | `reiken` |
| MigrationCleanupOwner | `reiken` |

本次批准不改变 `MonthlyCeilingJpy=5000`，也不授权真实数据、Full backend 或 Hosting。任何 tuple、CIDR/AZ、两个应用路由表、截止时间或 owner 不一致时立即停止；临时资源必须在 cleanup deadline 前清理并取得稳定零残留证据。

## Migration retry 批准证据

| 字段 | 值 |
| --- | --- |
| MigrationRetryGateStatus | `FAILED_BEFORE_DATABASE_CLEANUP_BLOCKED` |
| MigrationRetryUserApprovalStatement | `批准复审 705c6d7；通过后发布新的 immutable migration source，生成全新的 operation token 与截止时间，再执行一次合成 DDL/verify 和完整清理；不导入真实数据，也不启动 Full backend 或 Hosting。` |
| MigrationRetryApprovalMessageOrTaskId | `Current Codex task user message: 批准` |
| MigrationRetryApprovalId | `FSK-MIGRATION-20260824-161030-JST` |
| MigrationRetryApprovedAtJst | `2026-08-24 16:10:30 JST` |
| MigrationRetryExpiresAtJst | `2026-08-24 18:55:30 JST` |
| MigrationRetryMonthlyCeilingJpy | `5000` |
| MigrationRetryExcludedStagesAndData | `real SQLite/users/bcrypt/uploads / Full backend / Hosting` |
| MigrationRetrySourceCommit | `39e6ebae97d17ff803c4d6f3406328ddcb8594ac` |
| MigrationRetrySourceTag | `fsk-staging-data-api-migration-v2` |
| MigrationRetryDeployedFoundation | `dcff57ebc9bc6d77fbb51072b996834f5a5ca715 / fsk-staging-data-api-foundation-v1` |
| MigrationRetryTaskId | `migration-20260824-v2` |
| MigrationRetryOperationToken | `eed3cfbc-bacd-4827-be79-f8828ba5226e` |
| MigrationRetryOperationDeadlineEpoch | `1787562630 / 2026-08-24 18:10:30 JST` |
| MigrationRetryCleanupDeadlineEpoch | `1787565330 / 2026-08-24 18:55:30 JST` |
| MigrationRetryTemporaryPublicCidr/Az | `10.42.4.0/24 / ap-northeast-1a` |
| MigrationRetryApplicationRouteTableIds | `rtb-0bbea56ee741ffe5f / rtb-0b08168b07de52b49` |
| MigrationRetryCostOwner | `reiken` |
| MigrationRetryCleanupOwner | `reiken` |
| MigrationRetrySourcePublication | `REMOTE_CAS_PUBLISHED / origin/staging + peeled fsk-staging-data-api-migration-v2 = 39e6ebae97d17ff803c4d6f3406328ddcb8594ac` |
| MigrationRetryPreflight | `account 444083008754 / ap-northeast-1 / fsk-staging AutoBuild=false / Foundation CREATE_COMPLETE / Aurora available private rds-ca-rsa2048-g1 / application default routes=0 / database ingress=0 / prior paid temporary resources=0 / prior SSM failure evidence=3` |
| MigrationRetryControlResult | `FAILED:WORKER_EXIT_1 / CLEANUP_BLOCKED:EXIT_1` |
| MigrationRetryFirstMigrationResult | `NOT_RUN / clean-worktree guard rejected operator wrapper inside checkout` |
| MigrationRetrySecondMigrationResult | `NOT_RUN_AFTER_WORKTREE_GUARD` |
| MigrationRetryVerifyResult | `NOT_RUN_AFTER_WORKTREE_GUARD` |
| MigrationRetryDatabaseDdlState | `Data API: fsk_staging reachable / public.schema_migrations ABSENT` |
| MigrationRetryWorkerEnvironment | `fsk-migrate-20260824-v2 / deleted` |
| MigrationRetryTemporaryResourceIds | `sg-0c4b75a81c9b440df / sgr-0f42f41388fd43914 / igw-06b56ccca81b7ce7b / subnet-0ed7c34777742e606 / rtb-060f5b84a692bf069 / eipalloc-07d3374520cc8f083 / nat-05ebafdcf4c228b88` |
| MigrationRetryStableZeroEvidence | `control process exit 1 after >=180 seconds stable zero; NAT=deleted; SG/subnet/route table/IGW/EIP/ENI/DB ingress absent; both application default routes=0` |
| MigrationRetryFinalResidualCount | `COST_RESOURCES=0 / APP_DEFAULT_ROUTES=0 / DB_INGRESS=0 / SSM_FAILURE_EVIDENCE=3` |
| MigrationRetryFailureRootCause | `operator generated .fsk-worker-v2.sh inside the detached source checkout; the intended git status --short guard failed before pnpm, Secret read, database URL construction, or migration` |
| MigrationRetryNextApproval | `NEW_MIGRATION_OPERATION_REQUIRED` |

本次 retry 已消费：immutable source 通过 CAS 发布，但 worker launcher 被误写入 detached checkout，clean-worktree guard 在 `pnpm install`、Secret 读取、数据库 URL 构造和 migration 之前安全停止。control 清理初期因 CloudShell ENI 尚占用临时 SG 记录 sticky failure latch，worker environment 删除并传播后所有计费资源和临时访问均归零；三个 Standard SSM 参数保留非敏感失败证据。不得复用该 token，也不得启动 Full backend、Hosting、Budget/alarms 或销毁阶段。

## 固定批准边界

- account `444083008754`、region `ap-northeast-1`、独立 `fsk-staging` App 和 `staging` branch；Auto build 默认关闭。
- Foundation 只含 Auth、Storage、VPC、Aurora/Data API；Aurora `MinCapacity=0`、`MaxCapacity=1`、私有、无 RDS Proxy。
- Full backend 只含 HTTP API 和 Kitchen/Admin/Export Functions；Functions 不进入 VPC，使用最小 Data API、目标 Secret 和精确 S3 IAM。
- 数据只允许合成 `ADMIN`/`KITCHEN`、固定四班和合成日报；禁止导入 `dev.db`、备份 ZIP、真实 bcrypt hash、`uploads/` 或 production 数据。
- 每阶段必须固定 exact commit、批准编号、截止时间、CostOwner 和 CleanupOwner；证据中不得出现 Secret、连接串、token 或完整账务 payload。

## 自动失效条件

出现任一情况，审批立即失效并回到 `NOT_APPROVED`：

- account、region、App/branch、批准 commit/tag 或资源集合变化；
- Aurora 上限高于 1 ACU，或增加 RDS Proxy、长期 NAT、Interface Endpoint、数据库业务 ingress 或 Connector 家族资源；
- 部署日重算、实际成本或预测成本超过 `5000`；
- 到达 `ExpiresAtJst`，或 CostOwner/CleanupOwner 不可用；
- 发现真实用户、SQLite、bcrypt hash、uploads、Secret 或敏感日志进入 staging；
- Aurora 版本在部署前只读复核不再支持 `ap-northeast-1` 的 Serverless v2 0 ACU；
- 权限负向验证、失败恢复、清理或稳定零残留证据失败。

## 批准证据（获得明确批准后填写）

| 字段 | 值 |
| --- | --- |
| UserApprovalStatement | `批准将 fsk-staging-data-api-foundation-v1 推送到远程，并在 AWS 账号 444083008754、ap-northeast-1 创建独立 FSK staging Foundation；月治理上限 ¥5,000，不包含完整 backend、Hosting、Budget/alarms、销毁或真实数据迁移。` |
| ApprovalMessageOrTaskId | `Codex task user message at 2026-08-23 22:15:47 JST` |
| ApprovalId | `FSK-FOUNDATION-20260823-221547-JST` |
| ApprovedStage | `Foundation` |
| MonthlyCeilingJpy | `5000` |
| Approver | `reiken` |
| ApprovedAtJst | `2026-08-23 22:15:47 JST` |
| ExpiresAtJst | `2026-08-24 22:15:47 JST` |
| ApprovedCommit | `dcff57ebc9bc6d77fbb51072b996834f5a5ca715` |
| ApprovedTag | `fsk-staging-data-api-foundation-v1` |
| CostOwner | `reiken` |
| CleanupOwner | `reiken` |

本轮仅可在有效期内从 exact commit/tag 执行 Foundation runbook。任何与上述账号、区域、提交、标签、资源集合或价格边界不一致的情况都必须停止；其余五个写入阶段继续保持 `PENDING_USER_APPROVAL`。
