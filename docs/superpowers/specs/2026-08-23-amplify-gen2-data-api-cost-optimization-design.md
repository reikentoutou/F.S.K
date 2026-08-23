# FSK Amplify Gen 2 Data API 成本优化设计书

## 1. 目的与状态

本文定义 FSK staging 的成本优化修订：保留 Amplify Hosting、Cognito、Storage、Functions 和私有 Aurora PostgreSQL，取消 Amplify Data SQL Connector，改由 API Gateway + Amplify Functions 通过 RDS Data API 访问 PostgreSQL。

用户已在 2026-08-23 确认该方向。本文只固化设计，不代表已经创建或修改 AWS 资源；首次远程 Git 写入和 AWS 写入仍受独立成本审批门约束。

本设计在下列范围内取代：

- `2026-08-23-fsk-amplify-gen2-migration-design.md` 中 Amplify Data/AppSync 作为 PostgreSQL API 层的决定；
- `2026-08-23-amplify-gen2-staging-infrastructure-design.md` 中 `0–2 ACU`、Amplify SQL Lambda、SQL schema 生成和长期 SSM Interface Endpoint 的决定；
- `2026-08-23-amplify-gen2-staging-infrastructure.md` 实施计划中尚未执行的 Task 7–18，以及已经本地完成但尚未部署的 foundation 对应配置。

现有 NestJS、SQLite 和 JWT 继续作为本地/回滚运行层，直到后续生产迁移另行批准。

## 2. 已确认决策

| 决策项 | 修订结论 |
| --- | --- |
| Web Hosting | Amplify Hosting，staging 分支，Vue/PWA |
| 身份认证 | Cognito User Pool；仅 `ADMIN`、`KITCHEN` |
| API 层 | API Gateway HTTP API + Cognito JWT Authorizer |
| 业务运行层 | Amplify Functions；厨房与管理员接口分离 |
| 数据库 | 私有 Aurora PostgreSQL Serverless v2，`0–1 ACU`，允许自动暂停 |
| 数据访问 | Functions 使用 RDS Data API；不建立数据库 TCP 连接池 |
| PostgreSQL DDL | 版本化 SQL migration 仍为唯一权威来源 |
| Amplify Data/AppSync | 不创建 |
| Amplify SQL Lambda/Updater Lambda | 不创建 |
| `schema.sql.ts` | 不生成、不维护 |
| 长期 SSM Interface Endpoint | 不创建 |
| 长期 NAT Gateway | 不创建 |
| Storage | Amplify Storage/S3；保留私有、版本和路径边界 |
| 首次低使用月成本 | 约 `¥1,000`，以部署日官方价格重新计算 |
| 建议月上限 | `¥5,000`；属于治理上限，不是 AWS 硬限额 |

## 3. 为什么修改

AWS Amplify 的 PostgreSQL 原生连接会创建 AppSync、SQL Lambda 和 Updater Lambda。数据库位于 VPC 时，SQL Lambda 还必须通过 HTTPS 访问 Systems Manager 读取连接参数。在无长期 NAT 的设计中，这意味着持续付费的 Interface Endpoint。

FSK 每天约两次结账，厨房只提交当前班次，不能查看历史；管理员读取、统计、修正和导出又都需要服务器业务逻辑。通用 SQL 模型 CRUD 层没有足够收益来抵消固定网络成本和额外运行层，因此改为更小的服务端 API。

## 4. 目标拓扑

```text
Vue / PWA
  ├─ Cognito User Pool
  │    ├─ ADMIN
  │    └─ KITCHEN
  ├─ API Gateway HTTP API
  │    ├─ /kitchen/* → Kitchen Function
  │    └─ /admin/*   → Admin Function / Export Function
  └─ Amplify Storage / S3
       ├─ pending/{subject}/...
       └─ Function 管理的正式附件与导出

Amplify Functions（不进入 VPC）
  └─ AWS SDK RDS Data API
       └─ 私有 Aurora PostgreSQL 0–1 ACU
```

数据库保持 `PubliclyAccessible=false`。Data API 通过 Aurora 的服务端 HTTPS API 执行 SQL，Function 不需要进入数据库 VPC，也不需要到 PostgreSQL `5432` 的网络入口。

## 5. API 边界

### 5.1 Kitchen API

最小路由：

- `GET /kitchen/context`：返回当前填报所需的建议时间、固定班次、负责人、底钱和是否已提交；不返回历史日报内容或销售列表。
- `POST /kitchen/daily-reports`：提交日报，服务器重算派生金额并执行幂等事务。
- `POST /kitchen/attachments/presign`：只为调用者自己的 `pending/{subject}/` 路径签发最小上传权限。

`KITCHEN` 对 `/admin/*`、历史日报、统计、设置和正式附件读取必须得到 `403`。

### 5.2 Admin API

最小路由：

- `GET /admin/daily-reports`
- `GET /admin/daily-reports/{reportId}`
- `POST /admin/daily-reports/{reportId}/corrections`
- `GET /admin/analytics`
- `POST /admin/exports`
- `GET /admin/attachments/{attachmentId}/download`
- `GET /admin/health`

管理员写操作必须保存 revision before/after 快照、调用者 subject、请求 ID 和 JST 时间。

### 5.3 认证与授权

- API Gateway JWT Authorizer 验证 Cognito issuer、audience 和 token expiry。
- Function 从可信 claims 读取 subject 和 groups，不信任请求体中的角色或用户 ID。
- Function 再查询 PostgreSQL `app_user`，确认 active 且 Cognito group 与数据库角色一致。
- `ADMIN`、`KITCHEN` 以外的 group、guest、API key 和匿名请求全部拒绝。
- 前端菜单隐藏只是体验层，不能替代路由和 Function 授权。

## 6. RDS Data API 契约

Functions 只通过 `@aws-sdk/client-rds-data` 使用：

- `BeginTransactionCommand`
- 参数化 `ExecuteStatementCommand`
- `CommitTransactionCommand`
- `RollbackTransactionCommand`

运行环境只注入非秘密的 cluster ARN、secret ARN 和 database name。Function IAM 只获得目标 cluster 的 Data API action 和目标 generated Secret 的读取权限。

禁止：

- 拼接来自客户端的 SQL、表名、排序字段或 WHERE 片段；
- 客户端提交派生金额、角色、审计身份或正式 Storage key；
- Function 建立 PostgreSQL TCP 连接池；
- 把 Secret、连接串、token 或完整账务 payload 写入日志。

厨房提交事务固定顺序：

1. 验证 Cognito claims 与 `app_user`；
2. 读取班次、负责人和设置；
3. 服务器计算 `cashDepositYen`、`staffMealTotalYen`、`totalSalesYen`、`deviationYen`；
4. 检查 `idempotency_key`；
5. 写入日报、revision 和附件归属；
6. commit 后返回服务器权威结果。

相同 idempotency key 的安全重试返回同一结果；不同 key 对同一 `[report_date, shift_id]` 返回 `409`，且不向厨房泄露已有日报内容。

## 7. Aurora 与网络

- Aurora Serverless v2 固定为 `MinCapacity=0`、`MaxCapacity=1`。
- 继续使用支持 0 ACU 的 Aurora PostgreSQL 版本；部署前必须在 `ap-northeast-1` 重新只读确认版本和 `db.serverless` 可用性。
- VPC 仍跨两个可用区，数据库子网保持私有；S3 Gateway Endpoint 保留。
- 不创建 Amplify SQL Lambda Security Group、SSM Interface Endpoint、RDS Proxy 或长期 NAT。
- DB Security Group 不为业务 Function 开放 `5432`；只允许经过单独批准的临时运维 Security Group。
- CloudShell VPC migration 如需下载依赖，可以创建带 ownership token 的临时 NAT/IGW/EIP；完成或失败后由 control cleanup 删除并做残留复查。
- 临时 SSM parameters 如继续用于 migration control/worker 状态，只能通过已批准的临时 NAT 访问，并在任务结束后删除；它们不构成长期开销。

## 8. Schema 与部署流程

PostgreSQL migration 保持权威，现有 `001_bootstrap.sql`、runner、verify 和 synthetic seed 继续使用。

取消：

- `ampx generate schema-from-database`；
- `amplify/data/schema.sql.ts`；
- `SQL_CONNECTION_STRING` Amplify branch secret；
- Amplify Data SQL authorization/model composition。

修订后的部署顺序：

1. foundation deploy：Cognito、Storage、VPC、Aurora Data API；
2. 临时 CloudShell VPC migration：执行 migration 两次并 verify，随后删除全部临时访问；
3. full backend deploy：API Gateway、Kitchen/Admin/Export Functions 和最小 IAM；
4. synthetic seed 与 API smoke；
5. Hosting build：Vue/PWA 使用 Cognito 和 HTTP API outputs；
6. 观察 Aurora 自动暂停、成本和残留资源。

每个 AWS 写入阶段仍有独立批准门。foundation、临时出口、full backend、Hosting、Budget/alarms 和销毁不能互相代替批准。

## 9. 自动暂停与用户体验

不建立定时 warm-up，避免为每天两次使用维持数据库计算费用。

Aurora 暂停后的第一次 Data API 请求可能比平时慢。服务端和前端按以下方式处理：

- 写入请求必须携带稳定 idempotency key；
- 短暂的 database unavailable/resuming 映射为 `503 DATABASE_RESUMING`，不映射成数据校验失败；
- PWA 显示“数据库正在唤醒，正在安全重试”；
- 客户端使用同一 idempotency key 做有限次数退避重试；
- 超过总等待上限后保留表单内容并允许人工重试，不产生重复日报。

管理员列表和统计可以显示同一唤醒状态，但不能缓存为“无数据”。

## 10. Storage、导出与文件

Storage 的既有边界保持：

- Bucket Block Public Access、加密、Versioning、`keepOnDelete`；
- `KITCHEN` 只能写自己的 pending key；
- Function 校验 ownership、MIME、大小和 hash 后转为正式附件；
- `ADMIN` 只通过 Function 获取短期下载 URL；
- validated key 始终视为 opaque，不做 percent-decode；
- 正式附件不自动过期，测试和 pending 使用明确生命周期。

导出由 Admin API 创建 `export_job`，Export Function 生成文件并写入受控 S3 key；不通过 AppSync subscription。

## 11. 成本边界

以 2026-08-23 东京公开价和 ECB 最近营业日参考汇率的低使用模型：

- 删除双 AZ SSM Interface Endpoint 后，低使用首月估算约 `¥1,000`（含税参考）；
- `1 ACU × 730h` 加其他低使用项目的指定最坏月约 `¥19,600`（含税参考）；
- `MonthlyCeilingJpy=5000`；约 `¥19,600` 的指定最坏月明确超过批准上限，不再由缓冲覆盖，必须自动使审批失效、停止新增写入并进入成本/清理复查。

该上限不是 AWS 硬停止。部署日必须重新计算价格和汇率；任何额外 Interface Endpoint、长期 NAT、RDS Proxy、AppSync/Amplify Data 或容量上限提高都会使批准立即失效。

## 12. 测试与验收

本地必须证明：

- foundation synth 中 Aurora 为 `0–1 ACU`；
- 不存在 `AWS::EC2::VPCEndpoint` 的 SSM Interface Endpoint，只保留 S3 Gateway Endpoint；
- 不存在 AppSync、Amplify Data SQL Lambda、Updater Lambda、RDS Proxy 或长期 NAT；
- Functions 不在 VPC，并且只获得目标 Data API、Secret 和精确 S3 action；
- Kitchen/Admin HTTP routes 都有 Cognito JWT authorizer；
- kitchen history/admin routes 返回 `403`；
- Data API 参数映射、事务 commit/rollback、幂等和冲突均有测试；
- 网管餐费现金计入现金入金，现金和支付宝都不进入实际销售；支付宝独立持久化；
- `DATABASE_RESUMING` 使用同一 idempotency key 重试，不产生重复记录；
- public bundle 不含 Secret、连接串或合成密码。

云端 staging 必须证明：

- Aurora private、Data API enabled、0–1 ACU、无 Proxy/长期 NAT/SSM Interface Endpoint；
- migration 第一次应用、第二次 no-op、schema verify 通过；
- `ADMIN`/`KITCHEN` 权限矩阵和厨房历史拒绝真实生效；
- 两次结账量级的合成提交、重复提交、统计和导出成功；
- 空闲后 `ServerlessV2Usage=0`；
- 第一次唤醒提交最终成功且没有重复日报；
- 临时 NAT、运维 SG、ingress、SSM parameters 和 CloudShell 临时凭据全部清理；
- 实际月预测未超过批准的 `¥5,000`。

## 13. 回滚与非目标

- staging 失败不影响当前 NestJS/SQLite 运行层。
- 不在本修订中导入真实 SQLite、bcrypt hash 或 uploads。
- 不创建 production，不切换店内入口，不退役 NestJS。
- 不把 PostgreSQL 改为 DynamoDB，也不引入第三方数据库服务。
- 不为了降低冷启动而创建定时唤醒、长期连接或 RDS Proxy。
- 将来如果确实需要 Amplify Data SQL Connector，必须重新加入 AppSync/SQL Lambda/Updater Lambda、SSM 网络成本、安全组和独立成本批准，不能静默恢复。
