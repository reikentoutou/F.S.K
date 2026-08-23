# FSK Amplify Gen 2 staging 成本审批门

## 当前状态

| 字段 | 值 |
| --- | --- |
| Gate | 首次 staging AWS 写入 |
| GateStatus | `NOT_APPROVED` |
| ApprovalId | `PENDING_USER_APPROVAL` |
| Approver | `PENDING_USER_APPROVAL` |
| ApprovedAtJst | `PENDING_USER_APPROVAL` |
| ExpiresAtJst | `PENDING_USER_APPROVAL` |
| ApprovalScope | `PENDING_USER_APPROVAL` |
| AWS Account | `444083008754` |
| Region | `ap-northeast-1` |
| Git deployment point | `fsk-staging-data-api-foundation-v1` |
| MonthlyCeilingJpy | `25000` |

`MonthlyCeilingJpy=25000` 是待批准的治理上限，不是 AWS 硬停止，也不代表审批已经完成。只要 `GateStatus` 仍为 `NOT_APPROVED`，或任一审批字段仍为 `PENDING_USER_APPROVAL`，就不得创建 Amplify App、branch、CloudFormation stack、Budget、告警或其他 AWS 资源。本文不是批准记录，也不表示已经发生 AWS 写入。

## 成本模型

金额必须在每次部署批准前使用部署当日的 AWS 官方定价或 AWS Pricing Calculator 及当日可审计汇率重新计算。免费额度不能作为成本上限，临时资源必须按实际存活时间计入。

| 字段 | 值 |
| --- | --- |
| PricingBaseline | `2026-08-23_DESIGN_ESTIMATE_ONLY` |
| LowUseMonthlyJpy | `约 ¥1,000` |
| OneAcuWorstMonthJpy | `约 ¥19,600` |
| MonthlyCeilingJpy | `25000` |
| PricingCapturedAtJst | `PENDING_DEPLOYMENT_DAY_RECALCULATION` |
| USDJPYRateAndSource | `PENDING_DEPLOYMENT_DAY_RECALCULATION` |
| CostOwner | `PENDING_USER_APPROVAL` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

低使用估算假设 Aurora 大部分时间自动暂停；指定最坏月假设 `1 ACU × 730h`，再加其他低使用项目。约 `¥19,600` 不是容量承诺，`¥25,000` 只是为该指定情景保留余量。部署日重算若超过上限，审批自动失效并保持 `NOT_APPROVED`。

## 月成本清单

| 成本项 | 阶段 | 计费驱动与边界 | 部署日价格证据 | 部署后实际复查 |
| --- | --- | --- | --- | --- |
| Aurora Serverless v2 活跃 ACU | Foundation | `0–1 ACU`；按活跃 ACU 秒计费；空闲必须实测回到 0 | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Aurora 数据库存储/I/O/自动备份 | Foundation | `fsk_staging` 合成数据；备份保留 14 天 | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Aurora final snapshot | Destroy | 仅在单独批准的销毁流程创建；按 GB-month 持续计费 | `PENDING_RATE_LOOKUP` | `PENDING_DESTROY_GATE` |
| S3 Gateway VPC Endpoint | Foundation | 无固定小时费；仍计算 S3 请求和传输 | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Cognito | Foundation | 仅合成 staging 用户；按当期 MAU 规则复核 | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| S3 对象、请求和版本 | Foundation/Hosting | pending、test、migration 使用短生命周期；正式对象及版本可能持续保留 | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Secrets Manager | Foundation/Full backend | Aurora generated Secret 的 secret-month 和 API 调用 | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Amplify 平台 custom-resource Functions/Logs | Foundation | branch linker/provider 的部署调用、执行时间和日志 | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| CloudShell VPC 临时 NAT/IGW/EIP/运维 SG | Migration | 只在批准窗口内存在；从创建到稳定零残留计费 | `PENDING_RATE_LOOKUP` | `PENDING_MIGRATION` |
| RDS Data API calls | Full backend | 参数化语句、事务和返回数据量；不建立业务 TCP 连接池 | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| API Gateway HTTP API | Full backend | Kitchen/Admin API 请求和数据传输 | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| Kitchen/Admin/Export Functions | Full backend | 调用次数、执行时间、内存、日志和指标 | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| Amplify Hosting build | Hosting | 构建分钟、实例规格和产物 | `PENDING_RATE_LOOKUP` | `PENDING_HOSTING` |
| Amplify Hosting delivery/storage | Hosting | 托管存储、请求和出站流量 | `PENDING_RATE_LOOKUP` | `PENDING_HOSTING` |
| Budgets、Cost Anomaly Detection、alarms | Budget/alarms | 预算、通知、指标和日志；单独写入批准 | `PENDING_RATE_LOOKUP` | `PENDING_BUDGET_GATE` |

持续网络固定为：无 NAT Gateway、无 Interface Endpoint、无数据库 `5432` ingress。Migration 可在审批窗口内创建带 operation token 的临时 NAT/IGW/EIP 和临时运维 SG；临时状态参数只能经该临时出口访问，并在稳定零残留确认前删除。任何长期网络资源都会使批准立即失效。

## 六个独立写入阶段

后一阶段的批准不能追溯授权前一阶段，也不能替代销毁批准。

| 写入阶段 | 资源范围 | ApprovalId |
| --- | --- | --- |
| Foundation | Auth + Storage + VPC + Aurora/Data API | `PENDING_USER_APPROVAL` |
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
- 部署日重算、实际成本或预测成本超过 `25000`；
- 到达 `ExpiresAtJst`，或 CostOwner/CleanupOwner 不可用；
- 发现真实用户、SQLite、bcrypt hash、uploads、Secret 或敏感日志进入 staging；
- Aurora 版本在部署前只读复核不再支持 `ap-northeast-1` 的 Serverless v2 0 ACU；
- 权限负向验证、失败恢复、清理或稳定零残留证据失败。

## 批准证据（获得明确批准后填写）

| 字段 | 值 |
| --- | --- |
| UserApprovalStatement | `PENDING_USER_APPROVAL` |
| ApprovalMessageOrTaskId | `PENDING_USER_APPROVAL` |
| ApprovalId | `PENDING_USER_APPROVAL` |
| ApprovedStage | `PENDING_USER_APPROVAL` |
| MonthlyCeilingJpy | `25000` |
| Approver | `PENDING_USER_APPROVAL` |
| ApprovedAtJst | `PENDING_USER_APPROVAL` |
| ExpiresAtJst | `PENDING_USER_APPROVAL` |
| ApprovedCommit | `PENDING_USER_APPROVAL` |
| ApprovedTag | `fsk-staging-data-api-foundation-v1` |
| CostOwner | `PENDING_USER_APPROVAL` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

只有用户明确写出所批准的单一写入阶段、`MonthlyCeilingJpy=25000`、exact commit/tag 和有效期，并补齐上述字段后，才可进入对应 runbook。当前 `GateStatus=NOT_APPROVED`，没有任何 AWS、远程 Git、Hosting、预算或销毁写入获得授权。
