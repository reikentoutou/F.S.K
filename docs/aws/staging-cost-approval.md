# FSK Amplify Gen 2 staging 成本审批门

## 当前状态

| 字段 | 值 |
| --- | --- |
| Gate | 首次 staging AWS 写入 |
| GateStatus | `NOT_APPROVED` |
| ApprovalId | `PENDING_USER_APPROVAL` |
| MonthlyCeilingJpy | `PENDING_USER_APPROVAL` |
| Approver | `PENDING_USER_APPROVAL` |
| ApprovedAtJst | `PENDING_USER_APPROVAL` |
| ExpiresAtJst | `PENDING_USER_APPROVAL` |
| AWS Account | `444083008754` |
| Region | `ap-northeast-1` |
| Git deployment point | `fsk-staging-foundation-v1` |
| ApprovalScope | `PENDING_USER_APPROVAL` |

只要任一审批字段仍是 `PENDING_USER_APPROVAL`，就不得创建 Amplify App、branch、CloudFormation stack、Budget、告警或其他 AWS 资源。当前文档不是批准记录，也不表示已经发生 AWS 写入。

## 首次部署资源和月成本清单

金额必须在 Task 7 执行前使用部署当日的 AWS 官方定价或 AWS Pricing Calculator 重新计算，并在下表填写“预计月成本 JPY”和“定价证据”。不得把免费额度当作成本上限，也不得用未验证汇率填写日元金额。

| 成本项 | 首次 foundation | 计费驱动与上限假设 | 预计月成本 JPY | 定价证据 | 部署后实际复查 |
| --- | --- | --- | --- | --- | --- |
| Aurora Serverless v2 活跃 ACU | 是 | `0–2 ACU`；按实际活跃 ACU 秒计费；空闲必须实际回到 0 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Aurora 数据库存储 | 是 | `fsk_staging` 合成数据的 GB-month 和 I/O | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Aurora 自动备份 | 是 | 14 天保留；超出免费备份额度的 GB-month | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Aurora final snapshot | 销毁时 | 仅在另行批准的销毁流程创建；按 GB-month 持续计费 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DESTROY_GATE` |
| SSM Interface VPC Endpoint | 是 | 两个 application 私有子网的 endpoint ENI 固定小时费，加数据处理费；即使 Aurora 为 0 ACU 仍持续计费 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| S3 Gateway VPC Endpoint | 是 | Gateway Endpoint 本身无固定小时费；仍计算 S3 请求/传输费用 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Amplify Hosting build | 后续 Hosting | 构建分钟、构建实例规格和构建产物 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_HOSTING` |
| Amplify Hosting delivery/storage | 后续 Hosting | 托管 GB-month、出站流量和请求 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_HOSTING` |
| Lambda / Amplify Functions | 后续 full backend | 调用次数、执行时间和内存；foundation 不创建业务 Functions | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| AppSync / Amplify Data | 后续 full backend | Query/Mutation 次数及实时连接；foundation 不创建 AppSync/Amplify Data API | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_FULL_BACKEND` |
| CloudWatch Logs/Metrics/Alarms | 分阶段 | 日志写入/保留、指标和 alarms；Task 17 有独立写入审批门 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_OBSERVABILITY_GATE` |
| S3 对象、请求和版本 | 是 | pending/test/migration 7 天生命周期；正式对象和非当前版本可能持续保留 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Cognito | 是 | 仅两个合成 stage 用户和 disposable probe 用户；按当期 MAU 规则复核 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| Secrets Manager | 是 | Aurora generated credentials Secret 的 secret-month 和 API 调用 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_DEPLOYMENT` |
| CloudShell VPC 临时出口 | 临时 | CloudShell VPC 环境本身及数据传输；若下载依赖需要临时 NAT/受控出口，固定小时费和流量费从创建到确认删除计入 | `PENDING_RATE_LOOKUP` | `PENDING_RATE_LOOKUP` | `PENDING_CLOUDSHELL` |

### 预算计算记录

| 字段 | 值 |
| --- | --- |
| PricingCapturedAtJst | `PENDING_RATE_LOOKUP` |
| USDJPYRateAndSource | `PENDING_RATE_LOOKUP` |
| EstimatedFoundationMonthlyJpy | `PENDING_RATE_LOOKUP` |
| EstimatedFullStageMonthlyJpy | `PENDING_RATE_LOOKUP` |
| MonthlyCeilingJpy | `PENDING_USER_APPROVAL` |
| CostOwner | `PENDING_USER_APPROVAL` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

月上限必须覆盖持续运行资源、临时资源、保留的 S3 版本和 snapshot。部署后如果预测或实际月成本超过 `MonthlyCeilingJpy`，立即停止新增写入并进入费用/清理复查；不能通过口头豁免继续。

## 审批范围

首次批准只能覆盖以下边界：

- AWS account `444083008754`、region `ap-northeast-1`。
- 独立 `fsk-staging` Amplify Gen 2 App 和 `staging` branch，Auto build 关闭，不连接 `main`、production 或 PR preview。
- tag `fsk-staging-foundation-v1` 的 foundation-only 组合：Auth、Storage、VPC、Aurora、Data API；不包含 Amplify Data/AppSync 或业务 Functions。
- Aurora `0–2 ACU`、私有访问、无 RDS Proxy、无长期 NAT Gateway。
- 仅 `ADMIN`、`KITCHEN`，仅合成账号和数据；不读取或导入 `dev.db`、备份 ZIP、真实 bcrypt 哈希或 `uploads/`。
- Storage bucket 使用 branch/pipeline 部署验证 `keepOnDelete`；禁止用 sandbox 代替该验证。

以下动作不包含在首次批准中：完整 backend 部署、Hosting build、Budget/Cost Anomaly Detection/alarms 写入、销毁、final snapshot 删除、production 资源或真实数据迁移。它们分别需要后续明确批准。

## 自动失效条件

出现任一情况，批准立即失效并回到 `NOT_APPROVED`：

- account、region、App/branch、部署 tag 或 foundation 资源集合变化；
- 增加 production、RDS Proxy、长期 NAT、额外 Interface Endpoint、Data/AppSync 或业务 Function；
- 预计或实际月成本超过批准的 `MonthlyCeilingJpy`；
- 到达 `ExpiresAtJst`，或批准人、清理责任人不可用；
- 发现真实用户、SQLite、bcrypt hash、uploads 或敏感部署日志进入 staging；
- Aurora `18.4` 在部署前只读复核不再支持 `ap-northeast-1` 的 Serverless v2 0 ACU / `db.serverless`；
- 安全、权限或清理负向验证失败。

## 批准证据（获得明确批准后填写）

| 字段 | 值 |
| --- | --- |
| UserApprovalStatement | `PENDING_USER_APPROVAL` |
| ApprovalMessageOrTaskId | `PENDING_USER_APPROVAL` |
| ApprovalId | `PENDING_USER_APPROVAL` |
| MonthlyCeilingJpy | `PENDING_USER_APPROVAL` |
| Approver | `PENDING_USER_APPROVAL` |
| ApprovedAtJst | `PENDING_USER_APPROVAL` |
| ExpiresAtJst | `PENDING_USER_APPROVAL` |
| ApprovedCommit | `PENDING_USER_APPROVAL` |
| ApprovedTag | `fsk-staging-foundation-v1` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

只有用户明确写出“批准首次 staging AWS 写入及该月上限”并且上述字段完整后，Task 7 才能开始。AWS Budget 与 Cost Anomaly Detection 仍属于 Task 17 的独立审批门。
