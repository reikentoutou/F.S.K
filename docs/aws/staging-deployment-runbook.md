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

1. Task 7 批准后建立并核对远程 `fsk-staging-foundation-v1` tag 与 `staging` Git ref；
2. Amplify Console `Save and deploy` bootstrap foundation job，并立即关闭 Auto build；
3. 本地 `pipeline-deploy` 对 foundation 做权威、幂等 reconciliation；
4. Task 8 单独批准临时 CloudShell VPC 访问和临时 NAT；
5. migration 首次执行、第二次 no-op 和 verify；
6. 设置 branch secret、两次生成 schema、无差异核对并安全带回；
7. 立即删除临时出口，再删除 CloudShell environment、DB ingress 和运维 Security Group；
8. full backend deploy；
9. Hosting build。

不得跳步或并行推进。§2.1 的共享 Git 写入和首次 AWS 写入都必须等到 Task 7 批准；执行前展示 [`staging-cost-approval.md`](./staging-cost-approval.md) 的资源表和 `MonthlyCeilingJpy`，并取得用户对“建立不可变 remote foundation tag、建立远程 staging ref、首次 staging AWS 写入及该月上限”的明确批准。完整 backend、Task 8 临时访问、Budget/alarms 和销毁分别有独立审批门。

共同约束：只允许 account `444083008754`、region `ap-northeast-1` 和 staging；不创建或复用 production；不读取真实 SQLite、用户 hash、备份或 uploads；不得记录密码、Token、Secret 值、连接串或 Cognito CSV。Storage key 在所有后续 Function 中保持 opaque，所有权验证前后都不得 percent-decode。

`amplify/backend.foundation.ts` 在 synth 开始前要求 `AWS_REGION` 和 `AWS_DEFAULT_REGION` 同时精确为 `ap-northeast-1`；缺失或漂移会以 `STAGING_REGION_MISMATCH` fail-fast。所有 deploy 命令必须使用本 runbook 给出的显式 region 环境变量，不能依赖操作者本机 profile 的默认值。

## 1. 首次 AWS 写入前只读预检

以下命令只读，但仍需核对当前登录身份。只要 account/region/资源冲突不符合预期，就停止，不复用未知资源。

```bash
set -euo pipefail
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

此步骤不是本地准备动作，而是 Task 7 明确批准后才允许执行的共享 Git 写入；它发生在首次打开 Amplify Console 创建 App **之前**。先把本地 lightweight `fsk-staging-foundation-v1` tag 以同名 immutable remote tag 建立，再从其 peeled commit 建立远程 `staging`；不创建、不推送也不连接 `main`，禁止通用 force push。tag/head 唯一允许的 empty lease 冒号后都为空，表示“只有目标 ref 仍不存在才创建”，不是覆盖已有 ref 的通用 force。先只读核对；任一远程 ref 已存在但不等于 foundation commit 时立即 `STOP`，不得覆盖：

```bash
set -euo pipefail
: "${FSK_GIT_REMOTE:=origin}"
FSK_FOUNDATION_TAG=fsk-staging-foundation-v1
FSK_FOUNDATION_TAG_REF="refs/tags/${FSK_FOUNDATION_TAG}"
FSK_FOUNDATION_COMMIT="$(git rev-parse 'fsk-staging-foundation-v1^{commit}')"
test "$(git cat-file -t "$FSK_FOUNDATION_TAG")" = commit
FSK_REMOTE_FOUNDATION_TAG_LINE="$(
  git ls-remote --tags "$FSK_GIT_REMOTE" "$FSK_FOUNDATION_TAG_REF"
)"
FSK_REMOTE_FOUNDATION_TAG_COUNT="$(
  printf '%s\n' "$FSK_REMOTE_FOUNDATION_TAG_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_REMOTE_FOUNDATION_TAG_COUNT" -le 1
if [ "$FSK_REMOTE_FOUNDATION_TAG_COUNT" -eq 1 ]; then
  FSK_REMOTE_FOUNDATION_TAG_COMMIT="$(
    printf '%s\n' "$FSK_REMOTE_FOUNDATION_TAG_LINE" |
      awk 'NR == 1 { print $1 }'
  )"
  test "$FSK_REMOTE_FOUNDATION_TAG_COMMIT" = "$FSK_FOUNDATION_COMMIT"
  FSK_REMOTE_FOUNDATION_TAG_ACTION=ALREADY_EXACT_NO_PUSH
else
  if git push \
    "--force-with-lease=${FSK_FOUNDATION_TAG_REF}:" \
    "$FSK_GIT_REMOTE" \
    "${FSK_FOUNDATION_TAG_REF}:${FSK_FOUNDATION_TAG_REF}"; then
    FSK_REMOTE_FOUNDATION_TAG_ACTION=CREATED_EMPTY_LEASE
  else
    echo 'REMOTE_FOUNDATION_TAG_CREATE_RACE_OR_PUSH_FAILED_STOP' >&2
    exit 1
  fi
fi
FSK_VERIFIED_REMOTE_FOUNDATION_TAG_LINE="$(
  git ls-remote --tags "$FSK_GIT_REMOTE" "$FSK_FOUNDATION_TAG_REF"
)"
FSK_VERIFIED_REMOTE_FOUNDATION_TAG_COUNT="$(
  printf '%s\n' "$FSK_VERIFIED_REMOTE_FOUNDATION_TAG_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_VERIFIED_REMOTE_FOUNDATION_TAG_COUNT" -eq 1
FSK_VERIFIED_REMOTE_FOUNDATION_TAG_COMMIT="$(
  printf '%s\n' "$FSK_VERIFIED_REMOTE_FOUNDATION_TAG_LINE" |
    awk 'NR == 1 { print $1 }'
)"
test "$FSK_VERIFIED_REMOTE_FOUNDATION_TAG_COMMIT" = "$FSK_FOUNDATION_COMMIT"

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
  if git push --force-with-lease=refs/heads/staging: \
    "$FSK_GIT_REMOTE" \
    "${FSK_FOUNDATION_COMMIT}:refs/heads/staging"; then
    FSK_REMOTE_STAGING_ACTION=CREATED_EMPTY_LEASE
  else
    echo 'REMOTE_STAGING_CREATE_RACE_OR_PUSH_FAILED_STOP' >&2
    exit 1
  fi
fi

FSK_VERIFIED_REMOTE_STAGING_LINE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging
)"
FSK_VERIFIED_REMOTE_STAGING_COUNT="$(
  printf '%s\n' "$FSK_VERIFIED_REMOTE_STAGING_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_VERIFIED_REMOTE_STAGING_COUNT" -eq 1
FSK_VERIFIED_REMOTE_STAGING_COMMIT="$(
  printf '%s\n' "$FSK_VERIFIED_REMOTE_STAGING_LINE" |
    awk 'NR == 1 { print $1 }'
)"
test "$FSK_VERIFIED_REMOTE_STAGING_COMMIT" = "$FSK_FOUNDATION_COMMIT"
FSK_REMOTE_BRANCH_ACTOR="$(git config user.name)"
: "${FSK_REMOTE_BRANCH_ACTOR:?configure an audited Git actor name}"
FSK_REMOTE_BRANCH_VERIFIED_AT_JST="$(TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z')"
```

若任一创建 push 因竞态失败，必须立即 `STOP` 并从对应第一条 `ls-remote` 重新审计，不能重试为普通 force。remote tag/head actions、push 输出、最终只读 commits、Git actor 和 JST 时间写入证据；不得记录凭据化 remote URL。remote foundation tag 是后续 CloudShell 可复现输入，保持 immutable；远程 `staging` 是共享 ref，Amplify App/branch 删除不会自动授权删除它；销毁流程见 §7。

### 2.2 Console bootstrap job 与立即关闭 Auto build

在 Task 7 审批、§2.1 远程 commit 验证都完成后，确认 Amplify Console 右上角 region 为 `ap-northeast-1`，再执行：`All apps` → `Create new app` → 选择已批准的 Git provider/repository → App name 输入 `fsk-staging` → 只选择 `staging` → `Save and deploy`。标准 Git 连接流程会先启动一个 bootstrap job，不能假装 App 创建时没有部署；该 job 就是 Task 7 已批准的首次 AWS write，必须只处理 foundation commit。

`Save and deploy` 前再次在页面核对 branch/commit；启动后立即记录 App ID、branch ARN 和 job ID，然后进入 `App settings` → `Branch settings` → `Edit`，关闭 `staging` 的 Auto build，同时保持 Branch auto-detection、auto-disconnection 和 PR preview 全部关闭。随后使用下列只读命令核对 job；commit 必须等于 §2.1 的 foundation commit：

```bash
set -euo pipefail
: "${AMPLIFY_APP_ID:?record the new Amplify App ID}"
: "${AMPLIFY_BOOTSTRAP_JOB_ID:?record the Save and deploy job ID}"
: "${FSK_FOUNDATION_COMMIT:?reuse the verified foundation commit evidence}"
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
    CREATED|PENDING|PROVISIONING|RUNNING)
      if ! aws amplify stop-job \
        --region ap-northeast-1 \
        --app-id "$AMPLIFY_APP_ID" \
        --branch-name staging \
        --job-id "$AMPLIFY_BOOTSTRAP_JOB_ID"; then
        echo 'BOOTSTRAP_STOP_JOB_FAILED_AUDIT_REQUIRED' >&2
      fi
      ;;
  esac
  echo 'BOOTSTRAP_COMMIT_MISMATCH_STOP_AND_AUDIT' >&2
  exit 1
fi
```

若 commit 漂移，或 job/CloudFormation 预览出现 Amplify Data/AppSync、业务 Function、generated SQL schema、`main`/production 引用，立即停止。AWS Amplify JobStatus 枚举为 `CREATED`、`PENDING`、`PROVISIONING`、`RUNNING`、`FAILED`、`SUCCEED`、`CANCELLING`、`CANCELLED`；前四个活动态用 `stop-job --app-id --branch-name --job-id` 请求停止。无论状态是否 terminal、`stop-job` 是否成功，commit mismatch 分支都会以非零退出并进入 unexpected-resource audit，绝不能继续 controlled deploy。job 已结束或正在 `CANCELLING` 时不擅自删除资源，状态置为 `BLOCKED` 并进入审计/独立销毁审批。通过 Console 或重复只读 `get-job` 取得 terminal status；只有 bootstrap job 为 `SUCCEED`、commit 精确且 foundation-only 核对通过，才能继续。

| 证据字段 | 值 |
| --- | --- |
| ApprovalId | `PENDING_USER_APPROVAL` |
| MonthlyCeilingJpy | `PENDING_USER_APPROVAL` |
| Region | `ap-northeast-1` |
| GitRemote | `PENDING_TASK7_GIT_WRITE` |
| RemoteFoundationTag | `fsk-staging-foundation-v1` |
| RemoteFoundationTagCommit | `PENDING_TASK7_GIT_WRITE` |
| RemoteFoundationTagAction | `EXISTING_EXACT_OR_CREATED_EMPTY_LEASE` |
| RemoteBranchName | `staging` |
| FoundationCommit | `PENDING_TASK7_GIT_WRITE` |
| RemoteBranchCommit | `PENDING_TASK7_GIT_WRITE` |
| RemoteBranchAction | `EXISTING_EXACT_OR_CREATED_EMPTY_LEASE` |
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
set -euo pipefail
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
set -euo pipefail
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

Task 8 使用两个明确的 shell 角色：

- **control session**：`ap-northeast-1` 的普通 CloudShell，负责创建临时出口、轮询任务状态并**独占执行 EC2 cleanup/residual check**；不得关闭该 tab；
- **worker session**：出口可用后打开的 VPC CloudShell environment，负责源码准备、migration、secret 门、schema generation 和安全带回；从 worker arm 到 §4.3 必须是同一个持久 shell。worker 不删除自己的默认路由，失败时通过 foundation 已有的 SSM Interface Endpoint 写入非敏感失败状态，由 control 立即清理。

两个 session 之间通过 `/fsk/staging/task8/<TaskId>/worker-status`、`/control-status` 和 `/state` 三个临时 SSM `String` parameters 只传递任务状态、资源 ID/marker、deadline、foundation commit 和 checksum 这些非敏感状态。worker-status 只有 worker 更新；control-status 与 state 只有 control 更新。parameters 必须带本项目四个标签和 `TaskId`，并纳入 Task 8 独立写入批准。不得传递或保存 Secret value、username/password、endpoint 或连接串。每次 AWS mutation 后立即覆盖 state；cleanup 同时按 `TaskId` 标签发现 NAT/EIP/route table/subnet/IGW，并反查 application route target、route association 和 IGW attachment，所以即使服务端成功但响应丢失，也不依赖单一 shell 变量。若 control session 丢失，`CleanupOwner` 必须用 TaskId 在新的普通 CloudShell 恢复 guard 并清理，不能把 shell 丢失解释为已清理。

批准必须给出数值 Unix operation deadline `$FSK_TEMP_EGRESS_DEADLINE_EPOCH`、更晚但仍有明确上限的 cleanup deadline `$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH` 和具名 `$FSK_TEMP_EGRESS_CLEANUP_OWNER`。两个 deadline 都不得晚于审批所列的 operation/cleanup 最大持续时间；CleanupOwner 必须在独立计时器中登记 cleanup deadline，并在到期时主动进入普通 CloudShell 复查。control watchdog 每 15 秒轮询 worker-status，看到 worker `FAILED:*`、`READY_FOR_CLEANUP`、连续三次状态读取失败或 operation deadline 到达，就直接运行 cleanup，不依赖 worker 前台命令是否返回。worker 的 git/pnpm/migration/generation 命令使用 operation deadline 派生的 GNU `timeout`；不使用 `--foreground`，让 timeout 控制独立 process group 并向 pnpm/Node 子树发送 TERM/KILL。

先在 control session 通过只读 VPC/subnet/route-table 查询选择未使用的 `$FSK_TEMP_PUBLIC_CIDR`、`$FSK_TEMP_AZ` 和两个 application route table IDs，并确认两个 application route tables 当前都没有 `0.0.0.0/0` route。control 首次执行下列初始化前必须 `export FSK_TASK8_SHELL_ROLE=control`；worker 稍后在自己的持久 session 恢复相同的非敏感批准字段、`export FSK_TASK8_SHELL_ROLE=worker` 后重跑同一 fence。临时资源变量使用 `${VAR:-}`；恢复 control 可以保持空值，cleanup 会以 TaskId 标签发现资源，不以 state 中的单一 ID 作为唯一事实来源。role guard 只在 control 定义 EC2 cleanup，在 worker 只定义失败通知，避免 worker 拥有或调用删除自身 route 的函数：

```bash
set -euo pipefail
export AWS_REGION=ap-northeast-1
export AWS_DEFAULT_REGION=ap-northeast-1
test "$AWS_REGION" = ap-northeast-1
test "$AWS_DEFAULT_REGION" = ap-northeast-1
: "${FSK_CLOUDSHELL_TASK_ID:?set the approved Task 8 id}"
: "${FSK_VPC_ID:?set the exact Foundation VpcId output}"
: "${FSK_APP_ROUTE_TABLE_A_ID:?set application route table A}"
: "${FSK_APP_ROUTE_TABLE_B_ID:?set application route table B}"
: "${FSK_FOUNDATION_COMMIT:?restore the verified foundation commit evidence}"
: "${FSK_TEMP_EGRESS_DEADLINE_EPOCH:?set the approved Unix deadline}"
: "${FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH:?set the approved cleanup Unix deadline}"
: "${FSK_TEMP_EGRESS_CLEANUP_OWNER:?set the approved cleanup owner}"
: "${FSK_TASK8_SHELL_ROLE:?set control or worker for this CloudShell session}"
case "$FSK_TEMP_EGRESS_DEADLINE_EPOCH" in
  ''|*[!0-9]*) echo 'TEMP_EGRESS_DEADLINE_INVALID_STOP' >&2; exit 1 ;;
esac
case "$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" in
  ''|*[!0-9]*) echo 'TEMP_EGRESS_CLEANUP_DEADLINE_INVALID_STOP' >&2; exit 1 ;;
esac
if [ "$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" -le \
  "$FSK_TEMP_EGRESS_DEADLINE_EPOCH" ]; then
  echo 'TEMP_EGRESS_CLEANUP_DEADLINE_ORDER_INVALID_STOP' >&2
  exit 1
fi
case "$FSK_TASK8_SHELL_ROLE" in
  control|worker) ;;
  *) echo 'TASK8_SHELL_ROLE_INVALID_STOP' >&2; exit 1 ;;
esac

FSK_TEMP_IGW_ID="${FSK_TEMP_IGW_ID:-}"
FSK_TEMP_IGW_ATTACHED="${FSK_TEMP_IGW_ATTACHED:-0}"
FSK_TEMP_PUBLIC_SUBNET_ID="${FSK_TEMP_PUBLIC_SUBNET_ID:-}"
FSK_TEMP_PUBLIC_ROUTE_TABLE_ID="${FSK_TEMP_PUBLIC_ROUTE_TABLE_ID:-}"
FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID="${FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID:-}"
FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED="${FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED:-0}"
FSK_TEMP_EIP_ALLOCATION_ID="${FSK_TEMP_EIP_ALLOCATION_ID:-}"
FSK_TEMP_NAT_GATEWAY_ID="${FSK_TEMP_NAT_GATEWAY_ID:-}"
FSK_TEMP_APP_ROUTE_A_CREATED="${FSK_TEMP_APP_ROUTE_A_CREATED:-0}"
FSK_TEMP_APP_ROUTE_B_CREATED="${FSK_TEMP_APP_ROUTE_B_CREATED:-0}"
FSK_TEMP_EGRESS_CLEANUP_RUNNING=0
FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID="${FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID:-}"
FSK_TEMP_EGRESS_CONTROL_PARENT_PID="${FSK_TEMP_EGRESS_CONTROL_PARENT_PID:-}"
FSK_TEMP_EGRESS_PENDING_SIGNAL_STATUS=0
FSK_TASK8_WORKER_STATUS_PARAMETER="/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}/worker-status"
FSK_TASK8_CONTROL_STATUS_PARAMETER="/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}/control-status"
FSK_TASK8_STATE_PARAMETER="/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}/state"
command -v timeout >/dev/null

fsk_assert_temp_egress_deadline() {
  if [ "$(date +%s)" -ge "$FSK_TEMP_EGRESS_DEADLINE_EPOCH" ]; then
    echo 'TEMP_EGRESS_DEADLINE_EXCEEDED_CLEANUP_REQUIRED' >&2
    return 124
  fi
}

fsk_seconds_before_temp_egress_deadline() {
  local remaining
  remaining=$((FSK_TEMP_EGRESS_DEADLINE_EPOCH - $(date +%s)))
  if [ "$remaining" -le 0 ]; then
    echo 'TEMP_EGRESS_DEADLINE_EXCEEDED_CLEANUP_REQUIRED' >&2
    return 124
  fi
  printf '%s\n' "$remaining"
}

fsk_run_before_temp_egress_deadline() {
  local remaining
  remaining="$(fsk_seconds_before_temp_egress_deadline)"
  timeout --signal=TERM --kill-after=10 "$remaining" "$@"
}

if [ "$FSK_TASK8_SHELL_ROLE" = control ]; then
fsk_put_task8_control_status() {
  local value="${1:?control status value required}"
  timeout --signal=TERM --kill-after=5 20 \
    aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
      --type String --value "$value" --overwrite \
      --query Version --output text >/dev/null
}
fi

if [ "$FSK_TASK8_SHELL_ROLE" = worker ]; then
fsk_put_task8_worker_status() {
  local value="${1:?worker status value required}"
  timeout --signal=TERM --kill-after=5 20 \
    aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
      --type String --value "$value" --overwrite \
      --query Version --output text >/dev/null
}
fi

if [ "$FSK_TASK8_SHELL_ROLE" = control ]; then
fsk_persist_temp_egress_state() {
  local state
  state="$(
    FSK_TEMP_IGW_ID="${FSK_TEMP_IGW_ID:-}" \
    FSK_TEMP_PUBLIC_SUBNET_ID="${FSK_TEMP_PUBLIC_SUBNET_ID:-}" \
    FSK_TEMP_PUBLIC_ROUTE_TABLE_ID="${FSK_TEMP_PUBLIC_ROUTE_TABLE_ID:-}" \
    FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID="${FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID:-}" \
    FSK_TEMP_EIP_ALLOCATION_ID="${FSK_TEMP_EIP_ALLOCATION_ID:-}" \
    FSK_TEMP_NAT_GATEWAY_ID="${FSK_TEMP_NAT_GATEWAY_ID:-}" \
    FSK_TEMP_IGW_ATTACHED="${FSK_TEMP_IGW_ATTACHED:-0}" \
    FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED="${FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED:-0}" \
    FSK_TEMP_APP_ROUTE_A_CREATED="${FSK_TEMP_APP_ROUTE_A_CREATED:-0}" \
    FSK_TEMP_APP_ROUTE_B_CREATED="${FSK_TEMP_APP_ROUTE_B_CREATED:-0}" \
    FSK_CLOUDSHELL_TASK_ID="$FSK_CLOUDSHELL_TASK_ID" \
    FSK_VPC_ID="$FSK_VPC_ID" \
    FSK_APP_ROUTE_TABLE_A_ID="$FSK_APP_ROUTE_TABLE_A_ID" \
    FSK_APP_ROUTE_TABLE_B_ID="$FSK_APP_ROUTE_TABLE_B_ID" \
    FSK_TEMP_EGRESS_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_DEADLINE_EPOCH" \
    FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" \
    FSK_FOUNDATION_COMMIT="$FSK_FOUNDATION_COMMIT" \
    node -e '
      const keys = [
        "FSK_CLOUDSHELL_TASK_ID",
        "FSK_VPC_ID",
        "FSK_APP_ROUTE_TABLE_A_ID",
        "FSK_APP_ROUTE_TABLE_B_ID",
        "FSK_TEMP_EGRESS_DEADLINE_EPOCH",
        "FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH",
        "FSK_FOUNDATION_COMMIT",
        "FSK_TEMP_IGW_ID",
        "FSK_TEMP_PUBLIC_SUBNET_ID",
        "FSK_TEMP_PUBLIC_ROUTE_TABLE_ID",
        "FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID",
        "FSK_TEMP_EIP_ALLOCATION_ID",
        "FSK_TEMP_NAT_GATEWAY_ID",
        "FSK_TEMP_IGW_ATTACHED",
        "FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED",
        "FSK_TEMP_APP_ROUTE_A_CREATED",
        "FSK_TEMP_APP_ROUTE_B_CREATED",
      ];
      const state = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? ""]));
      process.stdout.write(JSON.stringify({ version: 1, ...state }));
    '
  )"
  FSK_TASK8_STATE_PARAMETER_VERSION="$(
    fsk_run_before_temp_egress_deadline aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$FSK_TASK8_STATE_PARAMETER" \
      --type String --value "$state" --overwrite \
      --query Version --output text
  )"
  case "$FSK_TASK8_STATE_PARAMETER_VERSION" in
    ''|*[!0-9]*) echo 'TASK8_STATE_VERSION_INVALID_STOP' >&2; return 1 ;;
  esac
}

fsk_persist_cleanup_result() {
  local result="${1:?cleanup result required}"
  local state
  state="$(
    FSK_CLEANUP_RESULT="$result" \
    FSK_APP_ROUTE_COUNT="${FSK_TEMP_EGRESS_APP_ROUTE_RESIDUAL_COUNT:-UNKNOWN}" \
    FSK_NAT_COUNT="${FSK_TEMP_EGRESS_NAT_RESIDUAL_COUNT:-UNKNOWN}" \
    FSK_EIP_COUNT="${FSK_TEMP_EGRESS_EIP_RESIDUAL_COUNT:-UNKNOWN}" \
    FSK_ROUTE_TABLE_COUNT="${FSK_TEMP_EGRESS_ROUTE_TABLE_RESIDUAL_COUNT:-UNKNOWN}" \
    FSK_SUBNET_COUNT="${FSK_TEMP_EGRESS_SUBNET_RESIDUAL_COUNT:-UNKNOWN}" \
    FSK_IGW_COUNT="${FSK_TEMP_EGRESS_IGW_RESIDUAL_COUNT:-UNKNOWN}" \
    FSK_CLEANUP_ATTEMPTS="${FSK_TEMP_EGRESS_CLEANUP_ATTEMPTS:-UNKNOWN}" \
    FSK_STABLE_ZERO_OBSERVATIONS="${FSK_TEMP_EGRESS_STABLE_ZERO_OBSERVATIONS:-UNKNOWN}" \
    node -e '
      const names = {
        applicationRouteCount: "FSK_APP_ROUTE_COUNT",
        natGatewayCount: "FSK_NAT_COUNT",
        elasticIpCount: "FSK_EIP_COUNT",
        routeTableCount: "FSK_ROUTE_TABLE_COUNT",
        subnetCount: "FSK_SUBNET_COUNT",
        internetGatewayCount: "FSK_IGW_COUNT",
      };
      const counts = Object.fromEntries(
        Object.entries(names).map(([key, env]) => [key, process.env[env] ?? "UNKNOWN"]),
      );
      process.stdout.write(JSON.stringify({
        version: 1,
        cleanupResult: process.env.FSK_CLEANUP_RESULT,
        cleanupAttempts: process.env.FSK_CLEANUP_ATTEMPTS,
        stableZeroObservations: process.env.FSK_STABLE_ZERO_OBSERVATIONS,
        counts,
      }));
    '
  )"
  timeout --signal=TERM --kill-after=5 20 \
    aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$FSK_TASK8_STATE_PARAMETER" \
      --type String --value "$state" --overwrite \
      --query Version --output text >/dev/null
}

fsk_run_before_cleanup_deadline() {
  local requested="${1:?per-command timeout required}"
  local remaining
  local limit
  shift
  remaining=$((FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH - $(date +%s)))
  if [ "$remaining" -le 0 ]; then
    echo 'TEMP_EGRESS_CLEANUP_DEADLINE_EXCEEDED_OWNER_REQUIRED' >&2
    return 124
  fi
  limit="$requested"
  if [ "$remaining" -lt "$limit" ]; then limit="$remaining"; fi
  timeout --signal=TERM --kill-after=10 "$limit" "$@"
}

fsk_cleanup_temp_egress_once() {
  local had_errexit=0
  local cleanup_failed=0
  local value=''
  local residual_total=0
  local nat_ids=''
  local eip_ids=''
  local route_table_ids=''
  local subnet_ids=''
  local igw_ids=''
  local association_ids=''
  local attachment_vpc_ids=''
  local route_target=''
  local id=''
  local candidate=''
  FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=0

  if [ "${FSK_TEMP_EGRESS_CLEANUP_RUNNING:-0}" -eq 1 ]; then
    return 0
  fi
  FSK_TEMP_EGRESS_CLEANUP_RUNNING=1
  case "$-" in *e*) had_errexit=1 ;; esac
  set +e

  if nat_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-nat-gateways \
    --region ap-northeast-1 \
    --filter "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)"; then
    :
  else
    cleanup_failed=1
    nat_ids=''
  fi
  if [ -n "${FSK_TEMP_NAT_GATEWAY_ID:-}" ]; then
    case " $nat_ids " in
      *" ${FSK_TEMP_NAT_GATEWAY_ID} "*) ;;
      *) nat_ids="$nat_ids ${FSK_TEMP_NAT_GATEWAY_ID}" ;;
    esac
  fi

  for id in "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID"; do
    if route_target="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-route-tables \
      --region ap-northeast-1 --route-table-ids "$id" \
      --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId | [0]' \
      --output text)"; then
      for candidate in $nat_ids; do
        if [ "$route_target" = "$candidate" ]; then
          FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
          fsk_run_before_cleanup_deadline 30 aws ec2 delete-route --region ap-northeast-1 \
            --route-table-id "$id" \
            --destination-cidr-block 0.0.0.0/0 >/dev/null 2>&1 || true
        fi
      done
    else
      cleanup_failed=1
    fi
  done

  for id in $nat_ids; do
    [ "$id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-nat-gateway --region ap-northeast-1 \
      --nat-gateway-id "$id" >/dev/null 2>&1 || true
    fsk_run_before_cleanup_deadline 900 \
      aws ec2 wait nat-gateway-deleted --region ap-northeast-1 \
        --nat-gateway-ids "$id" >/dev/null 2>&1 || cleanup_failed=1
  done

  if eip_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-addresses \
    --region ap-northeast-1 \
    --filters "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'Addresses[].AllocationId' --output text)"; then
    :
  else
    cleanup_failed=1
    eip_ids=''
  fi
  if [ -n "${FSK_TEMP_EIP_ALLOCATION_ID:-}" ]; then
    case " $eip_ids " in
      *" ${FSK_TEMP_EIP_ALLOCATION_ID} "*) ;;
      *) eip_ids="$eip_ids ${FSK_TEMP_EIP_ALLOCATION_ID}" ;;
    esac
  fi
  for id in $eip_ids; do
    [ "$id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    fsk_run_before_cleanup_deadline 30 aws ec2 release-address --region ap-northeast-1 \
      --allocation-id "$id" >/dev/null 2>&1 || true
  done

  if route_table_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-route-tables \
    --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'RouteTables[].RouteTableId' --output text)"; then
    :
  else
    cleanup_failed=1
    route_table_ids=''
  fi
  if [ -n "${FSK_TEMP_PUBLIC_ROUTE_TABLE_ID:-}" ]; then
    case " $route_table_ids " in
      *" ${FSK_TEMP_PUBLIC_ROUTE_TABLE_ID} "*) ;;
      *) route_table_ids="$route_table_ids ${FSK_TEMP_PUBLIC_ROUTE_TABLE_ID}" ;;
    esac
  fi
  for id in $route_table_ids; do
    [ "$id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    association_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-route-tables \
      --region ap-northeast-1 --route-table-ids "$id" \
      --query 'RouteTables[0].Associations[?Main==`false`].RouteTableAssociationId' \
      --output text)" || cleanup_failed=1
    for candidate in $association_ids; do
      [ "$candidate" = None ] && continue
      fsk_run_before_cleanup_deadline 30 aws ec2 disassociate-route-table --region ap-northeast-1 \
        --association-id "$candidate" >/dev/null 2>&1 || true
    done
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-route --region ap-northeast-1 \
      --route-table-id "$id" \
      --destination-cidr-block 0.0.0.0/0 >/dev/null 2>&1 || true
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-route-table --region ap-northeast-1 \
      --route-table-id "$id" >/dev/null 2>&1 || true
  done

  if subnet_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-subnets \
    --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'Subnets[].SubnetId' --output text)"; then
    :
  else
    cleanup_failed=1
    subnet_ids=''
  fi
  if [ -n "${FSK_TEMP_PUBLIC_SUBNET_ID:-}" ]; then
    case " $subnet_ids " in
      *" ${FSK_TEMP_PUBLIC_SUBNET_ID} "*) ;;
      *) subnet_ids="$subnet_ids ${FSK_TEMP_PUBLIC_SUBNET_ID}" ;;
    esac
  fi
  for id in $subnet_ids; do
    [ "$id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-subnet --region ap-northeast-1 \
      --subnet-id "$id" >/dev/null 2>&1 || true
  done

  if igw_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-internet-gateways \
    --region ap-northeast-1 \
    --filters "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'InternetGateways[].InternetGatewayId' --output text)"; then
    :
  else
    cleanup_failed=1
    igw_ids=''
  fi
  if [ -n "${FSK_TEMP_IGW_ID:-}" ]; then
    case " $igw_ids " in
      *" ${FSK_TEMP_IGW_ID} "*) ;;
      *) igw_ids="$igw_ids ${FSK_TEMP_IGW_ID}" ;;
    esac
  fi
  for id in $igw_ids; do
    [ "$id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    attachment_vpc_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-internet-gateways \
      --region ap-northeast-1 --internet-gateway-ids "$id" \
      --query 'InternetGateways[0].Attachments[].VpcId' --output text)" || \
      cleanup_failed=1
    for candidate in $attachment_vpc_ids; do
      [ "$candidate" = None ] && continue
      fsk_run_before_cleanup_deadline 30 aws ec2 detach-internet-gateway --region ap-northeast-1 \
        --internet-gateway-id "$id" --vpc-id "$candidate" \
        >/dev/null 2>&1 || true
    done
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-internet-gateway --region ap-northeast-1 \
      --internet-gateway-id "$id" >/dev/null 2>&1 || true
  done

  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-route-tables --region ap-northeast-1 \
    --route-table-ids "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID" \
    --query 'length(RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`][])' \
    --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_APP_ROUTE_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-nat-gateways --region ap-northeast-1 \
    --filter "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'length(NatGateways[?State!=`deleted`])' --output text)" && \
    [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_NAT_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-addresses --region ap-northeast-1 \
    --filters "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'length(Addresses)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_EIP_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-route-tables --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'length(RouteTables)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_ROUTE_TABLE_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-subnets --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'length(Subnets)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_SUBNET_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-internet-gateways --region ap-northeast-1 \
    --filters "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'length(InternetGateways)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_IGW_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi

  FSK_TEMP_EGRESS_RESIDUAL_TOTAL="$residual_total"
  if [ "$cleanup_failed" -ne 0 ] || [ "$residual_total" -ne 0 ]; then
    FSK_TEMP_EGRESS_CLEANUP_RUNNING=0
    if [ "$had_errexit" -eq 1 ]; then set -e; fi
    echo 'TEMP_EGRESS_CLEANUP_BLOCKED_RESIDUAL_OR_QUERY_FAILURE' >&2
    return 1
  fi
  FSK_TEMP_IGW_ID=''
  FSK_TEMP_IGW_ATTACHED=0
  FSK_TEMP_PUBLIC_SUBNET_ID=''
  FSK_TEMP_PUBLIC_ROUTE_TABLE_ID=''
  FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID=''
  FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED=0
  FSK_TEMP_EIP_ALLOCATION_ID=''
  FSK_TEMP_NAT_GATEWAY_ID=''
  FSK_TEMP_APP_ROUTE_A_CREATED=0
  FSK_TEMP_APP_ROUTE_B_CREATED=0
  FSK_TEMP_EGRESS_CLEANUP_RUNNING=0
  if [ "$had_errexit" -eq 1 ]; then set -e; fi
  echo 'TEMP_EGRESS_CLEANUP_PASS'
  return 0
}

fsk_cleanup_temp_egress() {
  local stable_zero_count=0
  local attempt=0
  local sleep_seconds=15
  while [ "$(date +%s)" -lt "$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" ]; do
    attempt=$((attempt + 1))
    if fsk_cleanup_temp_egress_once && \
      [ "${FSK_TEMP_EGRESS_RESIDUAL_TOTAL:-UNKNOWN}" = 0 ]; then
      if [ "${FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT:-1}" -eq 0 ]; then
        stable_zero_count=$((stable_zero_count + 1))
      else
        stable_zero_count=0
      fi
      if [ "$stable_zero_count" -ge 3 ]; then
        FSK_TEMP_EGRESS_CLEANUP_ATTEMPTS="$attempt"
        FSK_TEMP_EGRESS_STABLE_ZERO_OBSERVATIONS="$stable_zero_count"
        echo 'TEMP_EGRESS_CLEANUP_STABLE_ZERO_PASS'
        return 0
      fi
    else
      stable_zero_count=0
    fi
    if [ "$(( $(date +%s) + sleep_seconds ))" -ge \
      "$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" ]; then
      break
    fi
    sleep "$sleep_seconds"
  done
  FSK_TEMP_EGRESS_CLEANUP_ATTEMPTS="$attempt"
  FSK_TEMP_EGRESS_STABLE_ZERO_OBSERVATIONS="$stable_zero_count"
  echo 'TEMP_EGRESS_CLEANUP_RETRY_DEADLINE_BLOCKED_OWNER_REQUIRED' >&2
  return 1
}

fsk_control_exit() {
  local original_status="${1:-1}"
  local cleanup_status=0
  local pending_signal_status=0
  local control_status_before_cleanup=''
  local control_status_read=0
  trap - EXIT
  trap 'FSK_TEMP_EGRESS_PENDING_SIGNAL_STATUS=129' HUP
  trap 'FSK_TEMP_EGRESS_PENDING_SIGNAL_STATUS=130' INT TERM
  unset DATABASE_URL
  set +e
  if [ -n "${FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID:-}" ]; then
    kill "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID" >/dev/null 2>&1 || true
    wait "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID" >/dev/null 2>&1 || true
    FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID=''
  fi
  if control_status_before_cleanup="$(
    timeout --signal=TERM --kill-after=5 20 \
      aws ssm get-parameter \
        --region ap-northeast-1 \
        --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
        --query Parameter.Value --output text
  )"; then
    control_status_read=1
  fi
  fsk_cleanup_temp_egress
  cleanup_status=$?
  case "$control_status_before_cleanup" in
    CLEANUP_PASS:*|CLEANUP_BLOCKED:*)
      echo 'CONTROL_TERMINAL_STATUS_PRESERVED_DURING_EXIT_RECHECK'
      ;;
    CONTROL_ARMED)
      if [ "$cleanup_status" -eq 0 ]; then
        if fsk_persist_cleanup_result PASS; then
          fsk_put_task8_control_status \
            "CLEANUP_PASS:CONTROL_EXIT_${original_status}" || cleanup_status=1
        else
          cleanup_status=1
          fsk_put_task8_control_status \
            'CLEANUP_BLOCKED:EVIDENCE_WRITE_FAILED' || true
        fi
      else
        fsk_persist_cleanup_result BLOCKED || true
        fsk_put_task8_control_status \
          "CLEANUP_BLOCKED:CONTROL_EXIT_${original_status}" || true
      fi
      ;;
    *)
      cleanup_status=1
      if [ "$control_status_read" -eq 0 ]; then
        echo 'CONTROL_STATUS_READ_FAILED_PRESERVE_UNKNOWN_TERMINAL' >&2
      else
        echo 'CONTROL_STATUS_UNEXPECTED_PRESERVE_AND_AUDIT' >&2
      fi
      ;;
  esac
  if [ "$cleanup_status" -ne 0 ]; then
    echo 'TASK8_EXIT_CLEANUP_BLOCKED_OWNER_ACTION_REQUIRED' >&2
  fi
  pending_signal_status="${FSK_TEMP_EGRESS_PENDING_SIGNAL_STATUS:-0}"
  trap - HUP INT TERM
  if [ "$pending_signal_status" -ne 0 ]; then
    original_status="$pending_signal_status"
  fi
  if [ "$original_status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then
    original_status=1
  fi
  exit "$original_status"
}

fsk_control_watchdog() {
  local status=''
  local trigger=''
  local read_failures=0
  local cleanup_status=0
  set +e
  while :; do
    trigger=''
    if [ "$(date +%s)" -ge "$FSK_TEMP_EGRESS_DEADLINE_EPOCH" ]; then
      trigger=DEADLINE
    elif status="$(timeout --signal=TERM --kill-after=5 20 \
      aws ssm get-parameter \
      --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
      --query Parameter.Value --output text)"; then
      read_failures=0
      case "$status" in
        FAILED:*|READY_FOR_CLEANUP) trigger="$status" ;;
      esac
    else
      read_failures=$((read_failures + 1))
      if [ "$read_failures" -ge 3 ]; then
        trigger=STATUS_READ_FAILED
      fi
    fi

    if [ -n "$trigger" ]; then
      fsk_cleanup_temp_egress
      cleanup_status=$?
      if [ "$cleanup_status" -eq 0 ]; then
        if ! fsk_persist_cleanup_result PASS; then
          fsk_put_task8_control_status \
            'CLEANUP_BLOCKED:EVIDENCE_WRITE_FAILED' || true
          kill -TERM "$FSK_TEMP_EGRESS_CONTROL_PARENT_PID" \
            >/dev/null 2>&1 || true
          return 1
        fi
        if ! fsk_put_task8_control_status "CLEANUP_PASS:${trigger}"; then
          kill -TERM "$FSK_TEMP_EGRESS_CONTROL_PARENT_PID" \
            >/dev/null 2>&1 || true
          return 1
        fi
        if [ "$trigger" != READY_FOR_CLEANUP ]; then
          kill -TERM "$FSK_TEMP_EGRESS_CONTROL_PARENT_PID" >/dev/null 2>&1 || true
        fi
        return 0
      fi
      fsk_persist_cleanup_result BLOCKED || true
      fsk_put_task8_control_status "CLEANUP_BLOCKED:${trigger}" || true
      kill -TERM "$FSK_TEMP_EGRESS_CONTROL_PARENT_PID" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 15
  done
}

fi

if [ "$FSK_TASK8_SHELL_ROLE" = worker ]; then
fsk_worker_exit() {
  local original_status="${1:-1}"
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  unset DATABASE_URL
  if [ "$original_status" -ne 0 ]; then
    fsk_put_task8_worker_status "FAILED:WORKER_EXIT_${original_status}" || true
  else
    fsk_put_task8_worker_status 'FAILED:WORKER_UNEXPECTED_NORMAL_EXIT' || true
    original_status=1
  fi
  exit "$original_status"
}
fi
```

先只读确认 worker-status/control-status/state 三个 parameters 都不存在；发现任何同名参数必须零写入、零删除地 `STOP`。空值确认通过后生成非敏感 bootstrap ownership token，并在第一次 parameter 写入前安装 bootstrap trap。trap 只删除同时带本次 `BootstrapToken` 的参数，所以既能回收 response-loss 后实际已创建的参数，也绝不会删除竞态中由其他执行者创建的同名参数。三个参数都带四个项目标签、TaskId 和 ownership token；worker-status 只由 worker 更新，control-status/state 只由 control 更新，避免 read-then-overwrite 覆盖 terminal cleanup。全部创建成功后才切换为 control EXIT/INT/TERM trap 并启动 poller：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = control
declare -F fsk_control_exit >/dev/null
declare -F fsk_cleanup_temp_egress >/dev/null
fsk_assert_temp_egress_deadline
FSK_TASK8_WORKER_STATUS_PARAMETER_COUNT="$(
  fsk_run_before_temp_egress_deadline aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters \
      "Key=Name,Option=Equals,Values=${FSK_TASK8_WORKER_STATUS_PARAMETER}" \
    --query 'length(Parameters)' --output text
)"
FSK_TASK8_CONTROL_STATUS_PARAMETER_COUNT="$(
  fsk_run_before_temp_egress_deadline aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters \
      "Key=Name,Option=Equals,Values=${FSK_TASK8_CONTROL_STATUS_PARAMETER}" \
    --query 'length(Parameters)' --output text
)"
FSK_TASK8_STATE_PARAMETER_COUNT="$(
  fsk_run_before_temp_egress_deadline aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters \
      "Key=Name,Option=Equals,Values=${FSK_TASK8_STATE_PARAMETER}" \
    --query 'length(Parameters)' --output text
)"
test "$FSK_TASK8_WORKER_STATUS_PARAMETER_COUNT" -eq 0
test "$FSK_TASK8_CONTROL_STATUS_PARAMETER_COUNT" -eq 0
test "$FSK_TASK8_STATE_PARAMETER_COUNT" -eq 0

FSK_TASK8_BOOTSTRAP_TOKEN="$(
  fsk_run_before_temp_egress_deadline \
    node -e 'process.stdout.write(require("node:crypto").randomUUID())'
)"
case "$FSK_TASK8_BOOTSTRAP_TOKEN" in
  ????????-????-????-????-????????????) ;;
  *) echo 'TASK8_BOOTSTRAP_TOKEN_INVALID_STOP' >&2; exit 1 ;;
esac
fsk_delete_bootstrap_parameter_if_owned() {
  local parameter_name="${1:?parameter name required}"
  local owned_count
  owned_count="$(
    timeout --signal=TERM --kill-after=5 20 \
      aws ssm list-tags-for-resource \
        --region ap-northeast-1 \
        --resource-type Parameter \
        --resource-id "$parameter_name" \
        --query "length(TagList[?Key=='BootstrapToken' && Value=='${FSK_TASK8_BOOTSTRAP_TOKEN}'])" \
        --output text 2>/dev/null
  )" || return 0
  if [ "$owned_count" = 1 ]; then
    timeout --signal=TERM --kill-after=5 20 \
      aws ssm delete-parameter --region ap-northeast-1 \
        --name "$parameter_name" >/dev/null 2>&1 || true
  fi
}
fsk_control_parameter_bootstrap_exit() {
  local original_status="${1:-1}"
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  fsk_delete_bootstrap_parameter_if_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
  fsk_delete_bootstrap_parameter_if_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
  fsk_delete_bootstrap_parameter_if_owned "$FSK_TASK8_STATE_PARAMETER"
  if [ "$original_status" -eq 0 ]; then original_status=1; fi
  exit "$original_status"
}
trap 'fsk_control_parameter_bootstrap_exit "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM
test -n "$(trap -p EXIT)"

if ! FSK_TASK8_WORKER_STATUS_PARAMETER_VERSION="$(
  fsk_run_before_temp_egress_deadline aws ssm put-parameter \
  --region ap-northeast-1 \
  --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
  --type String --value NOT_STARTED \
  --tags \
    Key=Project,Value=FSK \
    Key=Environment,Value=staging \
    Key=ManagedBy,Value=AmplifyGen2 \
    Key=CostCenter,Value=FSK \
    "Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}" \
    "Key=BootstrapToken,Value=${FSK_TASK8_BOOTSTRAP_TOKEN}" \
  --query Version --output text
)"; then
  exit 1
fi
case "$FSK_TASK8_WORKER_STATUS_PARAMETER_VERSION" in
  ''|*[!0-9]*) exit 1 ;;
esac
if ! FSK_TASK8_CONTROL_STATUS_PARAMETER_VERSION="$(
  fsk_run_before_temp_egress_deadline aws ssm put-parameter \
  --region ap-northeast-1 \
  --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
  --type String --value CONTROL_ARMED \
  --tags \
    Key=Project,Value=FSK \
    Key=Environment,Value=staging \
    Key=ManagedBy,Value=AmplifyGen2 \
    Key=CostCenter,Value=FSK \
    "Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}" \
    "Key=BootstrapToken,Value=${FSK_TASK8_BOOTSTRAP_TOKEN}" \
  --query Version --output text
)"; then
  exit 1
fi
case "$FSK_TASK8_CONTROL_STATUS_PARAMETER_VERSION" in
  ''|*[!0-9]*) exit 1 ;;
esac
if ! FSK_TASK8_INITIAL_STATE_PARAMETER_VERSION="$(
  fsk_run_before_temp_egress_deadline aws ssm put-parameter \
  --region ap-northeast-1 \
  --name "$FSK_TASK8_STATE_PARAMETER" \
  --type String --value '{"version":1}' \
  --tags \
    Key=Project,Value=FSK \
    Key=Environment,Value=staging \
    Key=ManagedBy,Value=AmplifyGen2 \
    Key=CostCenter,Value=FSK \
    "Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}" \
    "Key=BootstrapToken,Value=${FSK_TASK8_BOOTSTRAP_TOKEN}" \
  --query Version --output text
)"; then
  exit 1
fi
case "$FSK_TASK8_INITIAL_STATE_PARAMETER_VERSION" in
  ''|*[!0-9]*) exit 1 ;;
esac

trap - EXIT HUP INT TERM
trap 'fsk_control_exit "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM
fsk_persist_temp_egress_state
FSK_TEMP_EGRESS_CONTROL_PARENT_PID="$$"
export FSK_TEMP_EGRESS_CONTROL_PARENT_PID
fsk_control_watchdog &
FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID="$!"
test -n "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID"
test -n "$(trap -p EXIT)"
```

确认 control trap、SSM poller 和独立 CleanupOwner timer 都已安装后，在**同一 control session**创建资源。每个 ID/marker 一产生就立即覆盖非敏感 state parameter 和 Task 8 证据；任一命令非零会触发 control EXIT cleanup：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = control
declare -F fsk_control_exit >/dev/null
declare -F fsk_cleanup_temp_egress >/dev/null
test -n "$(trap -p EXIT)"
fsk_assert_temp_egress_deadline
: "${FSK_TEMP_EGRESS_APPROVAL_ID:?temporary egress requires separate approval}"
: "${FSK_TEMP_PUBLIC_CIDR:?set a verified unused VPC CIDR}"
: "${FSK_TEMP_AZ:?set the approved AZ}"
: "${FSK_APP_ROUTE_TABLE_A_ID:?set application route table A}"
: "${FSK_APP_ROUTE_TABLE_B_ID:?set application route table B}"
FSK_PREEXISTING_APP_DEFAULT_ROUTE_COUNT="$(
  fsk_run_before_temp_egress_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 \
    --route-table-ids "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID" \
    --query 'length(RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`][])' \
    --output text
)"
test "$FSK_PREEXISTING_APP_DEFAULT_ROUTE_COUNT" -eq 0
FSK_TEMP_IGW_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-internet-gateway \
  --region ap-northeast-1 \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query InternetGateway.InternetGatewayId --output text)"
case "$FSK_TEMP_IGW_ID" in igw-*) ;; *) exit 1 ;; esac
fsk_persist_temp_egress_state
fsk_run_before_temp_egress_deadline aws ec2 attach-internet-gateway \
  --region ap-northeast-1 \
  --internet-gateway-id "$FSK_TEMP_IGW_ID" --vpc-id "$FSK_VPC_ID"
FSK_TEMP_IGW_ATTACHED=1
fsk_persist_temp_egress_state
FSK_TEMP_PUBLIC_SUBNET_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-subnet \
  --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
  --cidr-block "$FSK_TEMP_PUBLIC_CIDR" --availability-zone "$FSK_TEMP_AZ" \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query Subnet.SubnetId --output text)"
case "$FSK_TEMP_PUBLIC_SUBNET_ID" in subnet-*) ;; *) exit 1 ;; esac
fsk_persist_temp_egress_state
FSK_TEMP_PUBLIC_ROUTE_TABLE_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-route-table \
  --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query RouteTable.RouteTableId --output text)"
case "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" in rtb-*) ;; *) exit 1 ;; esac
fsk_persist_temp_egress_state
FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 associate-route-table \
  --region ap-northeast-1 --route-table-id "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
  --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" \
  --query AssociationId --output text)"
case "$FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID" in rtbassoc-*) ;; *) exit 1 ;; esac
fsk_persist_temp_egress_state
fsk_run_before_temp_egress_deadline aws ec2 create-route \
  --region ap-northeast-1 \
  --route-table-id "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
  --destination-cidr-block 0.0.0.0/0 --gateway-id "$FSK_TEMP_IGW_ID"
FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED=1
fsk_persist_temp_egress_state
FSK_TEMP_EIP_ALLOCATION_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 allocate-address \
  --region ap-northeast-1 --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query AllocationId --output text)"
case "$FSK_TEMP_EIP_ALLOCATION_ID" in eipalloc-*) ;; *) exit 1 ;; esac
fsk_persist_temp_egress_state
FSK_TEMP_NAT_GATEWAY_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-nat-gateway \
  --region ap-northeast-1 --connectivity-type public \
  --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" \
  --allocation-id "$FSK_TEMP_EIP_ALLOCATION_ID" \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}}]" \
  --query NatGateway.NatGatewayId --output text)"
case "$FSK_TEMP_NAT_GATEWAY_ID" in nat-*) ;; *) exit 1 ;; esac
fsk_persist_temp_egress_state
fsk_run_before_temp_egress_deadline aws ec2 wait nat-gateway-available \
  --region ap-northeast-1 \
  --nat-gateway-ids "$FSK_TEMP_NAT_GATEWAY_ID"
fsk_run_before_temp_egress_deadline aws ec2 create-route \
  --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_A_ID" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$FSK_TEMP_NAT_GATEWAY_ID"
FSK_TEMP_APP_ROUTE_A_CREATED=1
fsk_persist_temp_egress_state
fsk_run_before_temp_egress_deadline aws ec2 create-route \
  --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_B_ID" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$FSK_TEMP_NAT_GATEWAY_ID"
FSK_TEMP_APP_ROUTE_B_CREATED=1
fsk_persist_temp_egress_state
fsk_assert_temp_egress_deadline
```

创建后记录 state parameter version、所有资源 ID/marker、application route table IDs、deadline、创建时间、批准编号、control session actor 和 `CleanupOwner`；只读确认两个 application route table 的默认路由都精确指向该临时 NAT。control session 和 poller 保持打开。

随后打开 VPC worker session，从批准证据恢复 VPC、application route table IDs、deadline、TaskId 和 CleanupOwner，执行 `export FSK_TASK8_SHELL_ROLE=worker`，再重跑 common guard/function 初始化 fence。worker 通过 SSM Interface Endpoint 读取 state（不得打印），保存 checksum 后安装失败通知 trap；trap 不调用 EC2 cleanup，只写 `FAILED:*`，control poller 才是唯一清理执行者：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
fsk_assert_temp_egress_deadline
FSK_TASK8_STATE_JSON="$(
  fsk_run_before_temp_egress_deadline aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_STATE_PARAMETER" \
    --query Parameter.Value --output text
)"
FSK_TASK8_STATE_SHA256="$(
  printf '%s' "$FSK_TASK8_STATE_JSON" | sha256sum | awk '{ print $1 }'
)"
FSK_TASK8_STATE_JSON="$FSK_TASK8_STATE_JSON" \
FSK_CLOUDSHELL_TASK_ID="$FSK_CLOUDSHELL_TASK_ID" \
FSK_VPC_ID="$FSK_VPC_ID" \
FSK_APP_ROUTE_TABLE_A_ID="$FSK_APP_ROUTE_TABLE_A_ID" \
FSK_APP_ROUTE_TABLE_B_ID="$FSK_APP_ROUTE_TABLE_B_ID" \
FSK_TEMP_EGRESS_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_DEADLINE_EPOCH" \
FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" \
FSK_FOUNDATION_COMMIT="$FSK_FOUNDATION_COMMIT" \
node -e '
  const state = JSON.parse(process.env.FSK_TASK8_STATE_JSON ?? "");
  const allowed = new Set([
    "version",
    "FSK_CLOUDSHELL_TASK_ID",
    "FSK_VPC_ID",
    "FSK_APP_ROUTE_TABLE_A_ID",
    "FSK_APP_ROUTE_TABLE_B_ID",
    "FSK_TEMP_EGRESS_DEADLINE_EPOCH",
    "FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH",
    "FSK_FOUNDATION_COMMIT",
    "FSK_TEMP_IGW_ID",
    "FSK_TEMP_PUBLIC_SUBNET_ID",
    "FSK_TEMP_PUBLIC_ROUTE_TABLE_ID",
    "FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID",
    "FSK_TEMP_EIP_ALLOCATION_ID",
    "FSK_TEMP_NAT_GATEWAY_ID",
    "FSK_TEMP_IGW_ATTACHED",
    "FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED",
    "FSK_TEMP_APP_ROUTE_A_CREATED",
    "FSK_TEMP_APP_ROUTE_B_CREATED",
  ]);
  const expected = {
    FSK_CLOUDSHELL_TASK_ID: process.env.FSK_CLOUDSHELL_TASK_ID,
    FSK_VPC_ID: process.env.FSK_VPC_ID,
    FSK_APP_ROUTE_TABLE_A_ID: process.env.FSK_APP_ROUTE_TABLE_A_ID,
    FSK_APP_ROUTE_TABLE_B_ID: process.env.FSK_APP_ROUTE_TABLE_B_ID,
    FSK_TEMP_EGRESS_DEADLINE_EPOCH: process.env.FSK_TEMP_EGRESS_DEADLINE_EPOCH,
    FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH:
      process.env.FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH,
    FSK_FOUNDATION_COMMIT: process.env.FSK_FOUNDATION_COMMIT,
  };
  if (state.version !== 1 ||
      Object.keys(state).some((key) => !allowed.has(key)) ||
      Object.entries(expected).some(([key, value]) => state[key] !== value)) {
    process.exit(2);
  }
'
unset FSK_TASK8_STATE_JSON
FSK_TASK8_CONTROL_STATUS="$(
  fsk_run_before_temp_egress_deadline aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
test "$FSK_TASK8_CONTROL_STATUS" = CONTROL_ARMED
FSK_TASK8_WORKER_STATUS="$(
  fsk_run_before_temp_egress_deadline aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
test "$FSK_TASK8_WORKER_STATUS" = NOT_STARTED
trap 'fsk_worker_exit "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM
fsk_put_task8_worker_status WORKER_RUNNING
FSK_TASK8_CONTROL_STATUS="$(
  fsk_run_before_temp_egress_deadline aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
test "$FSK_TASK8_CONTROL_STATUS" = CONTROL_ARMED
test -n "$(trap -p EXIT)"
```

从此到 §4.3 的所有 worker fences 都在该持久 session 顺序执行，不能把 fence 当成独立 shell。任何命令失败/timeout/INT/TERM 都通过 SSM 通知 control；control 每 15 秒处理，不等 deadline。若 state/status 缺失、checksum 无法记录或 deadline 已过，worker `STOP` 并写失败状态，由 control/cleanup owner 立即清理。

出口可用后，worker session 只从审批记录中的固定仓库 `https://github.com/reikentoutou/F.S.K.git` 获取源码；认证如有需要只能使用已批准的 credential helper，不得把 token 放进 URL、命令或 history。`FSK_FOUNDATION_COMMIT` 必须来自 Task 7 中 `fsk-staging-foundation-v1^{commit}` 的已验证证据，不能在 CloudShell 猜测。显式 fetch immutable remote tag、exact commit 和远程 `staging`，三者必须相等，再 detached checkout 精确 commit，并在安装依赖前留存 clean/checksum 证据：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
fsk_assert_temp_egress_deadline
: "${FSK_FOUNDATION_COMMIT:?restore the verified foundation tag commit evidence}"
FSK_FOUNDATION_TAG=fsk-staging-foundation-v1
FSK_APPROVED_REPOSITORY_URL=https://github.com/reikentoutou/F.S.K.git
case "$FSK_APPROVED_REPOSITORY_URL" in
  *://*@*) echo 'CREDENTIALS_IN_REPOSITORY_URL_STOP' >&2; exit 1 ;;
esac
FSK_TASK8_SOURCE_PARENT="$(mktemp -d)"
FSK_TASK8_REPOSITORY_DIR="${FSK_TASK8_SOURCE_PARENT}/repository"
fsk_run_before_temp_egress_deadline git clone \
  --no-checkout --single-branch --branch staging --no-tags \
  "$FSK_APPROVED_REPOSITORY_URL" "$FSK_TASK8_REPOSITORY_DIR"
FSK_CLOUDSHELL_ORIGIN_URL="$(
  fsk_run_before_temp_egress_deadline \
    git -C "$FSK_TASK8_REPOSITORY_DIR" remote get-url origin
)"
test "$FSK_CLOUDSHELL_ORIGIN_URL" = "$FSK_APPROVED_REPOSITORY_URL"
case "$FSK_CLOUDSHELL_ORIGIN_URL" in
  *://*@*) echo 'CREDENTIALS_IN_CLONED_ORIGIN_STOP' >&2; exit 1 ;;
esac
fsk_run_before_temp_egress_deadline git -C "$FSK_TASK8_REPOSITORY_DIR" \
  fetch origin \
  "refs/tags/${FSK_FOUNDATION_TAG}:refs/tags/${FSK_FOUNDATION_TAG}"
FSK_CLOUDSHELL_FOUNDATION_TAG_COMMIT="$(
  fsk_run_before_temp_egress_deadline \
    git -C "$FSK_TASK8_REPOSITORY_DIR" rev-parse "${FSK_FOUNDATION_TAG}^{commit}"
)"
test "$FSK_CLOUDSHELL_FOUNDATION_TAG_COMMIT" = "$FSK_FOUNDATION_COMMIT"
fsk_run_before_temp_egress_deadline git -C "$FSK_TASK8_REPOSITORY_DIR" \
  fetch --no-tags \
  origin "$FSK_FOUNDATION_COMMIT"
test "$(fsk_run_before_temp_egress_deadline \
  git -C "$FSK_TASK8_REPOSITORY_DIR" rev-parse FETCH_HEAD)" = \
  "$FSK_FOUNDATION_COMMIT"
fsk_run_before_temp_egress_deadline git -C "$FSK_TASK8_REPOSITORY_DIR" \
  fetch --no-tags origin \
  refs/heads/staging:refs/remotes/origin/staging
FSK_CLOUDSHELL_REMOTE_STAGING_COMMIT="$(
  fsk_run_before_temp_egress_deadline \
    git -C "$FSK_TASK8_REPOSITORY_DIR" rev-parse refs/remotes/origin/staging
)"
test "$FSK_CLOUDSHELL_REMOTE_STAGING_COMMIT" = \
  "$FSK_FOUNDATION_COMMIT"
fsk_run_before_temp_egress_deadline git -C "$FSK_TASK8_REPOSITORY_DIR" \
  checkout --detach "$FSK_FOUNDATION_COMMIT"
test "$(fsk_run_before_temp_egress_deadline \
  git -C "$FSK_TASK8_REPOSITORY_DIR" rev-parse HEAD)" = \
  "$FSK_FOUNDATION_COMMIT"
test -z "$(fsk_run_before_temp_egress_deadline \
  git -C "$FSK_TASK8_REPOSITORY_DIR" status --porcelain --untracked-files=all)"
FSK_MIGRATION_SOURCE_COMMIT="$(
  fsk_run_before_temp_egress_deadline \
    git -C "$FSK_TASK8_REPOSITORY_DIR" rev-parse HEAD
)"
FSK_MIGRATION_SOURCE_SHA256="$(
  cd "$FSK_TASK8_REPOSITORY_DIR"
  fsk_run_before_temp_egress_deadline \
    sha256sum amplify/database/migrations/*.sql |
    fsk_run_before_temp_egress_deadline sha256sum | awk '{ print $1 }'
)"
test "$FSK_MIGRATION_SOURCE_COMMIT" = "$FSK_FOUNDATION_COMMIT"
cd "$FSK_TASK8_REPOSITORY_DIR"
fsk_assert_temp_egress_deadline
```

记录 `ApprovedRepositoryUrl`（无 credentials）、`FoundationTag`、`RemoteTagCommit`、`RemoteStagingCommit`、`CloudShellSourceCommit`、`DetachedHeadVerified`、`OriginCredentialScan`、`SourceCleanState` 和 `MigrationSourceSha256`。clone/fetch/checkout/校验任一步失败或 timeout 都由 worker EXIT trap 写 `FAILED:*`，control poller 随即执行清理与 residual check；worker 不删除自身默认路由。

### 3.3 执行 migration

先从 §2.3 记录的精确 Foundation stack ID 读取三个 outputs；不得用名称搜索猜 stack，也不得采用 Secret JSON 内的 host 代替 RDS describe 结果。再用只读 RDS describe 验证 endpoint 属于 Foundation VPC，且 cluster 的所有 DB instance 都不是 publicly accessible：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
fsk_assert_temp_egress_deadline
: "${FSK_TASK8_REPOSITORY_DIR:?reuse the persistent worker source directory}"
test "$PWD" = "$FSK_TASK8_REPOSITORY_DIR"
test "$(fsk_run_before_temp_egress_deadline git rev-parse HEAD)" = \
  "$FSK_FOUNDATION_COMMIT"
: "${FSK_FOUNDATION_STACK_ID:?use the exact FoundationStackId evidence}"
: "${FSK_VPC_ID:?use the exact VpcId output evidence}"
FSK_AURORA_CLUSTER_ARN="$(fsk_run_before_temp_egress_deadline \
  aws cloudformation describe-stacks \
  --region ap-northeast-1 --stack-name "$FSK_FOUNDATION_STACK_ID" \
  --query "Stacks[0].Outputs[?OutputKey=='AuroraClusterArn'].OutputValue | [0]" \
  --output text)"
FSK_AURORA_SECRET_ARN="$(fsk_run_before_temp_egress_deadline \
  aws cloudformation describe-stacks \
  --region ap-northeast-1 --stack-name "$FSK_FOUNDATION_STACK_ID" \
  --query "Stacks[0].Outputs[?OutputKey=='AuroraSecretArn'].OutputValue | [0]" \
  --output text)"
FSK_DATABASE_NAME="$(fsk_run_before_temp_egress_deadline \
  aws cloudformation describe-stacks \
  --region ap-northeast-1 --stack-name "$FSK_FOUNDATION_STACK_ID" \
  --query "Stacks[0].Outputs[?OutputKey=='DatabaseName'].OutputValue | [0]" \
  --output text)"
test -n "$FSK_AURORA_CLUSTER_ARN"
test "$FSK_AURORA_CLUSTER_ARN" != None
test -n "$FSK_AURORA_SECRET_ARN"
test "$FSK_AURORA_SECRET_ARN" != None
test "$FSK_DATABASE_NAME" = fsk_staging

FSK_DB_CLUSTER_ID="$(fsk_run_before_temp_egress_deadline \
  aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].DBClusterIdentifier' --output text)"
FSK_DB_ENDPOINT="$(fsk_run_before_temp_egress_deadline \
  aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].Endpoint' --output text)"
FSK_DB_PORT="$(fsk_run_before_temp_egress_deadline \
  aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].Port' --output text)"
FSK_DB_SUBNET_GROUP="$(fsk_run_before_temp_egress_deadline \
  aws rds describe-db-clusters \
  --region ap-northeast-1 --db-cluster-identifier "$FSK_AURORA_CLUSTER_ARN" \
  --query 'DBClusters[0].DBSubnetGroup' --output text)"
FSK_DB_SUBNET_VPC_ID="$(fsk_run_before_temp_egress_deadline \
  aws rds describe-db-subnet-groups \
  --region ap-northeast-1 --db-subnet-group-name "$FSK_DB_SUBNET_GROUP" \
  --query 'DBSubnetGroups[0].VpcId' --output text)"
FSK_DB_INSTANCE_COUNT="$(fsk_run_before_temp_egress_deadline \
  aws rds describe-db-instances \
  --region ap-northeast-1 \
  --filters "Name=db-cluster-id,Values=${FSK_DB_CLUSTER_ID}" \
  --query 'length(DBInstances)' --output text)"
FSK_PUBLIC_DB_INSTANCE_COUNT="$(fsk_run_before_temp_egress_deadline \
  aws rds describe-db-instances \
  --region ap-northeast-1 \
  --filters "Name=db-cluster-id,Values=${FSK_DB_CLUSTER_ID}" \
  --query 'length(DBInstances[?PubliclyAccessible==`true`])' --output text)"
test -n "$FSK_DB_ENDPOINT"
test "$FSK_DB_ENDPOINT" != None
test "$FSK_DB_SUBNET_VPC_ID" = "$FSK_VPC_ID"
test "$FSK_DB_INSTANCE_COUNT" -ge 1
test "$FSK_PUBLIC_DB_INSTANCE_COUNT" = 0
fsk_assert_temp_egress_deadline
```

证据只能写“Foundation VPC 匹配、public instance count=0、private endpoint 验证通过”等脱敏结果；不得把完整 endpoint、cluster/Secret ARN 或连接串复制到报告。

保持 §3.2 临时 NAT，安装依赖后用下列块在当前 CloudShell 进程构造 `DATABASE_URL`。Secret value 只经 pipe 进入 Node stdin；用户名和密码分别用 `encodeURIComponent` URL encode；连接串只进入 command substitution 和当前进程环境，不打印、不写文件、不作为命令参数、不写入 shell history。`?sslmode=require` 和 `/fsk_staging` 与现有脚本的 `DATABASE_URL_REQUIRED`/TLS/database guard 兼容：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
fsk_assert_temp_egress_deadline
test "$PWD" = "$FSK_TASK8_REPOSITORY_DIR"
fsk_run_before_temp_egress_deadline pnpm install --frozen-lockfile
FSK_MIGRATION_SOURCE_SHA256_CURRENT="$(
  fsk_run_before_temp_egress_deadline \
    sha256sum amplify/database/migrations/*.sql |
    fsk_run_before_temp_egress_deadline sha256sum | awk '{ print $1 }'
)"
test "$FSK_MIGRATION_SOURCE_SHA256_CURRENT" = "$FSK_MIGRATION_SOURCE_SHA256"

fsk_clear_database_url() {
  unset DATABASE_URL
}
set +x
if DATABASE_URL="$(
  fsk_run_before_temp_egress_deadline aws secretsmanager get-secret-value \
    --region ap-northeast-1 \
    --secret-id "$FSK_AURORA_SECRET_ARN" \
    --query SecretString --output text |
  fsk_run_before_temp_egress_deadline env \
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

fsk_run_before_temp_egress_deadline pnpm run db:staging:migrate
FSK_MIGRATE_FIRST_EXIT=0
fsk_assert_temp_egress_deadline
fsk_run_before_temp_egress_deadline pnpm run db:staging:migrate
FSK_MIGRATE_SECOND_EXIT=0
fsk_assert_temp_egress_deadline
fsk_run_before_temp_egress_deadline pnpm run db:staging:verify
FSK_VERIFY_SCHEMA_EXIT=0

fsk_clear_database_url
test -z "${DATABASE_URL+x}"
test "$FSK_MIGRATE_FIRST_EXIT" -eq 0
test "$FSK_MIGRATE_SECOND_EXIT" -eq 0
test "$FSK_VERIFY_SCHEMA_EXIT" -eq 0
fsk_assert_temp_egress_deadline
```

首次 migrate 必须记录 `MIGRATIONS_APPLIED count=1`，第二次必须为 `count=0`，verify 必须为 `SCHEMA_VERIFIED`。三个命令在 `set -euo pipefail` 下逐个 fail-fast，并由 operation deadline 派生的独立 process-group `timeout` 硬限制 pnpm/Node 子树；任一步失败/timeout 时 worker EXIT trap 先 unset `DATABASE_URL`，再通过 SSM worker-status 写 `FAILED:*`，control poller 独占执行幂等临时出口清理与 residual check，绝不能进入 branch secret。不得把 Secret value、username、password、完整 endpoint 或 `DATABASE_URL` 写入证据。

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
| TemporaryEgressOperationDeadlineEpoch | `PENDING_USER_APPROVAL` |
| TemporaryEgressCleanupDeadlineEpoch | `PENDING_USER_APPROVAL` |
| TemporaryEgressWorkerStatusParameter | `PENDING_CLOUDSHELL_NONSECRET` |
| TemporaryEgressControlStatusParameter | `PENDING_CLOUDSHELL_NONSECRET` |
| TemporaryEgressStateParameterVersionEvidence | `PENDING_CLOUDSHELL_NONSECRET` |
| TemporaryEgressBootstrapTokenSha256 | `PENDING_CLOUDSHELL_NONSECRET` |
| TemporaryEgressStateChecksum | `PENDING_CLOUDSHELL_NONSECRET` |
| TemporaryEgressControlPollerPidEvidence | `PENDING_CLOUDSHELL` |
| TemporaryEgressCleanupOwnerAcknowledged | `PENDING_USER_APPROVAL` |
| TemporaryEgressDeletedAtJst | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressDeletionEvidence | `PENDING_SCHEMA_GENERATION` |
| MigrationSourceSha256 | `PENDING_CLOUDSHELL` |
| MigrationSourceCommit | `PENDING_CLOUDSHELL` |
| ApprovedRepositoryUrl | `https://github.com/reikentoutou/F.S.K.git` |
| CloudShellOriginCredentialScan | `PENDING_CLOUDSHELL` |
| CloudShellDetachedHeadClean | `PENDING_CLOUDSHELL` |
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

保持 §3.2 临时 NAT 和同一 worker session；离开 worker tab 前先确认失败通知 trap/deadline 仍有效，并清空配置完成标志：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
test -z "${DATABASE_URL+x}"
fsk_assert_temp_egress_deadline
FSK_BRANCH_SECRET_CONFIGURED=0
```

按照 [Amplify Gen 2 官方 branch secrets 流程](https://docs.amplify.aws/vue/deploy-and-host/fullstack-branching/secrets-and-vars/)，从 App home 进入 `Hosting` → `Secrets` → `Manage secrets`，新增 key `SQL_CONNECTION_STRING`，scope **只选择 `staging` branch**。不得放入 environment variables，也不得设为 shared/all branches。

Value 使用 §3.3 同一 private endpoint、port、`fsk_staging` 和 Aurora generated Secret 中的 username/password，并按相同算法分别 URL encode，格式固定为 `postgresql://<encoded-user>:<encoded-password>@<private-endpoint>:<port>/fsk_staging?sslmode=require`。只允许通过 Console 的 masked secret input 输入；禁止 `echo`、命令参数、文件、shell history、文档或截图，无法提供合规的 masked 输入路径时 `STOP`。保存后只记录 key、branch scope、更新时间、操作者和 value 已遮蔽的 Console 截图；官方文档说明 branch secret 存在 Parameter Store，后续 `ampx` 会通过公网 Amplify/SSM API 读取，因此此时不能删除 NAT。

Console 操作完成后必须回到**原 worker session**，只在 masked screenshot/branch scope 均已核对时设置非敏感标志并重新检查 deadline：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
: "${FSK_BRANCH_SECRET_MASKED_EVIDENCE:?record the masked Console evidence path}"
FSK_BRANCH_SECRET_CONFIGURED=1
test "$FSK_BRANCH_SECRET_CONFIGURED" -eq 1
fsk_assert_temp_egress_deadline
```

若保存失败、scope 错误、证据缺失或操作者取消，必须回到 worker session 执行 `exit 1`；EXIT trap 写 `FAILED:*`，control poller 在下一次 15 秒轮询中立即清理并 residual check，不得把失败留给后续步骤。若 worker session 意外丢失，control 的硬 deadline 与独立 `CleanupOwner` timer 接管清理。

### 4.2 两次生成、无差异核对和安全带回

`schema.sql.ts` 只能由生成命令更新，禁止手工编辑。第一次生成后保存无敏感值 baseline 和 SHA-256；第二次运行必须与 baseline byte-for-byte 相同。下列 scanner 从 Secrets Manager pipe 读取敏感值，只返回 exit code，不打印命中的值：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
test "$PWD" = "$FSK_TASK8_REPOSITORY_DIR"
test "${FSK_BRANCH_SECRET_CONFIGURED:-0}" -eq 1
fsk_assert_temp_egress_deadline
: "${AMPLIFY_APP_ID:?use the exact Task 7 App ID evidence}"
: "${FSK_AURORA_SECRET_ARN:?reuse the Foundation output in the current session}"
: "${FSK_DB_ENDPOINT:?reuse the private endpoint in the current session}"
FSK_SCHEMA_COMPARE_DIR="$(mktemp -d)"
: "${FSK_SCHEMA_COMPARE_DIR:?mktemp failed}"

fsk_scan_generated_schema() {
  fsk_run_before_temp_egress_deadline aws secretsmanager get-secret-value \
    --region ap-northeast-1 \
    --secret-id "$FSK_AURORA_SECRET_ARN" \
    --query SecretString --output text |
  fsk_run_before_temp_egress_deadline env \
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

fsk_assert_temp_egress_deadline
fsk_run_before_temp_egress_deadline \
  pnpm exec ampx generate schema-from-database \
  --connection-uri-secret SQL_CONNECTION_STRING \
  --app-id "$AMPLIFY_APP_ID" \
  --branch staging \
  --out amplify/data/schema.sql.ts
fsk_scan_generated_schema
fsk_run_before_temp_egress_deadline cp \
  amplify/data/schema.sql.ts "$FSK_SCHEMA_COMPARE_DIR/schema.sql.ts.first"
FSK_SCHEMA_FIRST_SHA256="$(
  fsk_run_before_temp_egress_deadline sha256sum amplify/data/schema.sql.ts |
    awk '{ print $1 }'
)"

fsk_assert_temp_egress_deadline
fsk_run_before_temp_egress_deadline \
  pnpm exec ampx generate schema-from-database \
  --connection-uri-secret SQL_CONNECTION_STRING \
  --app-id "$AMPLIFY_APP_ID" \
  --branch staging \
  --out amplify/data/schema.sql.ts
fsk_scan_generated_schema
fsk_run_before_temp_egress_deadline cmp -s \
  "$FSK_SCHEMA_COMPARE_DIR/schema.sql.ts.first" amplify/data/schema.sql.ts
FSK_SCHEMA_SECOND_SHA256="$(
  fsk_run_before_temp_egress_deadline sha256sum amplify/data/schema.sql.ts |
    awk '{ print $1 }'
)"
test "$FSK_SCHEMA_SECOND_SHA256" = "$FSK_SCHEMA_FIRST_SHA256"
fsk_run_before_temp_egress_deadline \
  rm -- "$FSK_SCHEMA_COMPARE_DIR/schema.sql.ts.first"
fsk_run_before_temp_egress_deadline rmdir -- "$FSK_SCHEMA_COMPARE_DIR"
unset FSK_SCHEMA_COMPARE_DIR
fsk_assert_temp_egress_deadline
```

foundation 阶段尚未创建 `stage-admin`/`stage-kitchen` 密码；若执行顺序改变且已有合成凭据，必须把这些值加入同一 no-output scanner 后才能带回。完成两次生成后，从 CloudShell `Actions` → `Download file` 下载精确路径 `amplify/data/schema.sql.ts`，不通过共享 Git push 传输。放入本地 `RE/amplify-gen2-staging-implementation` 的同一路径后执行；`FSK_EXPECTED_SCHEMA_SHA256` 只填写 CloudShell 记录的第二次 SHA-256，不包含敏感值：

```bash
set -euo pipefail
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

本地 `rg` 的 exit `1` 表示“无匹配”，因此必须保持在上述 `if rg -q ...; then FAIL; fi` 结构中，不能把 no-match 当成 shell 失败。若本地 checksum 或 scanner 失败，立即回到仍打开的 worker session 执行 `exit 1` 通知 control 清理。两项都通过后回到同一 worker session，确认安全带回；跨 tab/下载期间 control poller 的硬 deadline 与独立 CleanupOwner timer 持续有效：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
FSK_SAFE_BRINGBACK_CONFIRMED=1
test "$FSK_SAFE_BRINGBACK_CONFIRMED" -eq 1
fsk_assert_temp_egress_deadline
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

安全带回完成后，worker 不调用 EC2 cleanup，而是只把自己的 worker-status 从 `WORKER_RUNNING` 更新为 `READY_FOR_CLEANUP`；它永远不写 control-status。control poller 看到该值后在 cleanup deadline 内重复 discovery→delete→residual，只有连续三次全零才把 control-status 写成 `CLEANUP_PASS:READY_FOR_CLEANUP`，否则写 `CLEANUP_BLOCKED:*`。worker 通过 SSM Interface Endpoint 等待 control-status，即使 NAT 已移除仍可读取；两个单写者参数消除了 worker 覆盖 terminal cleanup 的 TOCTOU：

```bash
set -euo pipefail
test "${FSK_SAFE_BRINGBACK_CONFIRMED:-0}" -eq 1
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
FSK_TASK8_WORKER_STATUS="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
test "$FSK_TASK8_WORKER_STATUS" = WORKER_RUNNING
FSK_TASK8_CONTROL_STATUS="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
case "$FSK_TASK8_CONTROL_STATUS" in
  CONTROL_ARMED) ;;
  CLEANUP_PASS:*|CLEANUP_BLOCKED:*)
    trap - EXIT HUP INT TERM
    echo 'CONTROL_CLEANUP_ALREADY_TERMINAL_STOP_AND_AUDIT' >&2
    exit 1
    ;;
  *) echo 'TASK8_CONTROL_STATUS_UNEXPECTED_STOP' >&2; exit 1 ;;
esac
fsk_put_task8_worker_status READY_FOR_CLEANUP
FSK_CONTROL_CLEANUP_CONFIRM_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH"
while :; do
  FSK_TASK8_CONTROL_STATUS="$(
    timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
      --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
      --query Parameter.Value --output text
  )"
  case "$FSK_TASK8_CONTROL_STATUS" in
    CLEANUP_PASS:READY_FOR_CLEANUP) break ;;
    CLEANUP_BLOCKED:*)
      trap - EXIT HUP INT TERM
      echo 'CONTROL_CLEANUP_BLOCKED_OWNER_ACTION_REQUIRED' >&2
      exit 1
      ;;
    CONTROL_ARMED) ;;
    *) echo 'TASK8_CONTROL_STATUS_UNEXPECTED_STOP' >&2; exit 1 ;;
  esac
  if [ "$(date +%s)" -ge "$FSK_CONTROL_CLEANUP_CONFIRM_DEADLINE_EPOCH" ]; then
    echo 'CONTROL_CLEANUP_CONFIRM_TIMEOUT' >&2
    exit 1
  fi
  sleep 15
done
FSK_CONTROL_CLEANUP_STATE_JSON="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_STATE_PARAMETER" \
    --query Parameter.Value --output text
)"
FSK_CONTROL_CLEANUP_STATE_JSON="$FSK_CONTROL_CLEANUP_STATE_JSON" node -e '
  const state = JSON.parse(process.env.FSK_CONTROL_CLEANUP_STATE_JSON ?? "");
  const expected = [
    "applicationRouteCount",
    "natGatewayCount",
    "elasticIpCount",
    "routeTableCount",
    "subnetCount",
    "internetGatewayCount",
  ];
  if (state.version !== 1 || state.cleanupResult !== "PASS" ||
      !/^\d+$/.test(state.cleanupAttempts ?? "") ||
      Number(state.stableZeroObservations) < 3 ||
      expected.some((key) => state.counts?.[key] !== "0")) {
    process.exit(2);
  }
'
FSK_CONTROL_CLEANUP_STATE_SHA256="$(
  printf '%s' "$FSK_CONTROL_CLEANUP_STATE_JSON" | sha256sum | awk '{ print $1 }'
)"
unset FSK_CONTROL_CLEANUP_STATE_JSON
FSK_TEMP_EGRESS_DELETED_AT_JST="$(TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z')"
trap - EXIT HUP INT TERM
```

worker 只在 control-status 精确 PASS 且 state 中六类 count 全为字符串 `"0"` 后解除失败通知 trap。随后回到仍打开的 control session，等待 poller 子进程并再次读取 control-status/state checksum；两项一致且 worker/control 两份单写者 history 都通过白名单验证后，解除 control trap并删除三个临时 SSM parameters：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = control
declare -F fsk_control_exit >/dev/null
test -n "$(trap -p EXIT)"
: "${FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID:?control poller pid missing}"
: "${FSK_EXPECTED_CONTROL_CLEANUP_STATE_SHA256:?copy the worker cleanup state checksum evidence}"
if wait "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID"; then
  FSK_TEMP_EGRESS_CONTROL_WATCHDOG_EXIT=0
else
  FSK_TEMP_EGRESS_CONTROL_WATCHDOG_EXIT=$?
fi
test "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_EXIT" -eq 0
FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID=''
FSK_CONTROL_STATUS_EVIDENCE="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
test "$FSK_CONTROL_STATUS_EVIDENCE" = CLEANUP_PASS:READY_FOR_CLEANUP
FSK_CONTROL_STATE_EVIDENCE="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_STATE_PARAMETER" \
    --query Parameter.Value --output text
)"
FSK_CONTROL_STATE_EVIDENCE_SHA256="$(
  printf '%s' "$FSK_CONTROL_STATE_EVIDENCE" | sha256sum | awk '{ print $1 }'
)"
test "$FSK_CONTROL_STATE_EVIDENCE_SHA256" = \
  "$FSK_EXPECTED_CONTROL_CLEANUP_STATE_SHA256"
FSK_TASK8_WORKER_STATUS_HISTORY_JSON="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter-history \
    --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
    --max-results 50 \
    --query 'Parameters[].{Version:Version,LastModifiedDate:LastModifiedDate,Value:Value}' \
    --output json
)"
FSK_TASK8_WORKER_STATUS_HISTORY_JSON="$FSK_TASK8_WORKER_STATUS_HISTORY_JSON" node -e '
  const history = JSON.parse(process.env.FSK_TASK8_WORKER_STATUS_HISTORY_JSON ?? "");
  const allowed = /^(NOT_STARTED|WORKER_RUNNING|READY_FOR_CLEANUP|FAILED:[A-Z0-9_]+)$/;
  if (!Array.isArray(history) || history.length < 2 ||
      history.some((entry) => !Number.isInteger(entry.Version) ||
        typeof entry.Value !== "string" || !allowed.test(entry.Value))) {
    process.exit(2);
  }
'
FSK_TASK8_WORKER_STATUS_HISTORY_SHA256="$(
  printf '%s' "$FSK_TASK8_WORKER_STATUS_HISTORY_JSON" |
    sha256sum | awk '{ print $1 }'
)"
unset FSK_TASK8_WORKER_STATUS_HISTORY_JSON
FSK_TASK8_CONTROL_STATUS_HISTORY_JSON="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter-history \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --max-results 50 \
    --query 'Parameters[].{Version:Version,LastModifiedDate:LastModifiedDate,Value:Value}' \
    --output json
)"
FSK_TASK8_CONTROL_STATUS_HISTORY_JSON="$FSK_TASK8_CONTROL_STATUS_HISTORY_JSON" node -e '
  const history = JSON.parse(process.env.FSK_TASK8_CONTROL_STATUS_HISTORY_JSON ?? "");
  const allowed = /^(CONTROL_ARMED|CLEANUP_(?:PASS|BLOCKED):[A-Z0-9_:]+)$/;
  if (!Array.isArray(history) || history.length < 2 ||
      history.some((entry) => !Number.isInteger(entry.Version) ||
        typeof entry.Value !== "string" || !allowed.test(entry.Value))) {
    process.exit(2);
  }
'
FSK_TASK8_CONTROL_STATUS_HISTORY_SHA256="$(
  printf '%s' "$FSK_TASK8_CONTROL_STATUS_HISTORY_JSON" |
    sha256sum | awk '{ print $1 }'
)"
unset FSK_TASK8_CONTROL_STATUS_HISTORY_JSON
trap - EXIT HUP INT TERM
timeout --signal=TERM --kill-after=5 20 \
  aws ssm delete-parameters --region ap-northeast-1 \
  --names "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
    "$FSK_TASK8_CONTROL_STATUS_PARAMETER" "$FSK_TASK8_STATE_PARAMETER"
FSK_TASK8_PARAMETERS_DELETED_AT_JST="$(
  TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z'
)"
FSK_TASK8_PARAMETER_RESIDUAL_COUNT="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters \
      "Key=Path,Option=Recursive,Values=/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}" \
    --query 'length(Parameters)' --output text
)"
test "$FSK_TASK8_PARAMETER_RESIDUAL_COUNT" -eq 0
```

worker 的任何失败/timeout/INT/TERM 都只写 `FAILED:*`；control poller 随即独占执行 cleanup，并把 PASS/BLOCKED 与 counts 留在 SSM 供 CleanupOwner 取证。失败路径不得删除 parameters，直到 owner 保存证据并完成 residual check。若 worker 完全丢失，control 的 deadline 分支仍会清理。不得先关 control tab。

出口复查 PASS 后，清除 CloudShell 临时文件和 shell 变量；Amplify branch secret 作为后续 full backend 所需受管 secret 暂时保留，但销毁时必须单独删除。随后在 CloudShell Console 进入 `VPC environments` → 选择 `fsk-staging-${FSK_CLOUDSHELL_TASK_ID}` → `Actions` → `Delete` 并等待从列表消失，再撤销 DB ingress、删除临时运维 SG：

```bash
set -euo pipefail
: "${FSK_DB_SECURITY_GROUP_ID:?restore the exact Foundation DB SG id}"
: "${FSK_OPS_SECURITY_GROUP_ID:?restore the exact Task 8 operations SG id}"
: "${FSK_VPC_ID:?restore the exact Foundation VPC id}"
: "${FSK_CLOUDSHELL_TASK_ID:?restore the exact Task 8 id}"
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
| WorkerStatusParameterHistory | `PENDING_SCHEMA_GENERATION_NONSECRET` |
| WorkerStatusHistorySha256 | `PENDING_SCHEMA_GENERATION_NONSECRET` |
| ControlStatusParameterHistory | `PENDING_SCHEMA_GENERATION_NONSECRET` |
| ControlStatusHistorySha256 | `PENDING_SCHEMA_GENERATION_NONSECRET` |
| TemporaryEgressControlCleanupExit | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressControlPollerExit | `PENDING_SCHEMA_GENERATION` |
| WorkerTrapDisarmedAfterControlPass | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressResidualCounts | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressCleanupAttempts | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressStableZeroObservations | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressCleanupStateChecksum | `PENDING_SCHEMA_GENERATION_NONSECRET` |
| TemporaryEgressParametersDeletedAtJst | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressParameterResidualQuery | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressDeadlineOwnerAction | `PENDING_SCHEMA_GENERATION` |
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
set -euo pipefail
: "${AMPLIFY_APP_ID:?use the exact approved staging App ID}"
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

Task 7 创建的 Amplify App/branch、Task 8 的 `SQL_CONNECTION_STRING` branch secret，以及 §2.1 的远程 `staging` ref 都由审批记录中的 `CleanupOwner` 负责，但**任何一个都不自动删除**。`fsk-staging-foundation-v1` remote tag 默认保留为零 AWS 成本的 immutable Git 审计锚点；若未来确需删除，也必须另行取得共享 Git 写入批准并以已批准 tag object ID 做 CAS deletion，本 runbook 不把销毁 App/stacks 自动扩张为删除 tag。删除需要独立销毁审批，并按以下顺序逐项留证：

1. 停止/关闭新 build，记录最后一个 job ID/status/commit；从 App home → `Hosting` → `Secrets` → `Manage secrets` 对 `staging` scope 的 `SQL_CONNECTION_STRING` 选择 `Remove`，只保存 masked 删除证据。
2. 用精确 App ID/branch ARN 在 Amplify Console 删除 `staging` branch/backend；记录删除操作前最后一个 job ID/status/commit、删除结果、操作者和 JST 时间。然后在 `All apps` 以精确 App ID 选择 `Delete app`，输入 Console 要求的确认文本，记录 request/result/time 截图；从批准证据设置 `$AMPLIFY_APP_ID` 后，用 `aws amplify list-apps --region ap-northeast-1 --query "length(apps[?appId=='${AMPLIFY_APP_ID}'])" --output text` 的只读结果 `0` 证明 App 消失。查询非零或失败都 `STOP`；不能把 branch 删除当成 App 已删除。
3. 只使用本次独立销毁批准中逐项列出的 Root/Auth/Storage/Foundation stack IDs 检查 CloudFormation terminal delete 结果；批准未列出的 stack 不删除。对每个 stack 记录 delete request/result、最终 `DELETE_COMPLETE`/不存在、操作者和时间。删除前后分别列出 Storage bucket 的 retained version/delete-marker 数量与 bytes，以及 Aurora final snapshot identifier/status/bytes；实际仍保留的 S3 versions 和 snapshot 必须记录保留原因、预计持续成本、CostOwner 和后续批准编号。`keepOnDelete` 资源不能假定随 stack 消失，也不能引用尚不存在的外部“销毁计划”代替这些结果。
4. App、stacks、S3 retained versions 和 snapshot 的实际结果及成本责任全部留证后，才处理共享 Git ref。先从最近一次批准的部署证据取得 `FSK_EXPECTED_REMOTE_STAGING_COMMIT`；只读结果不精确匹配时 `STOP`，不得删除他人更新。匹配时使用 compare-and-swap deletion；lease 的 expected value 是该批准 commit，若 ref 在核对后发生竞态更新，push 必须拒绝删除，不能重试为普通 force：

```bash
set -euo pipefail
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_EXPECTED_REMOTE_STAGING_COMMIT:?use the latest approved remote commit evidence}"
FSK_REMOTE_STAGING_BEFORE_DELETE_LINE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging
)"
FSK_REMOTE_STAGING_BEFORE_DELETE_COUNT="$(
  printf '%s\n' "$FSK_REMOTE_STAGING_BEFORE_DELETE_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_REMOTE_STAGING_BEFORE_DELETE_COUNT" -eq 1
FSK_REMOTE_STAGING_BEFORE_DELETE="$(
  printf '%s\n' "$FSK_REMOTE_STAGING_BEFORE_DELETE_LINE" |
    awk 'NR == 1 { print $1 }'
)"
if [ "$FSK_REMOTE_STAGING_BEFORE_DELETE" != "$FSK_EXPECTED_REMOTE_STAGING_COMMIT" ]; then
  echo 'REMOTE_STAGING_DELETE_GUARD_MISMATCH_STOP' >&2
  exit 1
fi
if git push \
  "--force-with-lease=refs/heads/staging:${FSK_EXPECTED_REMOTE_STAGING_COMMIT}" \
  "$FSK_GIT_REMOTE" \
  :refs/heads/staging; then
  FSK_REMOTE_DELETE_PUSH_EXIT=0
else
  echo 'REMOTE_STAGING_CAS_DELETE_REJECTED_STOP' >&2
  exit 1
fi
FSK_REMOTE_STAGING_AFTER_DELETE_LINE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging
)"
FSK_REMOTE_STAGING_AFTER_DELETE_COUNT="$(
  printf '%s\n' "$FSK_REMOTE_STAGING_AFTER_DELETE_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_REMOTE_STAGING_AFTER_DELETE_COUNT" -eq 0
FSK_REMOTE_DELETE_ACTOR="$(git config user.name)"
: "${FSK_REMOTE_DELETE_ACTOR:?configure an audited Git actor name}"
FSK_REMOTE_DELETE_AT_JST="$(TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z')"
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
| AmplifyBranchDeleteResult | `PENDING_DESTROY_GATE` |
| AmplifyAppDeleteRequest | `PENDING_DESTROY_GATE` |
| AmplifyAppDeleteResult | `PENDING_DESTROY_GATE` |
| AmplifyAppDeletedAtJst | `PENDING_DESTROY_GATE` |
| AmplifyAppPostDeleteListResult | `PENDING_DESTROY_GATE` |
| CloudFormationStackDestroyResults | `PENDING_DESTROY_GATE` |
| S3RetainedVersionCountBytes | `PENDING_DESTROY_GATE` |
| S3RetainedVersionsActualResult | `PENDING_DESTROY_GATE` |
| S3RetainedVersionsCostOwner | `PENDING_USER_APPROVAL` |
| AuroraFinalSnapshotIdentifierStatusBytes | `PENDING_DESTROY_GATE` |
| AuroraSnapshotActualResult | `PENDING_DESTROY_GATE` |
| AuroraSnapshotCostOwner | `PENDING_USER_APPROVAL` |
| ExpectedRemoteStagingCommit | `PENDING_DESTROY_GATE` |
| RemoteBranchDeletedBy | `PENDING_DESTROY_GATE` |
| RemoteBranchDeletedAtJst | `PENDING_DESTROY_GATE` |
| RemoteDeletePushEvidence | `PENDING_DESTROY_GATE` |
| RemotePostDeleteLsRemote | `PENDING_DESTROY_GATE` |
| RemoteFoundationTagDisposition | `RETAIN_IMMUTABLE_AUDIT_MARKER_UNLESS_SEPARATELY_APPROVED` |
| RemoteFoundationTagCleanupOwner | `PENDING_USER_APPROVAL` |

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
