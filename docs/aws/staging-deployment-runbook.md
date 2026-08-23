# FSK Amplify Gen 2 staging 分阶段部署 Runbook

## 0. 状态、边界和停止门

| 字段 | 值 |
| --- | --- |
| RunStatus | `LOCAL_FOUNDATION_ONLY` |
| AWSWritesPerformed | `NONE` |
| SharedGitWritesPerformed | `NONE` |
| AWS Account | `444083008754` |
| Region | `ap-northeast-1` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| AmplifyBranchArn | `PENDING_DEPLOYMENT` |
| BackendBranch | `staging` |
| FoundationTag | `fsk-staging-foundation-v1` |
| RemoteStagingCommit | `PENDING_TASK7_GIT_WRITE` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

执行顺序固定为：

1. Task 7 批准后建立并核对远程 `staging` Git ref；
2. Amplify Console `Save and deploy` bootstrap foundation job，并立即关闭 Auto build；
3. 本地 `pipeline-deploy` 对 foundation 做权威、幂等 reconciliation；
4. Task 8 单独批准临时 CloudShell VPC 访问和临时 NAT；
5. migration 首次执行、第二次 no-op 和 verify；
6. 设置 branch secret、两次生成 schema、无差异核对并安全带回；
7. 立即删除临时出口，再删除 CloudShell environment、DB ingress 和运维 Security Group；
8. full backend deploy；
9. Hosting build。

不得跳步或并行推进。§2.1 的共享 Git 写入和首次 AWS 写入都必须等到 Task 7 批准；执行前展示 [`staging-cost-approval.md`](./staging-cost-approval.md) 的资源表和 `MonthlyCeilingJpy`，并取得用户对“建立远程 staging ref、首次 staging AWS 写入及该月上限”的明确批准。完整 backend、Task 8 临时访问、Budget/alarms 和销毁分别有独立审批门。

共同约束：只允许 account `444083008754`、region `ap-northeast-1` 和 staging；不创建或复用 production；不读取真实 SQLite、用户 hash、备份或 uploads；不得记录密码、Token、Secret 值、连接串或 Cognito CSV。Storage key 在所有后续 Function 中保持 opaque，所有权验证前后都不得 percent-decode。

`amplify/backend.foundation.ts` 在 synth 开始前要求 `AWS_REGION` 和 `AWS_DEFAULT_REGION` 同时精确为 `ap-northeast-1`；缺失或漂移会以 `STAGING_REGION_MISMATCH` fail-fast。所有 deploy 命令必须使用本 runbook 给出的显式 region 环境变量，不能依赖操作者本机 profile 的默认值。

## 1. 首次 AWS 写入前只读预检

以下命令只读，但仍需核对当前登录身份。只要 account/region/资源冲突不符合预期，就停止，不复用未知资源。

```bash
export AWS_REGION=ap-northeast-1
export AWS_DEFAULT_REGION=ap-northeast-1
test "$AWS_REGION" = ap-northeast-1
test "$AWS_DEFAULT_REGION" = ap-northeast-1
aws sts get-caller-identity
aws configure get region
aws configure list
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
| EffectiveAwsRegion | `PENDING_DEPLOYMENT` |
| EffectiveAwsDefaultRegion | `PENDING_DEPLOYMENT` |
| ConfigureListEvidence | `PENDING_DEPLOYMENT` |
| NameConflictCheck | `PENDING_DEPLOYMENT` |
| Aurora18_4ZeroAcuEvidence | `PENDING_DEPLOYMENT` |
| DbServerlessOrderableEvidence | `PENDING_DEPLOYMENT` |

## 2. Stage 1 — foundation deploy

### 2.1 Task 7 批准后的共享 Git 写入：建立远程 `staging`

此步骤不是本地准备动作，而是 Task 7 明确批准后才允许执行的共享 Git 写入；它发生在首次打开 Amplify Console 创建 App **之前**。远程 `staging` 必须精确从 `fsk-staging-foundation-v1^{commit}` 建立，不创建、不推送也不连接 `main`，禁止 force push。先只读核对；远程 ref 已存在但不等于 foundation commit 时立即 `STOP`，不得覆盖：

```bash
: "${FSK_GIT_REMOTE:=origin}"
FSK_FOUNDATION_COMMIT="$(git rev-parse 'fsk-staging-foundation-v1^{commit}')"
FSK_REMOTE_STAGING_LINE="$(git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging)"
FSK_REMOTE_STAGING_COUNT="$(printf '%s\n' "$FSK_REMOTE_STAGING_LINE" | awk 'NF { count += 1 } END { print count + 0 }')"
test "$FSK_REMOTE_STAGING_COUNT" -le 1

if [ "$FSK_REMOTE_STAGING_COUNT" -eq 1 ]; then
  FSK_REMOTE_STAGING_COMMIT="$(printf '%s\n' "$FSK_REMOTE_STAGING_LINE" | awk 'NR == 1 { print $1 }')"
  if [ "$FSK_REMOTE_STAGING_COMMIT" != "$FSK_FOUNDATION_COMMIT" ]; then
    echo 'REMOTE_STAGING_DIVERGED_STOP_NO_FORCE' >&2
    exit 1
  fi
  FSK_REMOTE_STAGING_ACTION=ALREADY_EXACT_NO_PUSH
else
  git push "$FSK_GIT_REMOTE" "${FSK_FOUNDATION_COMMIT}:refs/heads/staging"
  FSK_REMOTE_STAGING_ACTION=CREATED_NON_FORCE
fi

FSK_VERIFIED_REMOTE_STAGING_COMMIT="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging |
    awk 'NR == 1 { print $1 }'
)"
test "$FSK_VERIFIED_REMOTE_STAGING_COMMIT" = "$FSK_FOUNDATION_COMMIT"
FSK_REMOTE_BRANCH_ACTOR="$(git config user.name)"
: "${FSK_REMOTE_BRANCH_ACTOR:?configure an audited Git actor name}"
FSK_REMOTE_BRANCH_VERIFIED_AT_JST="$(TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z')"
```

`FSK_REMOTE_STAGING_ACTION`、最终只读 commit、Git actor 和 JST 时间写入证据；不得记录凭据化 remote URL。远程 `staging` 是共享 ref，Amplify App/branch 删除不会自动授权删除它；销毁流程见 §7。

### 2.2 Console bootstrap job 与立即关闭 Auto build

在 Task 7 审批、§2.1 远程 commit 验证都完成后，确认 Amplify Console 右上角 region 为 `ap-northeast-1`，再执行：`All apps` → `Create new app` → 选择已批准的 Git provider/repository → App name 输入 `fsk-staging` → 只选择 `staging` → `Save and deploy`。标准 Git 连接流程会先启动一个 bootstrap job，不能假装 App 创建时没有部署；该 job 就是 Task 7 已批准的首次 AWS write，必须只处理 foundation commit。

`Save and deploy` 前再次在页面核对 branch/commit；启动后立即记录 App ID、branch ARN 和 job ID，然后进入 `App settings` → `Branch settings` → `Edit`，关闭 `staging` 的 Auto build，同时保持 Branch auto-detection、auto-disconnection 和 PR preview 全部关闭。随后使用下列只读命令核对 job；commit 必须等于 §2.1 的 foundation commit：

```bash
: "${AMPLIFY_APP_ID:?record the new Amplify App ID}"
: "${AMPLIFY_BOOTSTRAP_JOB_ID:?record the Save and deploy job ID}"
FSK_BOOTSTRAP_JOB_STATUS="$(aws amplify get-job \
  --region ap-northeast-1 \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name staging \
  --job-id "$AMPLIFY_BOOTSTRAP_JOB_ID" \
  --query 'job.summary.status' --output text)"
FSK_BOOTSTRAP_JOB_COMMIT="$(aws amplify get-job \
  --region ap-northeast-1 \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name staging \
  --job-id "$AMPLIFY_BOOTSTRAP_JOB_ID" \
  --query 'job.summary.commitId' --output text)"
if [ "$FSK_BOOTSTRAP_JOB_COMMIT" != "$FSK_FOUNDATION_COMMIT" ]; then
  case "$FSK_BOOTSTRAP_JOB_STATUS" in
    PENDING|PROVISIONING|RUNNING)
      aws amplify stop-job \
        --region ap-northeast-1 \
        --app-id "$AMPLIFY_APP_ID" \
        --branch-name staging \
        --job-id "$AMPLIFY_BOOTSTRAP_JOB_ID"
      ;;
  esac
  echo 'BOOTSTRAP_COMMIT_MISMATCH_STOP_AND_AUDIT' >&2
  exit 1
fi
```

若 commit 漂移，或 job/CloudFormation 预览出现 Amplify Data/AppSync、业务 Function、generated SQL schema、`main`/production 引用，立即停止。job 仍为 `PENDING`、`PROVISIONING` 或 `RUNNING` 时，上述 Task 7 安全停止命令会 cancel；job 已结束时不擅自删除资源，状态置为 `BLOCKED` 并进入审计/独立销毁审批。通过 Console 或重复只读 `get-job` 取得 terminal status；只有 bootstrap job 为 `SUCCEED`、commit 精确且 foundation-only 核对通过，才能继续。

| 证据字段 | 值 |
| --- | --- |
| ApprovalId | `PENDING_USER_APPROVAL` |
| MonthlyCeilingJpy | `PENDING_USER_APPROVAL` |
| Region | `ap-northeast-1` |
| GitRemote | `PENDING_TASK7_GIT_WRITE` |
| RemoteBranchName | `staging` |
| FoundationCommit | `PENDING_TASK7_GIT_WRITE` |
| RemoteBranchCommit | `PENDING_TASK7_GIT_WRITE` |
| RemoteBranchAction | `EXISTING_EXACT_OR_CREATED_NON_FORCE` |
| PushEvidence | `PENDING_TASK7_GIT_WRITE` |
| RemoteBranchActor | `PENDING_TASK7_GIT_WRITE` |
| RemoteBranchVerifiedAtJst | `PENDING_TASK7_GIT_WRITE` |
| AppId | `PENDING_DEPLOYMENT` |
| AppArn | `PENDING_DEPLOYMENT` |
| BranchName | `staging` |
| BranchArn | `PENDING_DEPLOYMENT` |
| BootstrapJobId | `PENDING_DEPLOYMENT` |
| BootstrapJobStatus | `PENDING_DEPLOYMENT` |
| BootstrapJobCommit | `PENDING_DEPLOYMENT` |
| BootstrapFoundationOnlyAudit | `PENDING_DEPLOYMENT` |
| AutoBuildDisabled | `PENDING_DEPLOYMENT` |
| AutoBuildDisabledAtJst | `PENDING_DEPLOYMENT` |
| ConnectedBranches | `PENDING_DEPLOYMENT` |
| AppCreateConsoleScreenshotPath | `PENDING_DEPLOYMENT` |
| BootstrapJobConsoleScreenshotPath | `PENDING_DEPLOYMENT` |
| BranchSettingsScreenshotPath | `PENDING_DEPLOYMENT` |
| EnvironmentVariablesScreenshotPath | `PENDING_DEPLOYMENT` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

### 2.3 从 foundation tag 做权威 branch/pipeline reconciliation

`keepOnDelete` 必须由 branch/pipeline backend 验证；Amplify sandbox 会忽略该保留语义，因此本流程禁止 `ampx sandbox`。

Console bootstrap job 成功后，以下本地 `pipeline-deploy` 是 foundation 部署的权威、幂等 reconciliation；它不是“唯一第一次部署”，也不能抹去前述 bootstrap job 证据。受控部署 commit 必须再次等于 tag commit：

```bash
FSK_FOUNDATION_COMMIT="$(git rev-parse 'fsk-staging-foundation-v1^{commit}')"
git switch --detach "$FSK_FOUNDATION_COMMIT"
test "$(git rev-parse HEAD)" = "$FSK_FOUNDATION_COMMIT"
if AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 CI=1 \
  pnpm exec ampx pipeline-deploy --branch staging \
    --app-id "$AMPLIFY_APP_ID" \
    --outputs-out-dir apps/web/public; then
  FSK_FOUNDATION_PIPELINE_EXIT=0
else
  FSK_FOUNDATION_PIPELINE_EXIT=$?
fi
git switch RE/amplify-gen2-staging-implementation
test "$FSK_FOUNDATION_PIPELINE_EXIT" -eq 0
```

`apps/web/public/amplify_outputs.json` 只用于核对，保持 Git ignored。部署后必须切回当前 implementation branch，不切到 design-only branch。

| 证据字段 | 值 |
| --- | --- |
| Command | `AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id <redacted-app-id> --outputs-out-dir apps/web/public` |
| Region | `ap-northeast-1` |
| GitTag | `fsk-staging-foundation-v1` |
| GitCommit | `PENDING_DEPLOYMENT` |
| ControlledDeployCommit | `PENDING_DEPLOYMENT` |
| PipelineDeployExit | `PENDING_DEPLOYMENT` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| AmplifyBranchArn | `PENDING_DEPLOYMENT` |
| RootStackId | `PENDING_DEPLOYMENT` |
| AuthStackId | `PENDING_DEPLOYMENT` |
| StorageStackId | `PENDING_DEPLOYMENT` |
| FoundationStackId | `PENDING_DEPLOYMENT` |
| VpcIdOutput | `PENDING_DEPLOYMENT` |
| DatabaseSecurityGroupIdOutput | `PENDING_DEPLOYMENT` |
| CleanupOwner | `PENDING_USER_APPROVAL` |
| StartedAtJst | `PENDING_DEPLOYMENT` |
| CompletedAtJst | `PENDING_DEPLOYMENT` |

验证：Aurora 私有、0–2 ACU、Data API enabled、无 Proxy/NAT；S3 Block Public Access/Versioning/保留策略；Cognito 禁止 self sign-up、仅 ADMIN/KITCHEN、Identity Pool guest=false；所有可标签资源至少有 `Project=FSK`、`Environment=staging`、`ManagedBy=AmplifyGen2`、`CostCenter=FSK`。foundation 不得出现 AppSync Data 或业务 Functions。

## 3. Stage 2a — Task 8 CloudShell VPC migration

此步骤只在 foundation 部署成功且取得 **Task 8 独立批准** 后执行。在同一 VPC 的 application 私有子网创建临时 CloudShell VPC environment 和临时运维 Security Group；DB Security Group 只允许该组到 5432。不得把数据库设为 public，也不得增加长期 NAT Gateway。

### 3.1 创建临时运维 Security Group

从 `FskStagingFoundation` outputs 取得 VPC 与 DB Security Group ID；先设置唯一任务编号，再运行下列已批准的写入。不得使用名称搜索猜测目标。

```bash
: "${FSK_CLOUDSHELL_TASK_ID:?set an approved task id}"
: "${FSK_VPC_ID:?set the VpcId stack output}"
: "${FSK_DB_SECURITY_GROUP_ID:?set the DatabaseSecurityGroupId stack output}"
FSK_OPS_SECURITY_GROUP_ID="$(aws ec2 create-security-group \
  --region ap-northeast-1 \
  --vpc-id "$FSK_VPC_ID" \
  --group-name "fsk-staging-cloudshell-${FSK_CLOUDSHELL_TASK_ID}" \
  --description "Temporary CloudShell access for ${FSK_CLOUDSHELL_TASK_ID}" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query GroupId --output text)"
aws ec2 authorize-security-group-ingress \
  --region ap-northeast-1 \
  --group-id "$FSK_DB_SECURITY_GROUP_ID" \
  --protocol tcp --port 5432 \
  --source-group "$FSK_OPS_SECURITY_GROUP_ID"
```

在 CloudShell Console 的 VPC environment 创建流程中，名称使用 `fsk-staging-${FSK_CLOUDSHELL_TASK_ID}`，VPC 精确选择 `$FSK_VPC_ID`，只选择 foundation 的 application 私有子网，并只附加 `$FSK_OPS_SECURITY_GROUP_ID`。创建完成后保存配置页截图；截图必须能核对 environment name、VPC ID、subnet IDs、Security Group ID 和 region，但不能包含 Secret。

### 3.2 Task 8 单独批准的 REQUIRED 临时出口

CloudShell VPC 中的 `pnpm install`、Secrets Manager credential 读取，以及 `ampx generate schema-from-database` 对 Amplify/SSM API 的访问都需要公网出口；本 runbook 没有已验证的无 NAT 替代路径。因此 Task 8 的 `TemporaryEgressMode` 固定为 `REQUIRED_APPROVED_TEMP_NAT`，必须先取得与 Task 7 分离的临时出口写入/成本批准并记录 `Task8ApprovalId`、`TemporaryEgressApprovalId`、最大持续时间和删除责任人。未批准则 `STOP`，不得进入本节。

允许的临时拓扑仅为：任务标签的 IGW + 单个 public subnet/route table + EIP/NAT + application route tables 的临时 `0.0.0.0/0` route；不得改数据库子网 route table。临时 NAT 必须保持到 migration、第二次 no-op、verify、branch secret 配置、两次 schema generation、无差异/安全扫描和生成物安全带回全部完成，随后立即按 §4.3 删除。

批准后，先通过只读 VPC/subnet/route-table 查询选择未使用的 `$FSK_TEMP_PUBLIC_CIDR`、`$FSK_TEMP_AZ` 和两个 application route table IDs，再执行并记录每个返回 ID：

```bash
: "${FSK_TEMP_EGRESS_APPROVAL_ID:?temporary egress requires separate approval}"
: "${FSK_TEMP_PUBLIC_CIDR:?set a verified unused VPC CIDR}"
: "${FSK_TEMP_AZ:?set the approved AZ}"
: "${FSK_APP_ROUTE_TABLE_A_ID:?set application route table A}"
: "${FSK_APP_ROUTE_TABLE_B_ID:?set application route table B}"
FSK_TEMP_IGW_ID="$(aws ec2 create-internet-gateway \
  --region ap-northeast-1 \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query InternetGateway.InternetGatewayId --output text)"
aws ec2 attach-internet-gateway --region ap-northeast-1 \
  --internet-gateway-id "$FSK_TEMP_IGW_ID" --vpc-id "$FSK_VPC_ID"
FSK_TEMP_PUBLIC_SUBNET_ID="$(aws ec2 create-subnet \
  --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
  --cidr-block "$FSK_TEMP_PUBLIC_CIDR" --availability-zone "$FSK_TEMP_AZ" \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query Subnet.SubnetId --output text)"
FSK_TEMP_PUBLIC_ROUTE_TABLE_ID="$(aws ec2 create-route-table \
  --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query RouteTable.RouteTableId --output text)"
FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID="$(aws ec2 associate-route-table \
  --region ap-northeast-1 --route-table-id "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
  --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" \
  --query AssociationId --output text)"
aws ec2 create-route --region ap-northeast-1 \
  --route-table-id "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
  --destination-cidr-block 0.0.0.0/0 --gateway-id "$FSK_TEMP_IGW_ID"
FSK_TEMP_EIP_ALLOCATION_ID="$(aws ec2 allocate-address \
  --region ap-northeast-1 --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query AllocationId --output text)"
FSK_TEMP_NAT_GATEWAY_ID="$(aws ec2 create-nat-gateway \
  --region ap-northeast-1 --connectivity-type public \
  --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" \
  --allocation-id "$FSK_TEMP_EIP_ALLOCATION_ID" \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query NatGateway.NatGatewayId --output text)"
aws ec2 wait nat-gateway-available --region ap-northeast-1 \
  --nat-gateway-ids "$FSK_TEMP_NAT_GATEWAY_ID"
aws ec2 create-route --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_A_ID" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$FSK_TEMP_NAT_GATEWAY_ID"
aws ec2 create-route --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_B_ID" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$FSK_TEMP_NAT_GATEWAY_ID"
```

创建后记录所有资源 ID、application route table IDs、创建时间、批准编号和 `CleanupOwner`；只读确认两个 application route table 的默认路由都精确指向该临时 NAT。此时不得提前删除出口。

### 3.3 执行 migration

先从 §2.3 记录的精确 Foundation stack ID 读取三个 outputs；不得用名称搜索猜 stack，也不得采用 Secret JSON 内的 host 代替 RDS describe 结果。再用只读 RDS describe 验证 endpoint 属于 Foundation VPC，且 cluster 的所有 DB instance 都不是 publicly accessible：

```bash
: "${FSK_FOUNDATION_STACK_ID:?use the exact FoundationStackId evidence}"
: "${FSK_VPC_ID:?use the exact VpcId output evidence}"
FSK_AURORA_CLUSTER_ARN="$(aws cloudformation describe-stacks \
  --region ap-northeast-1 --stack-name "$FSK_FOUNDATION_STACK_ID" \
  --query "Stacks[0].Outputs[?OutputKey=='AuroraClusterArn'].OutputValue | [0]" \
  --output text)"
FSK_AURORA_SECRET_ARN="$(aws cloudformation describe-stacks \
  --region ap-northeast-1 --stack-name "$FSK_FOUNDATION_STACK_ID" \
  --query "Stacks[0].Outputs[?OutputKey=='AuroraSecretArn'].OutputValue | [0]" \
  --output text)"
FSK_DATABASE_NAME="$(aws cloudformation describe-stacks \
  --region ap-northeast-1 --stack-name "$FSK_FOUNDATION_STACK_ID" \
  --query "Stacks[0].Outputs[?OutputKey=='DatabaseName'].OutputValue | [0]" \
  --output text)"
test -n "$FSK_AURORA_CLUSTER_ARN"
test "$FSK_AURORA_CLUSTER_ARN" != None
test -n "$FSK_AURORA_SECRET_ARN"
test "$FSK_AURORA_SECRET_ARN" != None
test "$FSK_DATABASE_NAME" = fsk_staging

FSK_DB_CLUSTER_ID="$(aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].DBClusterIdentifier' --output text)"
FSK_DB_ENDPOINT="$(aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].Endpoint' --output text)"
FSK_DB_PORT="$(aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].Port' --output text)"
FSK_DB_SUBNET_GROUP="$(aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].DBSubnetGroup' --output text)"
FSK_DB_SUBNET_VPC_ID="$(aws rds describe-db-subnet-groups \
  --region ap-northeast-1 --db-subnet-group-name "$FSK_DB_SUBNET_GROUP" \
  --query 'DBSubnetGroups[0].VpcId' --output text)"
FSK_DB_INSTANCE_COUNT="$(aws rds describe-db-instances \
  --region ap-northeast-1 \
  --filters "Name=db-cluster-id,Values=${FSK_DB_CLUSTER_ID}" \
  --query 'length(DBInstances)' --output text)"
FSK_PUBLIC_DB_INSTANCE_COUNT="$(aws rds describe-db-instances \
  --region ap-northeast-1 \
  --filters "Name=db-cluster-id,Values=${FSK_DB_CLUSTER_ID}" \
  --query 'length(DBInstances[?PubliclyAccessible==`true`])' --output text)"
test -n "$FSK_DB_ENDPOINT"
test "$FSK_DB_ENDPOINT" != None
test "$FSK_DB_SUBNET_VPC_ID" = "$FSK_VPC_ID"
test "$FSK_DB_INSTANCE_COUNT" -ge 1
test "$FSK_PUBLIC_DB_INSTANCE_COUNT" = 0
```

证据只能写“Foundation VPC 匹配、public instance count=0、private endpoint 验证通过”等脱敏结果；不得把完整 endpoint、cluster/Secret ARN 或连接串复制到报告。

保持 §3.2 临时 NAT，安装依赖后用下列块在当前 CloudShell 进程构造 `DATABASE_URL`。Secret value 只经 pipe 进入 Node stdin；用户名和密码分别用 `encodeURIComponent` URL encode；连接串只进入 command substitution 和当前进程环境，不打印、不写文件、不作为命令参数、不写入 shell history。`?sslmode=require` 和 `/fsk_staging` 与现有脚本的 `DATABASE_URL_REQUIRED`/TLS/database guard 兼容：

```bash
pnpm install --frozen-lockfile
FSK_MIGRATION_SOURCE_SHA256="$(
  sha256sum amplify/database/migrations/*.sql |
    sha256sum | awk '{ print $1 }'
)"

fsk_clear_database_url() {
  unset DATABASE_URL
}
trap fsk_clear_database_url EXIT
trap 'fsk_clear_database_url; exit 130' HUP INT TERM
set +x
if DATABASE_URL="$(
  aws secretsmanager get-secret-value \
    --region ap-northeast-1 \
    --secret-id "$FSK_AURORA_SECRET_ARN" \
    --query SecretString --output text |
  FSK_DB_ENDPOINT="$FSK_DB_ENDPOINT" \
  FSK_DB_PORT="$FSK_DB_PORT" \
  FSK_DATABASE_NAME="$FSK_DATABASE_NAME" \
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const secret = JSON.parse(input);
        const username = String(secret.username ?? "");
        const password = String(secret.password ?? "");
        const endpoint = String(process.env.FSK_DB_ENDPOINT ?? "");
        const port = String(process.env.FSK_DB_PORT ?? "");
        const database = String(process.env.FSK_DATABASE_NAME ?? "");
        if (!username || !password || !endpoint || !port || database !== "fsk_staging") {
          process.exit(2);
        }
        process.stdout.write(
          `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
          `@${endpoint}:${port}/${encodeURIComponent(database)}?sslmode=require`,
        );
      } catch {
        process.exit(2);
      }
    });
  '
)"; then
  export DATABASE_URL
else
  echo 'DATABASE_URL_BUILD_FAILED' >&2
  exit 1
fi

if pnpm run db:staging:migrate; then
  FSK_MIGRATE_FIRST_EXIT=0
else
  FSK_MIGRATE_FIRST_EXIT=$?
fi
FSK_MIGRATE_SECOND_EXIT=125
FSK_VERIFY_SCHEMA_EXIT=125
if [ "$FSK_MIGRATE_FIRST_EXIT" -eq 0 ]; then
  if pnpm run db:staging:migrate; then
    FSK_MIGRATE_SECOND_EXIT=0
  else
    FSK_MIGRATE_SECOND_EXIT=$?
  fi
fi
if [ "$FSK_MIGRATE_SECOND_EXIT" -eq 0 ]; then
  if pnpm run db:staging:verify; then
    FSK_VERIFY_SCHEMA_EXIT=0
  else
    FSK_VERIFY_SCHEMA_EXIT=$?
  fi
fi

fsk_clear_database_url
trap - EXIT HUP INT TERM
test -z "${DATABASE_URL+x}"
test "$FSK_MIGRATE_FIRST_EXIT" -eq 0
test "$FSK_MIGRATE_SECOND_EXIT" -eq 0
test "$FSK_VERIFY_SCHEMA_EXIT" -eq 0
```

首次 migrate 必须记录 `MIGRATIONS_APPLIED count=1`，第二次必须为 `count=0`，verify 必须为 `SCHEMA_VERIFIED`；任一步失败都在 unset 后 `STOP`。不得把 Secret value、username、password、完整 endpoint 或 `DATABASE_URL` 写入证据。

| 证据字段 | 值 |
| --- | --- |
| Command | `pnpm install --frozen-lockfile; migrate; migrate; verify`（不含连接串） |
| Region | `ap-northeast-1` |
| FoundationStackId | `PENDING_DEPLOYMENT` |
| FoundationOutputsRead | `PENDING_CLOUDSHELL_REDACTED` |
| PrivateEndpointValidation | `PENDING_CLOUDSHELL_REDACTED` |
| DbInstanceCount | `PENDING_CLOUDSHELL` |
| PublicDbInstanceCount | `PENDING_CLOUDSHELL` |
| VpcId | `PENDING_CLOUDSHELL` |
| ApplicationSubnetIds | `PENDING_CLOUDSHELL` |
| CloudShellEnvironmentId | `PENDING_CLOUDSHELL` |
| CloudShellEnvironmentName | `PENDING_CLOUDSHELL` |
| CloudShellVpcConfigScreenshotPath | `PENDING_CLOUDSHELL` |
| OperationsSecurityGroupId | `PENDING_CLOUDSHELL` |
| DbIngressRuleEvidence | `PENDING_CLOUDSHELL` |
| Task8ApprovalId | `PENDING_USER_APPROVAL` |
| TemporaryEgressMode | `REQUIRED_APPROVED_TEMP_NAT` |
| TemporaryEgressApprovalId | `PENDING_USER_APPROVAL` |
| TemporaryEgressResourceIds | `PENDING_CLOUDSHELL` |
| TemporaryEgressCreatedAtJst | `PENDING_CLOUDSHELL` |
| TemporaryEgressMaximumDuration | `PENDING_USER_APPROVAL` |
| TemporaryEgressDeletedAtJst | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressDeletionEvidence | `PENDING_SCHEMA_GENERATION` |
| MigrationSourceSha256 | `PENDING_CLOUDSHELL` |
| Migration001FirstRun | `PENDING_CLOUDSHELL` |
| Migration001FirstExit | `PENDING_CLOUDSHELL` |
| Migration001SecondRunNoOp | `PENDING_CLOUDSHELL` |
| Migration001SecondExit | `PENDING_CLOUDSHELL` |
| VerifySchemaResult | `PENDING_CLOUDSHELL` |
| VerifySchemaExit | `PENDING_CLOUDSHELL` |
| DatabaseUrlCleared | `PENDING_CLOUDSHELL` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

真实 Aurora 验收必须补齐：PostgreSQL parser 执行、catalog 约束、失败 rollback、第二次 no-op 和并发锁证据。fake client 测试不能替代这一项。

## 4. Stage 2b — branch secret、schema generation、安全带回与临时访问清理

### 4.1 设置 branch-specific Amplify secret

保持 §3.2 临时 NAT。按照 [Amplify Gen 2 官方 branch secrets 流程](https://docs.amplify.aws/vue/deploy-and-host/fullstack-branching/secrets-and-vars/)，从 App home 进入 `Hosting` → `Secrets` → `Manage secrets`，新增 key `SQL_CONNECTION_STRING`，scope **只选择 `staging` branch**。不得放入 environment variables，也不得设为 shared/all branches。

Value 使用 §3.3 同一 private endpoint、port、`fsk_staging` 和 Aurora generated Secret 中的 username/password，并按相同算法分别 URL encode，格式固定为 `postgresql://<encoded-user>:<encoded-password>@<private-endpoint>:<port>/fsk_staging?sslmode=require`。只允许通过 Console 的 masked secret input 输入；禁止 `echo`、命令参数、文件、shell history、文档或截图，无法提供合规的 masked 输入路径时 `STOP`。保存后只记录 key、branch scope、更新时间、操作者和 value 已遮蔽的 Console 截图；官方文档说明 branch secret 存在 Parameter Store，后续 `ampx` 会通过公网 Amplify/SSM API 读取，因此此时不能删除 NAT。

### 4.2 两次生成、无差异核对和安全带回

`schema.sql.ts` 只能由生成命令更新，禁止手工编辑。第一次生成后保存无敏感值 baseline 和 SHA-256；第二次运行必须与 baseline byte-for-byte 相同。下列 scanner 从 Secrets Manager pipe 读取敏感值，只返回 exit code，不打印命中的值：

```bash
: "${AMPLIFY_APP_ID:?use the exact Task 7 App ID evidence}"
: "${FSK_AURORA_SECRET_ARN:?reuse the Foundation output in the current session}"
: "${FSK_DB_ENDPOINT:?reuse the private endpoint in the current session}"
FSK_SCHEMA_COMPARE_DIR="$(mktemp -d)"
: "${FSK_SCHEMA_COMPARE_DIR:?mktemp failed}"

fsk_scan_generated_schema() {
  aws secretsmanager get-secret-value \
    --region ap-northeast-1 \
    --secret-id "$FSK_AURORA_SECRET_ARN" \
    --query SecretString --output text |
  FSK_SCHEMA_PATH=amplify/data/schema.sql.ts \
  FSK_DB_ENDPOINT="$FSK_DB_ENDPOINT" \
  node -e '
    const { readFileSync } = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const secret = JSON.parse(input);
        const artifact = readFileSync(process.env.FSK_SCHEMA_PATH, "utf8");
        const forbidden = [
          process.env.FSK_DB_ENDPOINT,
          secret.host,
          secret.username,
          secret.password,
        ].filter((value) => typeof value === "string" && value.length > 0);
        const unsafe = forbidden.some((value) => artifact.includes(value)) ||
          /postgres(?:ql)?:\/\//i.test(artifact) ||
          /\barn:(?:aws|aws-cn|aws-us-gov):/i.test(artifact);
        process.exit(unsafe ? 3 : 0);
      } catch {
        process.exit(2);
      }
    });
  '
}

pnpm exec ampx generate schema-from-database \
  --connection-uri-secret SQL_CONNECTION_STRING \
  --app-id "$AMPLIFY_APP_ID" \
  --branch staging \
  --out amplify/data/schema.sql.ts
fsk_scan_generated_schema
cp amplify/data/schema.sql.ts "$FSK_SCHEMA_COMPARE_DIR/schema.sql.ts.first"
FSK_SCHEMA_FIRST_SHA256="$(sha256sum amplify/data/schema.sql.ts | awk '{ print $1 }')"

pnpm exec ampx generate schema-from-database \
  --connection-uri-secret SQL_CONNECTION_STRING \
  --app-id "$AMPLIFY_APP_ID" \
  --branch staging \
  --out amplify/data/schema.sql.ts
fsk_scan_generated_schema
cmp -s "$FSK_SCHEMA_COMPARE_DIR/schema.sql.ts.first" amplify/data/schema.sql.ts
FSK_SCHEMA_SECOND_SHA256="$(sha256sum amplify/data/schema.sql.ts | awk '{ print $1 }')"
test "$FSK_SCHEMA_SECOND_SHA256" = "$FSK_SCHEMA_FIRST_SHA256"
rm -- "$FSK_SCHEMA_COMPARE_DIR/schema.sql.ts.first"
rmdir -- "$FSK_SCHEMA_COMPARE_DIR"
unset FSK_SCHEMA_COMPARE_DIR
```

foundation 阶段尚未创建 `stage-admin`/`stage-kitchen` 密码；若执行顺序改变且已有合成凭据，必须把这些值加入同一 no-output scanner 后才能带回。完成两次生成后，从 CloudShell `Actions` → `Download file` 下载精确路径 `amplify/data/schema.sql.ts`，不通过共享 Git push 传输。放入本地 `RE/amplify-gen2-staging-implementation` 的同一路径后执行；`FSK_EXPECTED_SCHEMA_SHA256` 只填写 CloudShell 记录的第二次 SHA-256，不包含敏感值：

```bash
test "$(git branch --show-current)" = RE/amplify-gen2-staging-implementation
: "${FSK_EXPECTED_SCHEMA_SHA256:?use the second CloudShell schema checksum}"
test "$(shasum -a 256 amplify/data/schema.sql.ts | awk '{ print $1 }')" = \
  "$FSK_EXPECTED_SCHEMA_SHA256"
if rg -q 'postgres(?:ql)?://|[.]rds[.]amazonaws[.]com|arn:(aws|aws-cn|aws-us-gov):' \
  amplify/data/schema.sql.ts; then
  echo 'LOCAL_SCHEMA_SECRET_SCAN_FAILED' >&2
  exit 1
fi
```

只有 checksum、两次无差异和 CloudShell value-aware + 本地通用双重扫描均 PASS，才算“安全带回完成”。

| 证据字段 | 值 |
| --- | --- |
| Command | `pnpm exec ampx generate schema-from-database --connection-uri-secret SQL_CONNECTION_STRING --app-id <redacted-app-id> --branch staging --out amplify/data/schema.sql.ts` |
| Region | `ap-northeast-1` |
| FoundationStackId | `PENDING_DEPLOYMENT` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| BranchSecretName | `SQL_CONNECTION_STRING` |
| BranchSecretScope | `staging only` |
| BranchSecretMaskedConsoleEvidence | `PENDING_SCHEMA_GENERATION` |
| BranchSecretConfiguredBy | `PENDING_SCHEMA_GENERATION` |
| BranchSecretConfiguredAtJst | `PENDING_SCHEMA_GENERATION` |
| FirstGenerationExit | `PENDING_SCHEMA_GENERATION` |
| SecondGenerationExit | `PENDING_SCHEMA_GENERATION` |
| FirstSchemaSha256 | `PENDING_SCHEMA_GENERATION` |
| SecondSchemaSha256 | `PENDING_SCHEMA_GENERATION` |
| SecondGenerationByteDiff | `PENDING_SCHEMA_GENERATION` |
| CloudShellSecretScanResult | `PENDING_SCHEMA_GENERATION` |
| SafeTransferMethod | `PENDING_SCHEMA_GENERATION` |
| LocalChecksumMatch | `PENDING_SCHEMA_GENERATION` |
| LocalSecretScanResult | `PENDING_SCHEMA_GENERATION` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

### 4.3 立即删除临时出口，再删除 CloudShell/SG

安全带回完成后，先按逆序删除 Task 8 临时出口并做 residual check；此步骤必须发生在 CloudShell environment 和运维 SG 删除之前：

```bash
aws ec2 delete-route --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_A_ID" --destination-cidr-block 0.0.0.0/0
aws ec2 delete-route --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_B_ID" --destination-cidr-block 0.0.0.0/0
aws ec2 delete-nat-gateway --region ap-northeast-1 \
  --nat-gateway-id "$FSK_TEMP_NAT_GATEWAY_ID"
aws ec2 wait nat-gateway-deleted --region ap-northeast-1 \
  --nat-gateway-ids "$FSK_TEMP_NAT_GATEWAY_ID"
aws ec2 release-address --region ap-northeast-1 \
  --allocation-id "$FSK_TEMP_EIP_ALLOCATION_ID"
aws ec2 disassociate-route-table --region ap-northeast-1 \
  --association-id "$FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID"
aws ec2 delete-route-table --region ap-northeast-1 \
  --route-table-id "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID"
aws ec2 delete-subnet --region ap-northeast-1 \
  --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID"
aws ec2 detach-internet-gateway --region ap-northeast-1 \
  --internet-gateway-id "$FSK_TEMP_IGW_ID" --vpc-id "$FSK_VPC_ID"
aws ec2 delete-internet-gateway --region ap-northeast-1 \
  --internet-gateway-id "$FSK_TEMP_IGW_ID"
aws ec2 describe-nat-gateways --region ap-northeast-1 \
  --nat-gateway-ids "$FSK_TEMP_NAT_GATEWAY_ID" \
  --query 'NatGateways[].State'
aws ec2 describe-route-tables --region ap-northeast-1 \
  --route-table-ids "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID" \
  --query 'RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`]'
aws ec2 describe-internet-gateways --region ap-northeast-1 \
  --filters "Name=attachment.vpc-id,Values=${FSK_VPC_ID}" \
  --query 'InternetGateways[].InternetGatewayId'
```

期望临时 NAT 状态为 `deleted`、两个 application route table 的默认路由查询为空、VPC IGW attachment 查询为空。任一项不符合时状态置为 `BLOCKED`，先由 `CleanupOwner` 清理持续费用，不得继续。

出口复查 PASS 后，清除 CloudShell 临时文件和 shell 变量；Amplify branch secret 作为后续 full backend 所需受管 secret 暂时保留，但销毁时必须单独删除。随后在 CloudShell Console 进入 `VPC environments` → 选择 `fsk-staging-${FSK_CLOUDSHELL_TASK_ID}` → `Actions` → `Delete` 并等待从列表消失，再撤销 DB ingress、删除临时运维 SG：

```bash
aws ec2 revoke-security-group-ingress \
  --region ap-northeast-1 \
  --group-id "$FSK_DB_SECURITY_GROUP_ID" \
  --protocol tcp --port 5432 \
  --source-group "$FSK_OPS_SECURITY_GROUP_ID"
aws ec2 delete-security-group --region ap-northeast-1 \
  --group-id "$FSK_OPS_SECURITY_GROUP_ID"
aws ec2 describe-security-groups --region ap-northeast-1 \
  --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
    "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
  --query 'SecurityGroups[].GroupId'
aws ec2 describe-security-group-rules --region ap-northeast-1 \
  --filters "Name=group-id,Values=${FSK_DB_SECURITY_GROUP_ID}" \
  --query "SecurityGroupRules[?ReferencedGroupInfo.GroupId=='${FSK_OPS_SECURITY_GROUP_ID}'].SecurityGroupRuleId"
aws ec2 describe-nat-gateways --region ap-northeast-1 \
  --filter "Name=vpc-id,Values=${FSK_VPC_ID}" \
  --query 'NatGateways[?State!=`deleted`].NatGatewayId'
```

三个查询必须返回空数组，且 CloudShell environment 已从列表消失。证据缺一不可；未确认清理不得进入 full backend deploy。

| 清理证据字段 | 值 |
| --- | --- |
| TemporaryEgressDeletedAtJst | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressDeletionEvidence | `PENDING_SCHEMA_GENERATION` |
| ApplicationDefaultRouteResidualQuery | `PENDING_SCHEMA_GENERATION` |
| InternetGatewayResidualQuery | `PENDING_SCHEMA_GENERATION` |
| CloudShellEnvironmentDeletedAtJst | `PENDING_CLOUDSHELL` |
| CloudShellDeleteBeforeScreenshotPath | `PENDING_CLOUDSHELL` |
| CloudShellDeleteAfterScreenshotPath | `PENDING_CLOUDSHELL` |
| DbIngressRevokedAtJst | `PENDING_CLOUDSHELL` |
| OperationsSecurityGroupDeletedAtJst | `PENDING_CLOUDSHELL` |
| TaggedSecurityGroupResidualQuery | `PENDING_CLOUDSHELL` |
| ReferencedIngressResidualQuery | `PENDING_CLOUDSHELL` |
| ActiveNatGatewayResidualQuery | `PENDING_CLOUDSHELL` |
| CleanupOwner | `PENDING_USER_APPROVAL` |

## 5. Stage 3 — full backend deploy（独立审批门）

先展示最终 backend diff、AppSync/SQL Lambda/业务 Functions/日志资源和更新后的成本表。只有用户明确批准第二次全栈 AWS 写入后才执行：

```bash
AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id "$AMPLIFY_APP_ID" --outputs-out-dir apps/web/public
```

| 证据字段 | 值 |
| --- | --- |
| FullBackendApprovalId | `PENDING_USER_APPROVAL` |
| Command | `AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 CI=1 pnpm exec ampx pipeline-deploy --branch staging --app-id <redacted-app-id> --outputs-out-dir apps/web/public` |
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

### 7.1 Amplify App/branch、branch secret 与远程 `staging` 的销毁责任

Task 7 创建的 Amplify App/branch、Task 8 的 `SQL_CONNECTION_STRING` branch secret，以及 §2.1 的远程 `staging` ref 都由审批记录中的 `CleanupOwner` 负责，但**任何一个都不自动删除**。删除需要独立销毁审批，并按以下顺序逐项留证：

1. 停止/关闭新 build，记录最后一个 job ID/status/commit；从 App home → `Hosting` → `Secrets` → `Manage secrets` 对 `staging` scope 的 `SQL_CONNECTION_STRING` 选择 `Remove`，只保存 masked 删除证据。
2. 用精确 App ID/branch ARN 在 Amplify Console 删除 `staging` branch/backend，再按销毁计划处理 App、CloudFormation stacks、保留的 S3 versions/snapshots；`keepOnDelete` 资源不能假定随 stack 消失。
3. AWS 资源清理和残留检查完成后，才处理共享 Git ref。先从最近一次批准的部署证据取得 `FSK_EXPECTED_REMOTE_STAGING_COMMIT`；只读结果不精确匹配时 `STOP`，不得删除他人更新。匹配时才执行非 force 的 branch delete，并再次只读确认 ref 不存在：

```bash
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_EXPECTED_REMOTE_STAGING_COMMIT:?use the latest approved remote commit evidence}"
FSK_REMOTE_STAGING_BEFORE_DELETE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging |
    awk 'NR == 1 { print $1 }'
)"
if [ "$FSK_REMOTE_STAGING_BEFORE_DELETE" != "$FSK_EXPECTED_REMOTE_STAGING_COMMIT" ]; then
  echo 'REMOTE_STAGING_DELETE_GUARD_MISMATCH_STOP' >&2
  exit 1
fi
git push "$FSK_GIT_REMOTE" --delete staging
FSK_REMOTE_STAGING_AFTER_DELETE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging |
    awk 'NR == 1 { print $1 }'
)"
test -z "$FSK_REMOTE_STAGING_AFTER_DELETE"
```

远程 ref 删除是单独的共享 Git 写入，不因 Amplify branch auto-disconnection、App 删除或 stack 销毁自动获得授权。记录销毁 Approval ID、App/branch IDs、secret 删除证据、删除前 commit、Git actor、JST 时间、push exit 和删除后 `ls-remote` 空结果。

| 销毁证据字段 | 值 |
| --- | --- |
| DestroyApprovalId | `PENDING_USER_APPROVAL` |
| DestroyCleanupOwner | `PENDING_USER_APPROVAL` |
| AmplifyAppId | `PENDING_DESTROY_GATE` |
| AmplifyBranchArn | `PENDING_DESTROY_GATE` |
| FinalJobIdStatusCommit | `PENDING_DESTROY_GATE` |
| BranchSecretRemovedMaskedEvidence | `PENDING_DESTROY_GATE` |
| AmplifyBranchDeletedAtJst | `PENDING_DESTROY_GATE` |
| ExpectedRemoteStagingCommit | `PENDING_DESTROY_GATE` |
| RemoteBranchDeletedBy | `PENDING_DESTROY_GATE` |
| RemoteBranchDeletedAtJst | `PENDING_DESTROY_GATE` |
| RemoteDeletePushEvidence | `PENDING_DESTROY_GATE` |
| RemotePostDeleteLsRemote | `PENDING_DESTROY_GATE` |

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
