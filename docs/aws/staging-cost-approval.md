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

`MonthlyCeilingJpy=5000` 是用户修订的治理上限，不是 AWS 硬停止。Foundation 已按本页批准范围完成部署和只读验收：远程恢复标签/`staging` branch、Auth、Storage、VPC、Aurora/Data API。完整 backend、Hosting、Budget/alarms、Destroy、Migration 和真实数据迁移仍未批准，也未执行。

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
| Secrets Manager | Foundation/Full backend | Aurora generated Secret 的 secret-month 和 API 调用 | `PENDING_RATE_LOOKUP` | `DEPLOYED: generated Aurora Secret; value not read or recorded` |
| Amplify 平台 custom-resource Functions/Logs | Foundation | branch linker/provider 的部署调用、执行时间和日志 | `PENDING_RATE_LOOKUP` | `DEPLOYED_VERIFIED: exactly two platform linker/provider Functions` |
| CloudShell VPC 临时 NAT/IGW/EIP/运维 SG | Migration | 只在批准窗口内存在；从创建到稳定零残留计费 | `PENDING_RATE_LOOKUP` | `PENDING_MIGRATION` |
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
| MigrationStatus | `NOT_RUN` |
| FullBackendStatus | `NOT_DEPLOYED` |

权威部署来自 target-account CloudShell 的 detached approved commit。首次 Amplify bootstrap job 的 commit 只显示 `HEAD`，因此在发布 Hosting 前已取消；随后关闭 Auto build，并用 `ampx pipeline-deploy` 完成 Foundation reconciliation。两个 CloudFormation 栈均为 `CREATE_COMPLETE`。

只读运行态验收确认：Data API 和 deletion protection 开启；Writer 为私有、加密的 `db.serverless`，无 RDS Proxy；VPC 没有 NAT、IGW、默认公网路由或公网子网，只有一个 S3 Gateway Endpoint，数据库安全组无入站规则。CloudWatch `ServerlessDatabaseCapacity` 在 `05:47 UTC` 为 `0.0`，RDS 事件在 `05:46:48 UTC` 记录 Writer 成功暂停。

Storage 为私有、SSE-S3、versioned、`Retain`，三个临时前缀均为 7 天生命周期；Cognito 只允许管理员创建用户、禁止 guest，只有 `ADMIN`/`KITCHEN` 两组且未 seed 用户。主栈只有两个 Amplify Branch Linker 平台 Functions，没有业务 Function、HTTP API 或 Hosting 发布。证据未读取或记录 Secret 值、连接串、token、真实用户或账务 payload。

## 六个独立写入阶段

后一阶段的批准不能追溯授权前一阶段，也不能替代销毁批准。

| 写入阶段 | 资源范围 | ApprovalId |
| --- | --- | --- |
| Foundation | Auth + Storage + VPC + Aurora/Data API | `FSK-FOUNDATION-20260823-221547-JST` |
| Migration | CloudShell VPC + 临时 NAT/IGW/EIP + 临时运维 SG | `PENDING_USER_APPROVAL` |
| Full backend | HTTP API + Kitchen/Admin/Export Functions | `PENDING_USER_APPROVAL` |
| Hosting | Vue/PWA | `PENDING_USER_APPROVAL` |
| Budget/alarms | Budget、费用异常检测、指标和告警 | `PENDING_USER_APPROVAL` |
| Destroy | App/branch/stacks/保留资源/远程 ref 的逐项销毁 | `PENDING_USER_APPROVAL` |

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
