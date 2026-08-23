# FSK Amplify Gen 2 staging 两阶段部署 Runbook

## 0. 状态、边界和停止门

| 字段 | 值 |
| --- | --- |
| RunStatus | `LOCAL_FOUNDATION_ONLY` |
| AWSWritesPerformed | `NONE` |
| AWS Account | `444083008754` |
| Region | `ap-northeast-1` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| AmplifyBranchArn | `PENDING_DEPLOYMENT` |
| BackendBranch | `staging` |
| FoundationTag | `fsk-staging-foundation-v1` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

执行顺序固定为：

1. foundation deploy；
2. CloudShell VPC migration；
3. schema generation；
4. full backend deploy；
5. Hosting build。

不得跳步或并行推进。首次 AWS 写入前必须停止，展示 [`staging-cost-approval.md`](./staging-cost-approval.md) 的资源表和 `MonthlyCeilingJpy`，并取得用户对“首次 staging AWS 写入及该月上限”的明确批准。完整 backend、Budget/alarms 和销毁分别有独立审批门。

共同约束：只允许 account `444083008754`、region `ap-northeast-1` 和 staging；不创建或复用 production；不读取真实 SQLite、用户 hash、备份或 uploads；不得记录密码、Token、Secret 值、连接串或 Cognito CSV。Storage key 在所有后续 Function 中保持 opaque，所有权验证前后都不得 percent-decode。

## 1. 首次 AWS 写入前只读预检

以下命令只读，但仍需核对当前登录身份。只要 account/region/资源冲突不符合预期，就停止，不复用未知资源。

```bash
aws sts get-caller-identity
aws configure get region
aws amplify list-apps --region ap-northeast-1 --query 'apps[].{name:name,id:appId}'
aws rds describe-db-clusters --region ap-northeast-1 --query 'DBClusters[].DBClusterIdentifier'
aws rds describe-db-engine-versions --region ap-northeast-1 --engine aurora-postgresql --query 'DBEngineVersions[?EngineVersion==`18.4` && ServerlessV2FeaturesSupport.MinCapacity==`0`].[EngineVersion,ServerlessV2FeaturesSupport.MinCapacity,Status]' --output table
aws rds describe-orderable-db-instance-options --region ap-northeast-1 --engine aurora-postgresql --db-instance-class db.serverless --engine-version 18.4 --query 'OrderableDBInstanceOptions[].AvailabilityZones[].Name' --output text
```

Aurora `18.4` 只是 2026-08-23 的只读发现结果，不能当作永久事实。每次实际 foundation deploy 前都必须重新执行最后两条只读查询，确认版本仍为 `available`、最小 0 ACU 且 `db.serverless` 可用。不得在没有证据时静默换版本。

| 证据字段 | 值 |
| --- | --- |
| PreflightAtJst | `PENDING_DEPLOYMENT` |
| CallerAccount | `PENDING_DEPLOYMENT` |
| CallerArnRedacted | `PENDING_DEPLOYMENT` |
| RegionVerified | `PENDING_DEPLOYMENT` |
| NameConflictCheck | `PENDING_DEPLOYMENT` |
| Aurora18_4ZeroAcuEvidence | `PENDING_DEPLOYMENT` |
| DbServerlessOrderableEvidence | `PENDING_DEPLOYMENT` |

## 2. Stage 1 — foundation deploy

### 2.1 批准后创建独立 App/branch

在 Amplify Console 创建独立 `fsk-staging` Gen 2 App，只连接 Git `staging` branch。立即关闭 Auto build；不连接 `main`，不启用 PR preview，不添加 production 环境变量。此动作属于首次 AWS 写入，审批记录未完成时不得执行。

| 证据字段 | 值 |
| --- | --- |
| ApprovalId | `PENDING_USER_APPROVAL` |
| MonthlyCeilingJpy | `PENDING_USER_APPROVAL` |
| AppId | `PENDING_DEPLOYMENT` |
| AppArn | `PENDING_DEPLOYMENT` |
| BranchArn | `PENDING_DEPLOYMENT` |
| AutoBuildDisabled | `PENDING_DEPLOYMENT` |
| ConnectedBranches | `PENDING_DEPLOYMENT` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

### 2.2 从 foundation tag 走 branch/pipeline 部署

`keepOnDelete` 必须由 branch/pipeline backend 验证；Amplify sandbox 会忽略该保留语义，因此本流程禁止 `ampx sandbox`。

```bash
git checkout fsk-staging-foundation-v1
CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id "$AMPLIFY_APP_ID" --outputs-out-dir apps/web/public
git switch RE/amplify-gen2-staging-implementation
```

`apps/web/public/amplify_outputs.json` 只用于核对，保持 Git ignored。部署后必须切回当前 implementation branch，不切到 design-only branch。

| 证据字段 | 值 |
| --- | --- |
| Command | `CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id <redacted-app-id> --outputs-out-dir apps/web/public` |
| Region | `ap-northeast-1` |
| GitTag | `fsk-staging-foundation-v1` |
| GitCommit | `PENDING_DEPLOYMENT` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| AmplifyBranchArn | `PENDING_DEPLOYMENT` |
| RootStackId | `PENDING_DEPLOYMENT` |
| AuthStackId | `PENDING_DEPLOYMENT` |
| StorageStackId | `PENDING_DEPLOYMENT` |
| FoundationStackId | `PENDING_DEPLOYMENT` |
| CleanupOwner | `PENDING_USER_APPROVAL` |
| StartedAtJst | `PENDING_DEPLOYMENT` |
| CompletedAtJst | `PENDING_DEPLOYMENT` |

验证：Aurora 私有、0–2 ACU、Data API enabled、无 Proxy/NAT；S3 Block Public Access/Versioning/保留策略；Cognito 禁止 self sign-up、仅 ADMIN/KITCHEN、Identity Pool guest=false；所有可标签资源至少有 `Project=FSK`、`Environment=staging`、`ManagedBy=AmplifyGen2`、`CostCenter=FSK`。foundation 不得出现 AppSync Data 或业务 Functions。

## 3. Stage 2a — CloudShell VPC migration

此步骤只在 foundation 部署成功后执行。在同一 VPC 的 application 私有子网创建临时 CloudShell VPC 环境和临时运维 Security Group；DB Security Group 只允许该组到 5432。不得把数据库设为 public，也不得增加长期 NAT Gateway。

如果安装依赖确实需要临时出口，先记录资源、预计持续时间、成本归属和删除责任人；创建/删除临时出口是可计费写入，必须在现有批准范围内，否则再次停止取批。数据库连接串只在当前进程构造，不写文件、shell history 或文档。

```bash
pnpm install --frozen-lockfile
pnpm run db:staging:migrate
pnpm run db:staging:migrate
pnpm run db:staging:verify
```

| 证据字段 | 值 |
| --- | --- |
| Command | `pnpm install --frozen-lockfile && pnpm run db:staging:migrate && pnpm run db:staging:migrate && pnpm run db:staging:verify` |
| Region | `ap-northeast-1` |
| FoundationStackId | `PENDING_DEPLOYMENT` |
| CloudShellEnvironmentId | `PENDING_CLOUDSHELL` |
| OperationsSecurityGroupId | `PENDING_CLOUDSHELL` |
| TemporaryEgressResourceIds | `NONE_OR_PENDING_CLOUDSHELL` |
| Migration001FirstRun | `PENDING_CLOUDSHELL` |
| Migration001SecondRunNoOp | `PENDING_CLOUDSHELL` |
| VerifySchemaResult | `PENDING_CLOUDSHELL` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

真实 Aurora 验收必须补齐：PostgreSQL parser 执行、catalog 约束、失败 rollback、第二次 no-op 和并发锁证据。fake client 测试不能替代这一项。

## 4. Stage 2b — schema generation

在 Amplify staging branch secrets 中设置 `SQL_CONNECTION_STRING`，值只来自 Aurora Secret 与 private endpoint；不打印 Secret。随后在 CloudShell VPC 中运行：

```bash
pnpm exec ampx generate schema-from-database --connection-uri-secret SQL_CONNECTION_STRING --app-id "$AMPLIFY_APP_ID" --branch staging --out amplify/data/schema.sql.ts
```

把 CLI 生成文件带回 implementation branch，扫描 hostname、username、password、ARN 和合成密码；第二次运行必须无 Git diff。`schema.sql.ts` 只能由该命令更新，禁止手工编辑。

| 证据字段 | 值 |
| --- | --- |
| Command | `pnpm exec ampx generate schema-from-database --connection-uri-secret SQL_CONNECTION_STRING --app-id <redacted-app-id> --branch staging --out amplify/data/schema.sql.ts` |
| Region | `ap-northeast-1` |
| FoundationStackId | `PENDING_DEPLOYMENT` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| BranchSecretName | `SQL_CONNECTION_STRING` |
| GeneratedSchemaCommit | `PENDING_SCHEMA_GENERATION` |
| SecondGenerationGitDiff | `PENDING_SCHEMA_GENERATION` |
| SecretScanResult | `PENDING_SCHEMA_GENERATION` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

完成后删除临时 DB ingress、临时出口和 CloudShell 中的凭据/临时文件，并只读确认 NAT Gateway 为 0。未确认清理不得进入 full backend deploy。

## 5. Stage 3 — full backend deploy（独立审批门）

先展示最终 backend diff、AppSync/SQL Lambda/业务 Functions/日志资源和更新后的成本表。只有用户明确批准第二次全栈 AWS 写入后才执行：

```bash
CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id "$AMPLIFY_APP_ID" --outputs-out-dir apps/web/public
```

| 证据字段 | 值 |
| --- | --- |
| FullBackendApprovalId | `PENDING_USER_APPROVAL` |
| Command | `CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id <redacted-app-id> --outputs-out-dir apps/web/public` |
| Region | `ap-northeast-1` |
| FullBackendCommit | `PENDING_FULL_BACKEND` |
| RootStackId | `PENDING_FULL_BACKEND` |
| DataStackId | `PENDING_FULL_BACKEND` |
| FunctionStackIds | `PENDING_FULL_BACKEND` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

只创建 `stage-admin`、`stage-kitchen`、固定四班和合成数据。不得导入 production 或任何本地真实数据。Budget、Cost Anomaly Detection 和新 alarms 仍等待 Task 17 独立批准。

## 6. Stage 4 — Hosting build

保持 branch Auto build 关闭，在 full backend 和输出核对成功后由 Console 手动 Start build。构建环境固定 `VITE_RUNTIME_MODE=amplify-staging`。Hosting build 只生成 outputs 并构建 Vue，不得运行 backend deploy。

| 证据字段 | 值 |
| --- | --- |
| Command | `Amplify Console: Start build` |
| Region | `ap-northeast-1` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| HostingBranch | `staging` |
| HostingBuildId | `PENDING_HOSTING` |
| HostingUrl | `PENDING_HOSTING` |
| ViteRuntimeMode | `amplify-staging` |
| PublicBundleSecretScan | `PENDING_HOSTING` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

## 7. 每阶段清理与费用复查

每阶段结束都记录 RDS cluster/snapshot、NAT Gateway、VPC Endpoint、S3 bucket/versions、CloudWatch logs 和 Amplify branch 的只读清单。重点确认：

- 临时出口、临时 DB ingress 和 CloudShell 凭据已删除；
- SSM Interface Endpoint 是持续计费资源，不能因 Aurora 0 ACU 而从成本表消失；
- S3 `keepOnDelete` 和版本会在 stack 删除后继续产生费用，清理必须走独立销毁批准；
- 正式附件不自动过期，只有 `pending/`、`test-exports/`、`migration-staging/` 使用短生命周期；
- Aurora idle 后真实 `ServerlessV2Usage` 必须观察为 0；
- 未知持续费用、权限负向失败或清理缺证据时，阶段状态写 `BLOCKED`。

| 证据字段 | 值 |
| --- | --- |
| CheckedAtJst | `PENDING_DEPLOYMENT` |
| RdsResiduals | `PENDING_DEPLOYMENT` |
| NatGatewayCount | `PENDING_DEPLOYMENT` |
| VpcEndpointList | `PENDING_DEPLOYMENT` |
| S3VersionedResiduals | `PENDING_DEPLOYMENT` |
| CloudWatchResiduals | `PENDING_DEPLOYMENT` |
| TemporaryEgressDeleted | `PENDING_DEPLOYMENT` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

本 runbook 的所有 `PENDING_*` 字段都是未完成证据槽，不能解释为已部署、已批准或已清理。
