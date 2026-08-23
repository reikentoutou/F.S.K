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
8. 从已审查的 exact commit 执行 full backend deploy；
9. 取得独立共享 Git 写入批准，将 remote `staging` 从 foundation commit 以 CAS 更新为 full-backend commit；
10. Hosting build 并核对 job commit 精确为 full-backend commit。

不得跳步或并行推进。§2.1 的共享 Git 写入和首次 AWS 写入都必须等到 Task 7 批准；执行前展示 [`staging-cost-approval.md`](./staging-cost-approval.md) 的资源表和 `MonthlyCeilingJpy`，并取得用户对“建立不可变 remote foundation tag、建立远程 staging ref、首次 staging AWS 写入及该月上限”的明确批准。完整 backend、full-backend remote CAS、Task 8 临时访问、Budget/alarms 和销毁分别有独立审批门。

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

### 3.1 临时运维访问的 control-owned 边界

从 `FskStagingFoundation` outputs 取得精确 VPC 与 DB Security Group ID，并用只读查询复验 DB SG 属于该 VPC。这里只准备 TaskId、application subnet IDs 和 Console 配置证据，**不提前创建**运维 Security Group 或 DB ingress。两者必须等到 §3.2 生成本次高熵 operation token、三个 SSM parameters 建立完成且 control EXIT/INT/TERM cleanup trap 已安装后，才由同一 control session 创建；成功和任意失败都由同一 cleanup/discovery 循环负责 revoke/delete。

运维 SG、DB ingress rule、临时出口资源与三个 SSM parameters 共同使用本次唯一 ownership tuple：AWS account `444083008754`、精确 Foundation VPC ID、TaskId 和高熵 operation token。能标记的 EC2 资源在 create/authorize 请求中一次性带齐该 tuple；响应丢失只允许用完整 tuple 反查。不能只按 group name、TaskId 或 state 中的 ID 猜测/删除。

control 创建并留存 `$FSK_OPS_SECURITY_GROUP_ID` 与 `$FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID` 后，才在 CloudShell Console 的 VPC environment 创建流程中使用名称 `fsk-staging-${FSK_CLOUDSHELL_TASK_ID}`，VPC 精确选择 `$FSK_VPC_ID`，只选择 Foundation application 私有子网，并只附加该运维 SG。截图必须能核对 environment name/ID、VPC、subnets、SG 和 region，不能包含 Secret。若 worker/Console 失败，control 先撤销精确 tagged ingress 并清理所有可计费出口；SG 因 CloudShell ENI 暂时无法删除时保持 `BLOCKED`，CleanupOwner 删除 environment 后在 cleanup deadline 内继续重试，绝不把部分清理记为 PASS。

### 3.2 Task 8 单独批准的 REQUIRED 临时出口

CloudShell VPC 中的 `pnpm install`、Secrets Manager credential 读取，以及 `ampx generate schema-from-database` 对 Amplify/SSM API 的访问都需要公网出口；本 runbook 没有已验证的无 NAT 替代路径。因此 Task 8 的 `TemporaryEgressMode` 固定为 `REQUIRED_APPROVED_TEMP_NAT`，必须先取得与 Task 7 分离的临时出口写入/成本批准并记录 `Task8ApprovalId`、`TemporaryEgressApprovalId`、最大持续时间和删除责任人。未批准则 `STOP`，不得进入本节。

允许的临时拓扑仅为：任务标签的 IGW + 单个 public subnet/route table + EIP/NAT + application route tables 的临时 `0.0.0.0/0` route；不得改数据库子网 route table。临时 NAT 必须保持到 migration、第二次 no-op、verify、branch secret 配置、两次 schema generation、无差异/安全扫描和生成物安全带回全部完成，随后立即按 §4.3 删除。

Task 8 使用两个明确的 shell 角色：

- **control session**：`ap-northeast-1` 的普通 CloudShell，负责创建临时出口、轮询任务状态并**独占执行 EC2 cleanup/residual check**；不得关闭该 tab；
- **worker session**：出口可用后打开的 VPC CloudShell environment，负责源码准备、migration、secret 门、schema generation 和安全带回；从 worker arm 到 §4.3 必须是同一个持久 shell。worker 不删除自己的默认路由，失败时通过 foundation 已有的 SSM Interface Endpoint 写入非敏感失败状态，由 control 立即清理。

两个 session 之间通过 `/fsk/staging/task8/<TaskId>/<OperationToken>/worker-status`、`/control-status` 和 `/state` 三个临时 SSM `String` parameters 只传递非敏感运行状态。control 在任何 AWS mutation 前生成两个互不相同的 UUIDv4：`BootstrapToken` 只证明三个参数的创建归属，`OperationToken` 同时进入参数 namespace、state 和所有临时 EC2 ownership tags。worker-status 只有 worker 更新；control-status 与 state 只有 control 更新。parameters 同时带项目四标签、`AccountId`、`VpcId`、`TaskId`、`BootstrapToken` 和 `OperationToken`。不得传递 Secret value、username/password、endpoint 或连接串。

control 先执行下列本地 token 生成；它不访问网络。token 是高熵、非秘密审计证据，必须与 TaskId 一起交给 worker/恢复 control，不能重新生成或只从可漂移的 state 猜测：

```bash
set -euo pipefail
test "${FSK_TASK8_SHELL_ROLE:-}" = control
FSK_TASK8_BOOTSTRAP_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomUUID())'
)"
FSK_TASK8_OPERATION_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomUUID())'
)"
test "$FSK_TASK8_BOOTSTRAP_TOKEN" != "$FSK_TASK8_OPERATION_TOKEN"
export FSK_TASK8_BOOTSTRAP_TOKEN FSK_TASK8_OPERATION_TOKEN
```

每次 mutation 后 state 保留完整 ownership/commit/deadline/resource IDs，不以 cleanup-only JSON 覆盖。cleanup 只按完整 ownership tuple 发现可标记资源，再反查由 owned target 派生的 route/association/attachment；响应丢失不依赖 shell 返回 ID。若 control session 丢失，CleanupOwner 必须从非敏感证据恢复完整 tuple 和 deadline，再运行同一 guard/cleanup，不能只用 TaskId 扫描全区域。

批准必须给出数值 Unix operation deadline `$FSK_TEMP_EGRESS_DEADLINE_EPOCH`、更晚但仍有明确上限的 cleanup deadline `$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH` 和具名 `$FSK_TEMP_EGRESS_CLEANUP_OWNER`。两个 deadline 都不得晚于审批所列的 operation/cleanup 最大持续时间；CleanupOwner 必须在独立计时器中登记 cleanup deadline，并在到期时主动进入普通 CloudShell 复查。control watchdog 每 15 秒轮询 worker-status，看到 worker `FAILED:*`、`READY_FOR_CLEANUP`、连续三次状态读取失败或 operation deadline 到达，就直接运行 cleanup，不依赖 worker 前台命令是否返回。worker 的 git/pnpm/migration/generation 命令使用 operation deadline 派生的 GNU `timeout`；不使用 `--foreground`，让 timeout 控制独立 process group 并向 pnpm/Node 子树发送 TERM/KILL。

先在 control session 通过只读 VPC/subnet/route-table 查询选择未使用的 `$FSK_TEMP_PUBLIC_CIDR`、`$FSK_TEMP_AZ` 和两个 application route table IDs，并确认两个 application route tables 当前都没有 `0.0.0.0/0` route。control 在执行下列初始化前必须设置 role 并保留刚生成的两个 token；worker 稍后从证据恢复相同 token/TaskId/VPC/deadlines，设置 `FSK_TASK8_SHELL_ROLE=worker` 后重跑同一 fence。worker 的 init EXIT/INT/TERM notification boundary 在 deadline 校验以及 state/status 读取/解析之前安装；通知自身失败时仍非零退出，control 的短 worker-init watchdog 不等待 operation 总 deadline。role guard 只让 control 定义 EC2 cleanup，worker 不拥有删除自身 route 的函数：

```bash
set -euo pipefail
export AWS_REGION=ap-northeast-1
export AWS_DEFAULT_REGION=ap-northeast-1
FSK_AWS_ACCOUNT_ID=444083008754
FSK_TASK8_SHELL_ROLE="${FSK_TASK8_SHELL_ROLE:-}"
case "$FSK_TASK8_SHELL_ROLE" in
  control|worker) ;;
  *) echo 'TASK8_SHELL_ROLE_INVALID_STOP' >&2; exit 1 ;;
esac
FSK_CLOUDSHELL_TASK_ID="${FSK_CLOUDSHELL_TASK_ID:-}"
case "$FSK_CLOUDSHELL_TASK_ID" in
  ''|*[!A-Za-z0-9_-]*) echo 'TASK8_ID_INVALID_STOP' >&2; exit 1 ;;
esac
FSK_TASK8_BOOTSTRAP_TOKEN="${FSK_TASK8_BOOTSTRAP_TOKEN:-}"
FSK_TASK8_OPERATION_TOKEN="${FSK_TASK8_OPERATION_TOKEN:-}"
FSK_TASK8_PARAMETER_PREFIX="/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}/${FSK_TASK8_OPERATION_TOKEN:-MISSING}"
FSK_TASK8_WORKER_STATUS_PARAMETER="/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}/${FSK_TASK8_OPERATION_TOKEN}/worker-status"
FSK_TASK8_CONTROL_STATUS_PARAMETER="/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}/${FSK_TASK8_OPERATION_TOKEN}/control-status"
FSK_TASK8_STATE_PARAMETER="/fsk/staging/task8/${FSK_CLOUDSHELL_TASK_ID}/${FSK_TASK8_OPERATION_TOKEN}/state"

fsk_snapshot_task8_parameter() {
  local parameter_name="${1:?parameter name required}"
  local metadata_json=''
  local tags_json=''
  metadata_json="$(
    timeout --signal=TERM --kill-after=5 20 \
      aws ssm get-parameter \
        --region ap-northeast-1 --name "$parameter_name" \
        --query 'Parameter.{Name:Name,Type:Type,Version:Version,DataType:DataType}' \
        --output json
  )" || return 1
  tags_json="$(
    timeout --signal=TERM --kill-after=5 20 \
      aws ssm list-tags-for-resource \
        --region ap-northeast-1 --resource-type Parameter \
        --resource-id "$parameter_name" --output json
  )" || return 1
  FSK_PARAMETER_METADATA_JSON="$metadata_json" \
  FSK_PARAMETER_TAGS_JSON="$tags_json" \
  FSK_PARAMETER_EXPECTED_NAME="$parameter_name" \
  FSK_AWS_ACCOUNT_ID="$FSK_AWS_ACCOUNT_ID" \
  FSK_VPC_ID="${FSK_VPC_ID:-}" \
  FSK_CLOUDSHELL_TASK_ID="$FSK_CLOUDSHELL_TASK_ID" \
  FSK_TASK8_BOOTSTRAP_TOKEN="$FSK_TASK8_BOOTSTRAP_TOKEN" \
  FSK_TASK8_OPERATION_TOKEN="$FSK_TASK8_OPERATION_TOKEN" \
  node -e '
    const metadataInput = JSON.parse(process.env.FSK_PARAMETER_METADATA_JSON ?? "");
    const metadata = metadataInput.Parameter ?? metadataInput;
    const tagsInput = JSON.parse(process.env.FSK_PARAMETER_TAGS_JSON ?? "");
    const tags = tagsInput.TagList ?? tagsInput;
    const expected = {
      Project: "FSK",
      Environment: "staging",
      ManagedBy: "AmplifyGen2",
      CostCenter: "FSK",
      AccountId: process.env.FSK_AWS_ACCOUNT_ID,
      VpcId: process.env.FSK_VPC_ID,
      TaskId: process.env.FSK_CLOUDSHELL_TASK_ID,
      BootstrapToken: process.env.FSK_TASK8_BOOTSTRAP_TOKEN,
      OperationToken: process.env.FSK_TASK8_OPERATION_TOKEN,
    };
    if (!metadata || metadata.Name !== process.env.FSK_PARAMETER_EXPECTED_NAME ||
        metadata.Type !== "String" || !Number.isInteger(metadata.Version) ||
        !Array.isArray(tags) || Object.values(expected).some((value) => !value)) {
      process.exit(2);
    }
    const byKey = new Map();
    for (const tag of tags) {
      if (typeof tag?.Key !== "string" || typeof tag?.Value !== "string" ||
          byKey.has(tag.Key)) process.exit(2);
      byKey.set(tag.Key, tag.Value);
    }
    if (Object.entries(expected).some(([key, value]) => byKey.get(key) !== value)) {
      process.exit(2);
    }
    const canonicalTags = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
    process.stdout.write(JSON.stringify({
      name: metadata.Name,
      type: metadata.Type,
      version: metadata.Version,
      dataType: metadata.DataType ?? "text",
      tags: canonicalTags,
    }));
  '
}

fsk_assert_task8_parameter_owned() {
  fsk_snapshot_task8_parameter "${1:?parameter name required}" >/dev/null
}

fsk_delete_task8_parameter_if_owned() {
  local parameter_name="${1:?parameter name required}"
  local snapshot_before=''
  local snapshot_immediate=''
  snapshot_before="$(fsk_snapshot_task8_parameter "$parameter_name")" || {
    echo "TASK8_PARAMETER_OWNERSHIP_DRIFT_BLOCKED:${parameter_name}" >&2
    return 1
  }
  snapshot_immediate="$(fsk_snapshot_task8_parameter "$parameter_name")" || {
    echo "TASK8_PARAMETER_OWNERSHIP_DRIFT_BLOCKED:${parameter_name}" >&2
    return 1
  }
  if [ "$snapshot_before" != "$snapshot_immediate" ]; then
    echo "TASK8_PARAMETER_OWNERSHIP_DRIFT_BLOCKED:${parameter_name}" >&2
    return 1
  fi
  timeout --signal=TERM --kill-after=5 20 \
    aws ssm delete-parameter --region ap-northeast-1 \
      --name "$parameter_name" >/dev/null || return 1
  local residual_count=''
  residual_count="$(timeout --signal=TERM --kill-after=5 20 \
    aws ssm describe-parameters --region ap-northeast-1 \
      --parameter-filters "Key=Name,Option=Equals,Values=${parameter_name}" \
      --query 'length(Parameters)' --output text)" || return 1
  if [ "$residual_count" -ne 0 ]; then
    echo "TASK8_PARAMETER_REAPPEARED_BLOCKED:${parameter_name}" >&2
    return 1
  fi
}

fsk_put_task8_worker_status() {
  local value="${1:?worker status value required}"
  fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
  timeout --signal=TERM --kill-after=5 20 \
    aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
      --type String --value "$value" --overwrite \
      --query Version --output text >/dev/null
  fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
}

fsk_worker_init_exit() {
  local original_status="${1:-1}"
  local phase="${FSK_WORKER_INIT_PHASE:-UNKNOWN}"
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  unset DATABASE_URL
  if ! fsk_put_task8_worker_status "FAILED:WORKER_INIT_${phase}"; then
    echo 'WORKER_INIT_NOTIFICATION_FAILED_WATCHDOG_REQUIRED' >&2
    original_status=1
  fi
  if [ "$original_status" -eq 0 ]; then original_status=1; fi
  exit "$original_status"
}

if [ "$FSK_TASK8_SHELL_ROLE" = worker ]; then
  FSK_WORKER_INIT_PHASE=COMMON_GUARD
  trap 'fsk_worker_init_exit "$?"' EXIT
  trap 'FSK_WORKER_INIT_PHASE=SIGNAL_HUP; exit 129' HUP
  trap 'FSK_WORKER_INIT_PHASE=SIGNAL_TERM; exit 130' INT TERM
fi

test "$AWS_REGION" = ap-northeast-1
test "$AWS_DEFAULT_REGION" = ap-northeast-1
: "${FSK_VPC_ID:?set the exact Foundation VpcId output}"
: "${FSK_DB_SECURITY_GROUP_ID:?set the exact Foundation database SG output}"
: "${FSK_APP_ROUTE_TABLE_A_ID:?set application route table A}"
: "${FSK_APP_ROUTE_TABLE_B_ID:?set application route table B}"
: "${FSK_FOUNDATION_COMMIT:?restore the verified foundation commit evidence}"
: "${FSK_TEMP_EGRESS_DEADLINE_EPOCH:?set the approved Unix deadline}"
: "${FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH:?set the approved cleanup Unix deadline}"
: "${FSK_TEMP_EGRESS_CLEANUP_OWNER:?set the approved cleanup owner}"
case "$FSK_TASK8_BOOTSTRAP_TOKEN" in
  ????????-????-4???-[89abAB]???-????????????) ;;
  *) echo 'TASK8_BOOTSTRAP_TOKEN_INVALID_STOP' >&2; exit 1 ;;
esac
case "$FSK_TASK8_OPERATION_TOKEN" in
  ????????-????-4???-[89abAB]???-????????????) ;;
  *) echo 'TASK8_OPERATION_TOKEN_INVALID_STOP' >&2; exit 1 ;;
esac
test "$FSK_TASK8_BOOTSTRAP_TOKEN" != "$FSK_TASK8_OPERATION_TOKEN"
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
FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS=180
FSK_TEMP_EGRESS_CLEANUP_POLL_SECONDS=15
if [ "$((FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH - FSK_TEMP_EGRESS_DEADLINE_EPOCH))" \
  -lt "$((FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS + FSK_TEMP_EGRESS_CLEANUP_POLL_SECONDS))" ]; then
  echo 'TEMP_EGRESS_CLEANUP_WINDOW_TOO_SHORT_STOP' >&2
  exit 1
fi
FSK_EFFECTIVE_AWS_ACCOUNT_ID="$(
  timeout --signal=TERM --kill-after=5 20 aws sts get-caller-identity \
    --query Account --output text
)"
test "$FSK_EFFECTIVE_AWS_ACCOUNT_ID" = "$FSK_AWS_ACCOUNT_ID"

FSK_OPS_SECURITY_GROUP_ID="${FSK_OPS_SECURITY_GROUP_ID:-}"
FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID="${FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID:-}"
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
FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH="${FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH:-0}"
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
  fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
  timeout --signal=TERM --kill-after=5 20 \
    aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
      --type String --value "$value" --overwrite \
      --query Version --output text >/dev/null
  fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
}
fi

if [ "$FSK_TASK8_SHELL_ROLE" = control ]; then
fsk_render_task8_state() {
  FSK_AWS_ACCOUNT_ID="$FSK_AWS_ACCOUNT_ID" \
  FSK_CLOUDSHELL_TASK_ID="$FSK_CLOUDSHELL_TASK_ID" \
  FSK_TASK8_BOOTSTRAP_TOKEN="$FSK_TASK8_BOOTSTRAP_TOKEN" \
  FSK_TASK8_OPERATION_TOKEN="$FSK_TASK8_OPERATION_TOKEN" \
  FSK_VPC_ID="$FSK_VPC_ID" \
  FSK_DB_SECURITY_GROUP_ID="$FSK_DB_SECURITY_GROUP_ID" \
  FSK_APP_ROUTE_TABLE_A_ID="$FSK_APP_ROUTE_TABLE_A_ID" \
  FSK_APP_ROUTE_TABLE_B_ID="$FSK_APP_ROUTE_TABLE_B_ID" \
  FSK_FOUNDATION_COMMIT="$FSK_FOUNDATION_COMMIT" \
  FSK_TEMP_EGRESS_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_DEADLINE_EPOCH" \
  FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" \
  FSK_TEMP_EGRESS_CLEANUP_OWNER="$FSK_TEMP_EGRESS_CLEANUP_OWNER" \
  FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH="${FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH:-0}" \
  FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS="$FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS" \
  FSK_OPS_SECURITY_GROUP_ID="${FSK_OPS_SECURITY_GROUP_ID:-}" \
  FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID="${FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID:-}" \
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
  FSK_CLEANUP_RESULT="${FSK_CLEANUP_RESULT:-PENDING}" \
  FSK_CLEANUP_TRIGGER="${FSK_CLEANUP_TRIGGER:-PENDING}" \
  FSK_CLEANUP_ATTEMPTS="${FSK_TEMP_EGRESS_CLEANUP_ATTEMPTS:-0}" \
  FSK_STABLE_ZERO_OBSERVATIONS="${FSK_TEMP_EGRESS_STABLE_ZERO_OBSERVATIONS:-0}" \
  FSK_STABLE_ZERO_STARTED_EPOCH="${FSK_TEMP_EGRESS_STABLE_ZERO_STARTED_EPOCH:-0}" \
  FSK_STABLE_ZERO_DURATION_SECONDS="${FSK_TEMP_EGRESS_STABLE_ZERO_DURATION_SECONDS:-0}" \
  FSK_APP_ROUTE_COUNT="${FSK_TEMP_EGRESS_APP_ROUTE_RESIDUAL_COUNT:-UNKNOWN}" \
  FSK_NAT_COUNT="${FSK_TEMP_EGRESS_NAT_RESIDUAL_COUNT:-UNKNOWN}" \
  FSK_EIP_COUNT="${FSK_TEMP_EGRESS_EIP_RESIDUAL_COUNT:-UNKNOWN}" \
  FSK_ROUTE_TABLE_COUNT="${FSK_TEMP_EGRESS_ROUTE_TABLE_RESIDUAL_COUNT:-UNKNOWN}" \
  FSK_SUBNET_COUNT="${FSK_TEMP_EGRESS_SUBNET_RESIDUAL_COUNT:-UNKNOWN}" \
  FSK_IGW_COUNT="${FSK_TEMP_EGRESS_IGW_RESIDUAL_COUNT:-UNKNOWN}" \
  FSK_OPS_SG_COUNT="${FSK_TEMP_OPS_SG_RESIDUAL_COUNT:-UNKNOWN}" \
  FSK_DB_INGRESS_COUNT="${FSK_TEMP_DB_INGRESS_RESIDUAL_COUNT:-UNKNOWN}" \
  node -e '
    const retainedKeys = [
      "FSK_AWS_ACCOUNT_ID",
      "FSK_CLOUDSHELL_TASK_ID",
      "FSK_TASK8_BOOTSTRAP_TOKEN",
      "FSK_TASK8_OPERATION_TOKEN",
      "FSK_VPC_ID",
      "FSK_DB_SECURITY_GROUP_ID",
      "FSK_APP_ROUTE_TABLE_A_ID",
      "FSK_APP_ROUTE_TABLE_B_ID",
      "FSK_FOUNDATION_COMMIT",
      "FSK_TEMP_EGRESS_DEADLINE_EPOCH",
      "FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH",
      "FSK_TEMP_EGRESS_CLEANUP_OWNER",
      "FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH",
      "FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS",
      "FSK_OPS_SECURITY_GROUP_ID",
      "FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID",
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
    const retained = Object.fromEntries(
      retainedKeys.map((key) => [key, process.env[key] ?? ""]),
    );
    process.stdout.write(JSON.stringify({
      version: 2,
      ...retained,
      cleanupResult: process.env.FSK_CLEANUP_RESULT,
      cleanupTrigger: process.env.FSK_CLEANUP_TRIGGER,
      cleanupAttempts: process.env.FSK_CLEANUP_ATTEMPTS,
      stableZeroObservations: process.env.FSK_STABLE_ZERO_OBSERVATIONS,
      stableZeroStartedEpoch: process.env.FSK_STABLE_ZERO_STARTED_EPOCH,
      stableZeroDurationSeconds: process.env.FSK_STABLE_ZERO_DURATION_SECONDS,
      counts: {
        applicationRouteCount: process.env.FSK_APP_ROUTE_COUNT,
        natGatewayCount: process.env.FSK_NAT_COUNT,
        elasticIpCount: process.env.FSK_EIP_COUNT,
        routeTableCount: process.env.FSK_ROUTE_TABLE_COUNT,
        subnetCount: process.env.FSK_SUBNET_COUNT,
        internetGatewayCount: process.env.FSK_IGW_COUNT,
        operationsSecurityGroupCount: process.env.FSK_OPS_SG_COUNT,
        databaseIngressRuleCount: process.env.FSK_DB_INGRESS_COUNT,
      },
    }));
  '
}

fsk_persist_temp_egress_state() {
  local state
  fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
  state="$(fsk_render_task8_state)"
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
  fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
}

fsk_persist_cleanup_result() {
  local result="${1:?cleanup result required}"
  local state
  FSK_CLEANUP_RESULT="$result"
  export FSK_CLEANUP_RESULT
  fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
  state="$(fsk_render_task8_state)"
  fsk_run_before_cleanup_deadline 20 aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$FSK_TASK8_STATE_PARAMETER" \
      --type String --value "$state" --overwrite \
      --query Version --output text >/dev/null
  fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
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

fsk_discover_owned_operations_security_group() {
  local ids=''
  local count=0
  ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-security-groups \
    --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'SecurityGroups[].GroupId' --output text)" || return 1
  for id in $ids; do
    [ "$id" = None ] && continue
    count=$((count + 1))
    printf '%s\n' "$id"
  done
  if [ "$count" -gt 1 ]; then
    echo 'OWNERSHIP_REVALIDATION_FAILED_BLOCKED:OPERATIONS_SG_COUNT' >&2
    return 1
  fi
}

fsk_cleanup_operations_access_once() {
  local cleanup_failed=0
  local sg_ids=''
  local rule_ids=''
  local sg_id=''
  local rule_id=''
  local value=''
  sg_ids="$(fsk_discover_owned_operations_security_group)" || cleanup_failed=1
  rule_ids="$(fsk_run_before_cleanup_deadline 30 \
    aws ec2 describe-security-group-rules \
      --region ap-northeast-1 \
      --filters "Name=group-id,Values=${FSK_DB_SECURITY_GROUP_ID}" \
        "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
        "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
        "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
        "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
      --query 'SecurityGroupRules[?IsEgress==`false` && IpProtocol==`tcp` && FromPort==`5432` && ToPort==`5432` && ReferencedGroupInfo.GroupId!=`null`].SecurityGroupRuleId' \
      --output text)" || {
        echo 'OWNERSHIP_REVALIDATION_FAILED_BLOCKED:DB_INGRESS' >&2
        cleanup_failed=1
        rule_ids=''
      }
  for rule_id in $rule_ids; do
    [ "$rule_id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    fsk_run_before_cleanup_deadline 30 \
      aws ec2 revoke-security-group-ingress \
        --region ap-northeast-1 \
        --group-id "$FSK_DB_SECURITY_GROUP_ID" \
        --security-group-rule-ids "$rule_id" >/dev/null || cleanup_failed=1
  done
  for sg_id in $sg_ids; do
    [ "$sg_id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-security-group \
      --region ap-northeast-1 --group-id "$sg_id" \
      >/dev/null || cleanup_failed=1
  done

  if value="$(fsk_run_before_cleanup_deadline 30 \
    aws ec2 describe-security-group-rules \
      --region ap-northeast-1 \
      --filters "Name=group-id,Values=${FSK_DB_SECURITY_GROUP_ID}" \
        "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
        "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
        "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
        "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
      --query 'length(SecurityGroupRules[?IsEgress==`false` && IpProtocol==`tcp` && FromPort==`5432` && ToPort==`5432` && ReferencedGroupInfo.GroupId!=`null`])' \
      --output text)" && \
      [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_DB_INGRESS_RESIDUAL_COUNT="$value"
  else
    FSK_TEMP_DB_INGRESS_RESIDUAL_COUNT=UNKNOWN
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-security-groups \
    --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'length(SecurityGroups)' --output text)" && \
      [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_OPS_SG_RESIDUAL_COUNT="$value"
  else
    FSK_TEMP_OPS_SG_RESIDUAL_COUNT=UNKNOWN
    cleanup_failed=1
  fi
  if [ "$cleanup_failed" -ne 0 ] || \
    [ "$FSK_TEMP_DB_INGRESS_RESIDUAL_COUNT" -ne 0 ] || \
    [ "$FSK_TEMP_OPS_SG_RESIDUAL_COUNT" -ne 0 ]; then
    return 1
  fi
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
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)"; then
    :
  else
    cleanup_failed=1
    nat_ids=''
  fi
  for id in "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID"; do
    if [ "$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-route-tables \
      --region ap-northeast-1 --route-table-ids "$id" \
      --query 'RouteTables[0].VpcId' --output text)" != "$FSK_VPC_ID" ]; then
      echo 'OWNERSHIP_REVALIDATION_FAILED_BLOCKED:APPLICATION_ROUTE_TABLE' >&2
      cleanup_failed=1
      continue
    fi
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
    --filters "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'Addresses[].AllocationId' --output text)"; then
    :
  else
    cleanup_failed=1
    eip_ids=''
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
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'RouteTables[].RouteTableId' --output text)"; then
    :
  else
    cleanup_failed=1
    route_table_ids=''
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
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'Subnets[].SubnetId' --output text)"; then
    :
  else
    cleanup_failed=1
    subnet_ids=''
  fi
  for id in $subnet_ids; do
    [ "$id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-subnet --region ap-northeast-1 \
      --subnet-id "$id" >/dev/null 2>&1 || true
  done

  if igw_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-internet-gateways \
    --region ap-northeast-1 \
    --filters "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'InternetGateways[].InternetGatewayId' --output text)"; then
    :
  else
    cleanup_failed=1
    igw_ids=''
  fi
  for id in $igw_ids; do
    [ "$id" = None ] && continue
    FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT=1
    attachment_vpc_ids="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-internet-gateways \
      --region ap-northeast-1 --internet-gateway-ids "$id" \
      --query 'InternetGateways[0].Attachments[].VpcId' --output text)" || \
      cleanup_failed=1
    case " ${attachment_vpc_ids:-} " in
      '  '|' None ') ;;
      " ${FSK_VPC_ID} ")
      fsk_run_before_cleanup_deadline 30 aws ec2 detach-internet-gateway --region ap-northeast-1 \
        --internet-gateway-id "$id" --vpc-id "$FSK_VPC_ID" \
        >/dev/null 2>&1 || true
        ;;
      *)
        echo 'OWNERSHIP_REVALIDATION_FAILED_BLOCKED:IGW_ATTACHMENT' >&2
        cleanup_failed=1
        continue
        ;;
    esac
    fsk_run_before_cleanup_deadline 30 aws ec2 delete-internet-gateway \
      --region ap-northeast-1 --internet-gateway-id "$id" \
      >/dev/null 2>&1 || true
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
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'length(NatGateways[?State!=`deleted`])' --output text)" && \
    [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_NAT_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-addresses --region ap-northeast-1 \
    --filters "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'length(Addresses)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_EIP_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-route-tables --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'length(RouteTables)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_ROUTE_TABLE_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-subnets --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'length(Subnets)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_SUBNET_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi
  if value="$(fsk_run_before_cleanup_deadline 30 aws ec2 describe-internet-gateways --region ap-northeast-1 \
    --filters "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
    --query 'length(InternetGateways)' --output text)" && [[ "$value" =~ ^[0-9]+$ ]]; then
    FSK_TEMP_EGRESS_IGW_RESIDUAL_COUNT="$value"
    residual_total=$((residual_total + value))
  else
    cleanup_failed=1
  fi

  if fsk_cleanup_operations_access_once; then
    residual_total=$((residual_total + FSK_TEMP_OPS_SG_RESIDUAL_COUNT + \
      FSK_TEMP_DB_INGRESS_RESIDUAL_COUNT))
  else
    cleanup_failed=1
    case "${FSK_TEMP_OPS_SG_RESIDUAL_COUNT:-UNKNOWN}" in
      ''|*[!0-9]*) ;;
      *) residual_total=$((residual_total + FSK_TEMP_OPS_SG_RESIDUAL_COUNT)) ;;
    esac
    case "${FSK_TEMP_DB_INGRESS_RESIDUAL_COUNT:-UNKNOWN}" in
      ''|*[!0-9]*) ;;
      *) residual_total=$((residual_total + FSK_TEMP_DB_INGRESS_RESIDUAL_COUNT)) ;;
    esac
  fi

  FSK_TEMP_EGRESS_RESIDUAL_TOTAL="$residual_total"
  if [ "$cleanup_failed" -ne 0 ] || [ "$residual_total" -ne 0 ]; then
    FSK_TEMP_EGRESS_CLEANUP_RUNNING=0
    if [ "$had_errexit" -eq 1 ]; then set -e; fi
    echo 'TEMP_EGRESS_CLEANUP_BLOCKED_RESIDUAL_OR_QUERY_FAILURE' >&2
    return 1
  fi
  FSK_TEMP_EGRESS_CLEANUP_RUNNING=0
  if [ "$had_errexit" -eq 1 ]; then set -e; fi
  echo 'TEMP_EGRESS_CLEANUP_PASS'
  return 0
}

fsk_cleanup_temp_egress() {
  local stable_zero_count=0
  local attempt=0
  local sleep_seconds="$FSK_TEMP_EGRESS_CLEANUP_POLL_SECONDS"
  local now=0
  FSK_TEMP_EGRESS_STABLE_ZERO_STARTED_EPOCH=0
  FSK_TEMP_EGRESS_STABLE_ZERO_DURATION_SECONDS=0
  while [ "$(date +%s)" -lt "$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" ]; do
    attempt=$((attempt + 1))
    if fsk_cleanup_temp_egress_once && \
      [ "${FSK_TEMP_EGRESS_RESIDUAL_TOTAL:-UNKNOWN}" = 0 ]; then
      if [ "${FSK_TEMP_EGRESS_RESOURCES_DISCOVERED_THIS_ATTEMPT:-1}" -eq 0 ]; then
        now="$(date +%s)"
        if [ "$stable_zero_count" -eq 0 ]; then
          FSK_TEMP_EGRESS_STABLE_ZERO_STARTED_EPOCH="$now"
        fi
        stable_zero_count=$((stable_zero_count + 1))
        FSK_TEMP_EGRESS_STABLE_ZERO_DURATION_SECONDS=$((
          now - FSK_TEMP_EGRESS_STABLE_ZERO_STARTED_EPOCH
        ))
      else
        stable_zero_count=0
        FSK_TEMP_EGRESS_STABLE_ZERO_STARTED_EPOCH=0
        FSK_TEMP_EGRESS_STABLE_ZERO_DURATION_SECONDS=0
      fi
      if [ "$stable_zero_count" -ge 3 ] && \
        [ "$FSK_TEMP_EGRESS_STABLE_ZERO_DURATION_SECONDS" -ge \
          "$FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS" ]; then
        FSK_TEMP_EGRESS_CLEANUP_ATTEMPTS="$attempt"
        FSK_TEMP_EGRESS_STABLE_ZERO_OBSERVATIONS="$stable_zero_count"
        echo 'TEMP_EGRESS_CLEANUP_MIN_WINDOW_STABLE_ZERO_PASS'
        return 0
      fi
    else
      stable_zero_count=0
      FSK_TEMP_EGRESS_STABLE_ZERO_STARTED_EPOCH=0
      FSK_TEMP_EGRESS_STABLE_ZERO_DURATION_SECONDS=0
    fi
    if [ "$(( $(date +%s) + sleep_seconds ))" -ge \
      "$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" ]; then
      break
    fi
    sleep "$sleep_seconds"
  done
  FSK_TEMP_EGRESS_CLEANUP_ATTEMPTS="$attempt"
  FSK_TEMP_EGRESS_STABLE_ZERO_OBSERVATIONS="$stable_zero_count"
  FSK_CLEANUP_RESULT=BLOCKED
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
  if fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER" && \
    control_status_before_cleanup="$(
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
      FSK_CLEANUP_TRIGGER="CONTROL_EXIT_${original_status}"
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
    elif ! fsk_assert_task8_parameter_owned \
      "$FSK_TASK8_WORKER_STATUS_PARAMETER"; then
      trigger=STATUS_OWNERSHIP_DRIFT
    elif status="$(timeout --signal=TERM --kill-after=5 20 \
      aws ssm get-parameter \
      --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
      --query Parameter.Value --output text)"; then
      read_failures=0
      case "$status" in
        FAILED:*|READY_FOR_CLEANUP) trigger="$status" ;;
        NOT_STARTED)
          if [ "${FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH:-0}" -gt 0 ] && \
            [ "$(date +%s)" -ge "$FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH" ]; then
            trigger=WORKER_INIT_TIMEOUT
          fi
          ;;
      esac
    else
      read_failures=$((read_failures + 1))
      if [ "$read_failures" -ge 3 ]; then
        trigger=STATUS_READ_FAILED
      fi
    fi

    if [ -n "$trigger" ]; then
      FSK_CLEANUP_TRIGGER="$trigger"
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

先只读确认本次高熵 namespace 下的 worker-status/control-status/state 都不存在；任一同名参数已存在时必须零写入、零删除地 `STOP`。空值确认后在第一次 parameter write 前安装 bootstrap trap。该 trap 对每个可能 response-loss 的参数重新读取 metadata 与完整 tags 两次，只在两份快照一致且 `BootstrapToken`、`OperationToken` 都属于本操作时删除；被删重建、tag/版本漂移或查询失败一律拒删并记 `BLOCKED`。三个参数都建立并复验 ownership 后，才切换为 control EC2/SSM cleanup trap；watchdog 在资源创建完成且短 worker-init deadline 写入 state 后启动：

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

fsk_delete_bootstrap_parameter_if_owned() {
  local parameter_name="${1:?parameter name required}"
  local count=''
  count="$(timeout --signal=TERM --kill-after=5 20 \
    aws ssm describe-parameters --region ap-northeast-1 \
      --parameter-filters "Key=Name,Option=Equals,Values=${parameter_name}" \
      --query 'length(Parameters)' --output text)" || return 1
  if [ "$count" -eq 0 ]; then
    return 0
  fi
  test "$count" -eq 1 || return 1
  fsk_delete_task8_parameter_if_owned "$parameter_name"
}
fsk_control_parameter_bootstrap_exit() {
  local original_status="${1:-1}"
  local blocked=0
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  fsk_delete_bootstrap_parameter_if_owned \
    "$FSK_TASK8_WORKER_STATUS_PARAMETER" || blocked=1
  fsk_delete_bootstrap_parameter_if_owned \
    "$FSK_TASK8_CONTROL_STATUS_PARAMETER" || blocked=1
  fsk_delete_bootstrap_parameter_if_owned \
    "$FSK_TASK8_STATE_PARAMETER" || blocked=1
  if [ "$blocked" -ne 0 ]; then
    echo 'TASK8_PARAMETER_BOOTSTRAP_CLEANUP_BLOCKED_OWNER_REQUIRED' >&2
  fi
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
    "Key=AccountId,Value=${FSK_AWS_ACCOUNT_ID}" \
    "Key=VpcId,Value=${FSK_VPC_ID}" \
    "Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}" \
    "Key=BootstrapToken,Value=${FSK_TASK8_BOOTSTRAP_TOKEN}" \
    "Key=OperationToken,Value=${FSK_TASK8_OPERATION_TOKEN}" \
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
    "Key=AccountId,Value=${FSK_AWS_ACCOUNT_ID}" \
    "Key=VpcId,Value=${FSK_VPC_ID}" \
    "Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}" \
    "Key=BootstrapToken,Value=${FSK_TASK8_BOOTSTRAP_TOKEN}" \
    "Key=OperationToken,Value=${FSK_TASK8_OPERATION_TOKEN}" \
  --query Version --output text
)"; then
  exit 1
fi
case "$FSK_TASK8_CONTROL_STATUS_PARAMETER_VERSION" in
  ''|*[!0-9]*) exit 1 ;;
esac
FSK_TASK8_INITIAL_STATE_JSON="$(fsk_render_task8_state)"
if ! FSK_TASK8_INITIAL_STATE_PARAMETER_VERSION="$(
  fsk_run_before_temp_egress_deadline aws ssm put-parameter \
  --region ap-northeast-1 \
  --name "$FSK_TASK8_STATE_PARAMETER" \
  --type String --value "$FSK_TASK8_INITIAL_STATE_JSON" \
  --tags \
    Key=Project,Value=FSK \
    Key=Environment,Value=staging \
    Key=ManagedBy,Value=AmplifyGen2 \
    Key=CostCenter,Value=FSK \
    "Key=AccountId,Value=${FSK_AWS_ACCOUNT_ID}" \
    "Key=VpcId,Value=${FSK_VPC_ID}" \
    "Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}" \
    "Key=BootstrapToken,Value=${FSK_TASK8_BOOTSTRAP_TOKEN}" \
    "Key=OperationToken,Value=${FSK_TASK8_OPERATION_TOKEN}" \
  --query Version --output text
)"; then
  exit 1
fi
case "$FSK_TASK8_INITIAL_STATE_PARAMETER_VERSION" in
  ''|*[!0-9]*) exit 1 ;;
esac
unset FSK_TASK8_INITIAL_STATE_JSON
fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"

trap - EXIT HUP INT TERM
trap 'fsk_control_exit "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM
fsk_persist_temp_egress_state
FSK_TEMP_EGRESS_CONTROL_PARENT_PID="$$"
export FSK_TEMP_EGRESS_CONTROL_PARENT_PID
test -n "$(trap -p EXIT)"
```

确认 control trap 和独立 CleanupOwner timer 已安装后，在**同一 control session**创建运维 SG/ingress 与出口。每个 create 都在请求中一次性带完整 ownership tags；返回 ID 丢失或命令非零时，立即用完整 tuple 反查并要求唯一结果。state 保存返回/反查 ID 只是审计证据，cleanup 仍会重新发现和复验，绝不把 state ID 直接加入 delete 集合。所有资源就绪后才设置 10 分钟 worker-init deadline 并启动 watchdog：

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
FSK_TASK8_WORKER_INIT_TIMEOUT_SECONDS=600
FSK_TEMP_EC2_TAGS="[{Key=Project,Value=FSK},{Key=Environment,Value=staging},{Key=ManagedBy,Value=AmplifyGen2},{Key=CostCenter,Value=FSK},{Key=AccountId,Value=${FSK_AWS_ACCOUNT_ID}},{Key=VpcId,Value=${FSK_VPC_ID}},{Key=TaskId,Value=${FSK_CLOUDSHELL_TASK_ID}},{Key=OperationToken,Value=${FSK_TASK8_OPERATION_TOKEN}]"
fsk_require_single_owned_id() {
  local ids="${1:-}"
  local prefix="${2:?id prefix required}"
  local count=0
  local result=''
  local id=''
  for id in $ids; do
    [ "$id" = None ] && continue
    case "$id" in
      "${prefix}"*) count=$((count + 1)); result="$id" ;;
      *) echo 'OWNERSHIP_REVALIDATION_FAILED_BLOCKED:ID_FORMAT' >&2; return 1 ;;
    esac
  done
  if [ "$count" -ne 1 ]; then
    echo 'OWNERSHIP_REVALIDATION_FAILED_BLOCKED:ID_COUNT' >&2
    return 1
  fi
  printf '%s\n' "$result"
}
FSK_VERIFIED_DB_SECURITY_GROUP_VPC_ID="$(
  fsk_run_before_temp_egress_deadline aws ec2 describe-security-groups \
    --region ap-northeast-1 --group-ids "$FSK_DB_SECURITY_GROUP_ID" \
    --query 'SecurityGroups[0].VpcId' --output text
)"
test "$FSK_VERIFIED_DB_SECURITY_GROUP_VPC_ID" = "$FSK_VPC_ID"
FSK_VERIFIED_APPLICATION_ROUTE_TABLE_VPC_IDS="$(
  fsk_run_before_temp_egress_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 \
    --route-table-ids "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID" \
    --query 'sort(RouteTables[].VpcId)' --output text
)"
test "$FSK_VERIFIED_APPLICATION_ROUTE_TABLE_VPC_IDS" = \
  "$FSK_VPC_ID\t$FSK_VPC_ID"
FSK_PREEXISTING_APP_DEFAULT_ROUTE_COUNT="$(
  fsk_run_before_temp_egress_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 \
    --route-table-ids "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID" \
    --query 'length(RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`][])' \
    --output text
)"
test "$FSK_PREEXISTING_APP_DEFAULT_ROUTE_COUNT" -eq 0

if ! FSK_OPS_SECURITY_GROUP_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-security-group \
    --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
    --group-name "fsk-staging-cloudshell-${FSK_CLOUDSHELL_TASK_ID}-${FSK_TASK8_OPERATION_TOKEN}" \
    --description "Temporary CloudShell access for ${FSK_CLOUDSHELL_TASK_ID}" \
    --tag-specifications "ResourceType=security-group,Tags=${FSK_TEMP_EC2_TAGS}" \
    --query GroupId --output text)"; then
  FSK_OPS_SECURITY_GROUP_ID=''
fi
case "$FSK_OPS_SECURITY_GROUP_ID" in
  sg-*) ;;
  *) FSK_OPS_SECURITY_GROUP_ID="$(fsk_discover_owned_operations_security_group)" ;;
esac
FSK_OPS_SECURITY_GROUP_ID="$(fsk_require_single_owned_id \
  "$FSK_OPS_SECURITY_GROUP_ID" sg-)"
fsk_persist_temp_egress_state
if ! FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID="$(
  fsk_run_before_temp_egress_deadline \
    aws ec2 authorize-security-group-ingress \
      --region ap-northeast-1 \
      --group-id "$FSK_DB_SECURITY_GROUP_ID" \
      --protocol tcp --port 5432 \
      --source-group "$FSK_OPS_SECURITY_GROUP_ID" \
      --tag-specifications "ResourceType=security-group-rule,Tags=${FSK_TEMP_EC2_TAGS}" \
      --query 'SecurityGroupRules[0].SecurityGroupRuleId' --output text
)"; then
  FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID=''
fi
case "$FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID" in
  sgr-*) ;;
  *)
    FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID="$(
      fsk_run_before_temp_egress_deadline \
        aws ec2 describe-security-group-rules \
          --region ap-northeast-1 \
          --filters "Name=group-id,Values=${FSK_DB_SECURITY_GROUP_ID}" \
            "Name=referenced-group-id,Values=${FSK_OPS_SECURITY_GROUP_ID}" \
            "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
            "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
            "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
            "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
          --query 'SecurityGroupRules[].SecurityGroupRuleId' --output text
    )"
    ;;
esac
FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID="$(fsk_require_single_owned_id \
  "$FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID" sgr-)"
fsk_persist_temp_egress_state

if ! FSK_TEMP_IGW_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-internet-gateway \
    --region ap-northeast-1 \
    --tag-specifications "ResourceType=internet-gateway,Tags=${FSK_TEMP_EC2_TAGS}" \
    --query InternetGateway.InternetGatewayId --output text)"; then
  FSK_TEMP_IGW_ID=''
fi
case "$FSK_TEMP_IGW_ID" in
  igw-*) ;;
  *) FSK_TEMP_IGW_ID="$(fsk_run_before_temp_egress_deadline \
    aws ec2 describe-internet-gateways --region ap-northeast-1 \
      --filters "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
        "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
        "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
        "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
      --query 'InternetGateways[].InternetGatewayId' --output text)" ;;
esac
FSK_TEMP_IGW_ID="$(fsk_require_single_owned_id "$FSK_TEMP_IGW_ID" igw-)"
fsk_persist_temp_egress_state
if ! fsk_run_before_temp_egress_deadline aws ec2 attach-internet-gateway \
  --region ap-northeast-1 \
  --internet-gateway-id "$FSK_TEMP_IGW_ID" --vpc-id "$FSK_VPC_ID"; then
  test "$(fsk_run_before_temp_egress_deadline \
    aws ec2 describe-internet-gateways --region ap-northeast-1 \
      --internet-gateway-ids "$FSK_TEMP_IGW_ID" \
      --query 'InternetGateways[0].Attachments[0].VpcId' --output text)" = \
    "$FSK_VPC_ID"
fi
FSK_TEMP_IGW_ATTACHED=1
fsk_persist_temp_egress_state
if ! FSK_TEMP_PUBLIC_SUBNET_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-subnet \
    --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
    --cidr-block "$FSK_TEMP_PUBLIC_CIDR" --availability-zone "$FSK_TEMP_AZ" \
    --tag-specifications "ResourceType=subnet,Tags=${FSK_TEMP_EC2_TAGS}" \
    --query Subnet.SubnetId --output text)"; then
  FSK_TEMP_PUBLIC_SUBNET_ID=''
fi
case "$FSK_TEMP_PUBLIC_SUBNET_ID" in
  subnet-*) ;;
  *) FSK_TEMP_PUBLIC_SUBNET_ID="$(fsk_run_before_temp_egress_deadline \
    aws ec2 describe-subnets --region ap-northeast-1 \
      --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
        "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
        "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
        "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
        "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
      --query 'Subnets[].SubnetId' --output text)" ;;
esac
FSK_TEMP_PUBLIC_SUBNET_ID="$(fsk_require_single_owned_id \
  "$FSK_TEMP_PUBLIC_SUBNET_ID" subnet-)"
fsk_persist_temp_egress_state
if ! FSK_TEMP_PUBLIC_ROUTE_TABLE_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-route-table \
    --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
    --tag-specifications "ResourceType=route-table,Tags=${FSK_TEMP_EC2_TAGS}" \
    --query RouteTable.RouteTableId --output text)"; then
  FSK_TEMP_PUBLIC_ROUTE_TABLE_ID=''
fi
case "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" in
  rtb-*) ;;
  *) FSK_TEMP_PUBLIC_ROUTE_TABLE_ID="$(fsk_run_before_temp_egress_deadline \
    aws ec2 describe-route-tables --region ap-northeast-1 \
      --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
        "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
        "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
        "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
        "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
      --query 'RouteTables[].RouteTableId' --output text)" ;;
esac
FSK_TEMP_PUBLIC_ROUTE_TABLE_ID="$(fsk_require_single_owned_id \
  "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" rtb-)"
fsk_persist_temp_egress_state
if ! FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 associate-route-table \
    --region ap-northeast-1 --route-table-id "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
    --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" \
    --query AssociationId --output text)"; then
  FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID="$(
    fsk_run_before_temp_egress_deadline aws ec2 describe-route-tables \
      --region ap-northeast-1 --route-table-ids "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
      --query "RouteTables[0].Associations[?SubnetId=='${FSK_TEMP_PUBLIC_SUBNET_ID}'].RouteTableAssociationId" \
      --output text
  )"
fi
FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID="$(fsk_require_single_owned_id \
  "$FSK_TEMP_PUBLIC_ROUTE_ASSOCIATION_ID" rtbassoc-)"
fsk_persist_temp_egress_state
if ! fsk_run_before_temp_egress_deadline aws ec2 create-route \
  --region ap-northeast-1 \
  --route-table-id "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
  --destination-cidr-block 0.0.0.0/0 --gateway-id "$FSK_TEMP_IGW_ID"; then
  test "$(fsk_run_before_temp_egress_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 --route-table-ids "$FSK_TEMP_PUBLIC_ROUTE_TABLE_ID" \
    --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].GatewayId | [0]' \
    --output text)" = "$FSK_TEMP_IGW_ID"
fi
FSK_TEMP_PUBLIC_DEFAULT_ROUTE_CREATED=1
fsk_persist_temp_egress_state
if ! FSK_TEMP_EIP_ALLOCATION_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 allocate-address \
    --region ap-northeast-1 --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=${FSK_TEMP_EC2_TAGS}" \
    --query AllocationId --output text)"; then
  FSK_TEMP_EIP_ALLOCATION_ID=''
fi
case "$FSK_TEMP_EIP_ALLOCATION_ID" in
  eipalloc-*) ;;
  *) FSK_TEMP_EIP_ALLOCATION_ID="$(fsk_run_before_temp_egress_deadline \
    aws ec2 describe-addresses --region ap-northeast-1 \
      --filters "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
        "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
        "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
        "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
      --query 'Addresses[].AllocationId' --output text)" ;;
esac
FSK_TEMP_EIP_ALLOCATION_ID="$(fsk_require_single_owned_id \
  "$FSK_TEMP_EIP_ALLOCATION_ID" eipalloc-)"
fsk_persist_temp_egress_state
if ! FSK_TEMP_NAT_GATEWAY_ID="$(fsk_run_before_temp_egress_deadline \
  aws ec2 create-nat-gateway \
    --region ap-northeast-1 --connectivity-type public \
    --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" \
    --allocation-id "$FSK_TEMP_EIP_ALLOCATION_ID" \
    --tag-specifications "ResourceType=natgateway,Tags=${FSK_TEMP_EC2_TAGS}" \
    --query NatGateway.NatGatewayId --output text)"; then
  FSK_TEMP_NAT_GATEWAY_ID=''
fi
case "$FSK_TEMP_NAT_GATEWAY_ID" in
  nat-*) ;;
  *) FSK_TEMP_NAT_GATEWAY_ID="$(fsk_run_before_temp_egress_deadline \
    aws ec2 describe-nat-gateways --region ap-northeast-1 \
      --filter "Name=vpc-id,Values=${FSK_VPC_ID}" \
        "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
        "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
        "Name=tag:TaskId,Values=${FSK_CLOUDSHELL_TASK_ID}" \
        "Name=tag:OperationToken,Values=${FSK_TASK8_OPERATION_TOKEN}" \
      --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text)" ;;
esac
FSK_TEMP_NAT_GATEWAY_ID="$(fsk_require_single_owned_id \
  "$FSK_TEMP_NAT_GATEWAY_ID" nat-)"
fsk_persist_temp_egress_state
fsk_run_before_temp_egress_deadline aws ec2 wait nat-gateway-available \
  --region ap-northeast-1 \
  --nat-gateway-ids "$FSK_TEMP_NAT_GATEWAY_ID"
if ! fsk_run_before_temp_egress_deadline aws ec2 create-route \
  --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_A_ID" \
  --destination-cidr-block 0.0.0.0/0 \
  --nat-gateway-id "$FSK_TEMP_NAT_GATEWAY_ID"; then
  test "$(fsk_run_before_temp_egress_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 --route-table-ids "$FSK_APP_ROUTE_TABLE_A_ID" \
    --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId | [0]' \
    --output text)" = "$FSK_TEMP_NAT_GATEWAY_ID"
fi
FSK_TEMP_APP_ROUTE_A_CREATED=1
fsk_persist_temp_egress_state
if ! fsk_run_before_temp_egress_deadline aws ec2 create-route \
  --region ap-northeast-1 \
  --route-table-id "$FSK_APP_ROUTE_TABLE_B_ID" \
  --destination-cidr-block 0.0.0.0/0 \
  --nat-gateway-id "$FSK_TEMP_NAT_GATEWAY_ID"; then
  test "$(fsk_run_before_temp_egress_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 --route-table-ids "$FSK_APP_ROUTE_TABLE_B_ID" \
    --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId | [0]' \
    --output text)" = "$FSK_TEMP_NAT_GATEWAY_ID"
fi
FSK_TEMP_APP_ROUTE_B_CREATED=1
fsk_persist_temp_egress_state
fsk_assert_temp_egress_deadline
FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH=$((
  $(date +%s) + FSK_TASK8_WORKER_INIT_TIMEOUT_SECONDS
))
if [ "$FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH" -ge \
  "$FSK_TEMP_EGRESS_DEADLINE_EPOCH" ]; then
  echo 'WORKER_INIT_WINDOW_EXCEEDS_OPERATION_DEADLINE_STOP' >&2
  exit 1
fi
fsk_persist_temp_egress_state
fsk_control_watchdog &
FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID="$!"
test -n "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID"
unset FSK_TEMP_EC2_TAGS
```

创建后记录 state parameter version、所有资源 ID/marker、application route table IDs、deadline、创建时间、批准编号、control session actor 和 `CleanupOwner`；只读确认两个 application route table 的默认路由都精确指向该临时 NAT。control session 和 poller 保持打开。

随后打开 VPC worker session，从批准证据恢复 account/VPC/DB SG、application route table IDs、foundation commit、两个 token、operation/cleanup/worker-init deadlines、TaskId 和 CleanupOwner，执行 `export FSK_TASK8_SHELL_ROLE=worker`，再重跑 common guard/function 初始化 fence。common fence 已在任何 deadline/state/status 读取或解析前安装 init 失败通知 trap；下面只分阶段收紧失败码，完成全部初始化后才切换到 runtime trap。worker 通过 SSM Interface Endpoint 读取 state（不得打印）并保存 checksum；两种 trap 都不调用 EC2 cleanup，control poller 才是唯一清理执行者：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = worker
case "$(trap -p EXIT)" in
  *fsk_worker_init_exit*) ;;
  *) echo 'WORKER_INIT_NOTIFICATION_BOUNDARY_MISSING_STOP' >&2; exit 1 ;;
esac
declare -F fsk_worker_exit >/dev/null
FSK_WORKER_INIT_PHASE=DEADLINE_CHECK
fsk_assert_temp_egress_deadline
FSK_WORKER_INIT_PHASE=STATE_READ
fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
FSK_TASK8_STATE_JSON="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_STATE_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
FSK_WORKER_INIT_PHASE=STATE_CHECKSUM
FSK_TASK8_STATE_SHA256="$(
  printf '%s' "$FSK_TASK8_STATE_JSON" | sha256sum | awk '{ print $1 }'
)"
FSK_WORKER_INIT_PHASE=STATE_PARSE
FSK_TASK8_STATE_JSON="$FSK_TASK8_STATE_JSON" \
FSK_AWS_ACCOUNT_ID="$FSK_AWS_ACCOUNT_ID" \
FSK_CLOUDSHELL_TASK_ID="$FSK_CLOUDSHELL_TASK_ID" \
FSK_TASK8_BOOTSTRAP_TOKEN="$FSK_TASK8_BOOTSTRAP_TOKEN" \
FSK_TASK8_OPERATION_TOKEN="$FSK_TASK8_OPERATION_TOKEN" \
FSK_VPC_ID="$FSK_VPC_ID" \
FSK_DB_SECURITY_GROUP_ID="$FSK_DB_SECURITY_GROUP_ID" \
FSK_APP_ROUTE_TABLE_A_ID="$FSK_APP_ROUTE_TABLE_A_ID" \
FSK_APP_ROUTE_TABLE_B_ID="$FSK_APP_ROUTE_TABLE_B_ID" \
FSK_TEMP_EGRESS_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_DEADLINE_EPOCH" \
FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" \
FSK_TEMP_EGRESS_CLEANUP_OWNER="$FSK_TEMP_EGRESS_CLEANUP_OWNER" \
FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH="$FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH" \
FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS="$FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS" \
FSK_FOUNDATION_COMMIT="$FSK_FOUNDATION_COMMIT" \
node -e '
  const state = JSON.parse(process.env.FSK_TASK8_STATE_JSON ?? "");
  const expected = {
    FSK_AWS_ACCOUNT_ID: process.env.FSK_AWS_ACCOUNT_ID,
    FSK_CLOUDSHELL_TASK_ID: process.env.FSK_CLOUDSHELL_TASK_ID,
    FSK_TASK8_BOOTSTRAP_TOKEN: process.env.FSK_TASK8_BOOTSTRAP_TOKEN,
    FSK_TASK8_OPERATION_TOKEN: process.env.FSK_TASK8_OPERATION_TOKEN,
    FSK_VPC_ID: process.env.FSK_VPC_ID,
    FSK_DB_SECURITY_GROUP_ID: process.env.FSK_DB_SECURITY_GROUP_ID,
    FSK_APP_ROUTE_TABLE_A_ID: process.env.FSK_APP_ROUTE_TABLE_A_ID,
    FSK_APP_ROUTE_TABLE_B_ID: process.env.FSK_APP_ROUTE_TABLE_B_ID,
    FSK_FOUNDATION_COMMIT: process.env.FSK_FOUNDATION_COMMIT,
    FSK_TEMP_EGRESS_DEADLINE_EPOCH: process.env.FSK_TEMP_EGRESS_DEADLINE_EPOCH,
    FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH:
      process.env.FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH,
    FSK_TEMP_EGRESS_CLEANUP_OWNER: process.env.FSK_TEMP_EGRESS_CLEANUP_OWNER,
    FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH:
      process.env.FSK_TASK8_WORKER_INIT_DEADLINE_EPOCH,
    FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS:
      process.env.FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS,
  };
  const resourceKeys = [
    "FSK_OPS_SECURITY_GROUP_ID",
    "FSK_DB_INGRESS_SECURITY_GROUP_RULE_ID",
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
  const allowed = new Set([
    "version", ...Object.keys(expected), ...resourceKeys,
    "cleanupResult", "cleanupTrigger", "cleanupAttempts",
    "stableZeroObservations", "stableZeroStartedEpoch",
    "stableZeroDurationSeconds", "counts",
  ]);
  if (state.version !== 2 || state.cleanupResult !== "PENDING" ||
      Object.keys(state).some((key) => !allowed.has(key)) ||
      Object.entries(expected).some(([key, value]) => state[key] !== value) ||
      resourceKeys.some((key) => typeof state[key] !== "string")) {
    process.exit(2);
  }
'
unset FSK_TASK8_STATE_JSON
FSK_WORKER_INIT_PHASE=CONTROL_STATUS_READ
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
FSK_TASK8_CONTROL_STATUS="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
test "$FSK_TASK8_CONTROL_STATUS" = CONTROL_ARMED
FSK_WORKER_INIT_PHASE=WORKER_STATUS_READ
fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
FSK_TASK8_WORKER_STATUS="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
test "$FSK_TASK8_WORKER_STATUS" = NOT_STARTED
FSK_WORKER_INIT_PHASE=WORKER_STATUS_RUNNING_WRITE
fsk_put_task8_worker_status WORKER_RUNNING
FSK_WORKER_INIT_PHASE=CONTROL_STATUS_RECHECK
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
FSK_TASK8_CONTROL_STATUS="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
test "$FSK_TASK8_CONTROL_STATUS" = CONTROL_ARMED
FSK_WORKER_INIT_PHASE=COMPLETE
trap - EXIT HUP INT TERM
trap 'fsk_worker_exit "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM
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

安全带回完成后，worker 不调用 EC2 cleanup，而是只把自己的 worker-status 从 `WORKER_RUNNING` 更新为 `READY_FOR_CLEANUP`；它永远不写 control-status。写入前后都复验 parameter ownership。随后 worker 清除 shell 中的敏感变量、解除 runtime trap 并关闭 tab，不等待自己的 SG 被删除。操作者必须立即从 CloudShell Console 删除精确名称/ID 的 VPC environment，使 control-owned cleanup 能在同一 cleanup deadline 内重试删除 ENI 释放后的 SG。

control poller 看到 `READY_FOR_CLEANUP`、任意 `FAILED:*`、worker-init timeout/status 读取失败或 operation deadline 后，在明确 cleanup deadline 内重复 discovery→delete→residual。它只在至少 180 秒的稳定全零观察窗口内且至少三次连续全零后写 `CLEANUP_PASS:<trigger>`；任何超时、查询失败或残留都写 `CLEANUP_BLOCKED:*`并保留 CleanupOwner/费用责任：

```bash
set -euo pipefail
test "${FSK_SAFE_BRINGBACK_CONFIRMED:-0}" -eq 1
test "$FSK_TASK8_SHELL_ROLE" = worker
declare -F fsk_worker_exit >/dev/null
test -n "$(trap -p EXIT)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
FSK_TASK8_WORKER_STATUS="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
test "$FSK_TASK8_WORKER_STATUS" = WORKER_RUNNING
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
FSK_TASK8_CONTROL_STATUS="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
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
FSK_TASK8_WORKER_READY_AT_JST="$(TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z')"
unset DATABASE_URL FSK_TASK8_STATE_JSON FSK_TASK8_CONTROL_STATUS
trap - EXIT HUP INT TERM
```

worker fence 成功后立即关闭 worker tab并删除 VPC environment；删除前/后截图只记录 environment name/ID、VPC、subnets、SG 和时间，不记录 secret。随后回到仍打开的 control session，等待 poller 子进程。poller 非零、control-status `BLOCKED`或 cleanup state 不满足八类资源在最小时长窗口内稳定全零时，必须保留 trap、parameters、CleanupOwner 和持续费用责任，不得进入 full backend。

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = control
declare -F fsk_control_exit >/dev/null
test -n "$(trap -p EXIT)"
: "${FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID:?control poller pid missing}"
: "${FSK_CLOUDSHELL_ENVIRONMENT_DELETION_EVIDENCE_SHA256:?save nonsecret before/after deletion evidence}"
if wait "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID"; then
  FSK_TEMP_EGRESS_CONTROL_WATCHDOG_EXIT=0
else
  FSK_TEMP_EGRESS_CONTROL_WATCHDOG_EXIT=$?
fi
test "$FSK_TEMP_EGRESS_CONTROL_WATCHDOG_EXIT" -eq 0
FSK_TEMP_EGRESS_CONTROL_WATCHDOG_PID=''
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
FSK_CONTROL_STATUS_EVIDENCE="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
case "$FSK_CONTROL_STATUS_EVIDENCE" in
  CLEANUP_PASS:*) ;;
  CLEANUP_BLOCKED:*)
    echo 'CONTROL_CLEANUP_BLOCKED_OWNER_ACTION_REQUIRED' >&2
    exit 1
    ;;
  *) echo 'TASK8_CONTROL_STATUS_UNEXPECTED_STOP' >&2; exit 1 ;;
esac
fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
FSK_CONTROL_STATE_EVIDENCE="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_TASK8_STATE_PARAMETER" \
    --query Parameter.Value --output text
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_STATE_PARAMETER"
FSK_CONTROL_STATE_EVIDENCE_SHA256="$(
  printf '%s' "$FSK_CONTROL_STATE_EVIDENCE" | sha256sum | awk '{ print $1 }'
)"
FSK_CONTROL_STATE_EVIDENCE="$FSK_CONTROL_STATE_EVIDENCE" \
FSK_CONTROL_STATUS_EVIDENCE="$FSK_CONTROL_STATUS_EVIDENCE" \
FSK_AWS_ACCOUNT_ID="$FSK_AWS_ACCOUNT_ID" \
FSK_CLOUDSHELL_TASK_ID="$FSK_CLOUDSHELL_TASK_ID" \
FSK_TASK8_BOOTSTRAP_TOKEN="$FSK_TASK8_BOOTSTRAP_TOKEN" \
FSK_TASK8_OPERATION_TOKEN="$FSK_TASK8_OPERATION_TOKEN" \
FSK_VPC_ID="$FSK_VPC_ID" \
FSK_DB_SECURITY_GROUP_ID="$FSK_DB_SECURITY_GROUP_ID" \
FSK_FOUNDATION_COMMIT="$FSK_FOUNDATION_COMMIT" \
FSK_TEMP_EGRESS_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_DEADLINE_EPOCH" \
FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH="$FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH" \
FSK_TEMP_EGRESS_CLEANUP_OWNER="$FSK_TEMP_EGRESS_CLEANUP_OWNER" \
FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS="$FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS" \
node -e '
  const state = JSON.parse(process.env.FSK_CONTROL_STATE_EVIDENCE ?? "");
  const expectedOwnership = {
    FSK_AWS_ACCOUNT_ID: process.env.FSK_AWS_ACCOUNT_ID,
    FSK_CLOUDSHELL_TASK_ID: process.env.FSK_CLOUDSHELL_TASK_ID,
    FSK_TASK8_BOOTSTRAP_TOKEN: process.env.FSK_TASK8_BOOTSTRAP_TOKEN,
    FSK_TASK8_OPERATION_TOKEN: process.env.FSK_TASK8_OPERATION_TOKEN,
    FSK_VPC_ID: process.env.FSK_VPC_ID,
    FSK_DB_SECURITY_GROUP_ID: process.env.FSK_DB_SECURITY_GROUP_ID,
    FSK_FOUNDATION_COMMIT: process.env.FSK_FOUNDATION_COMMIT,
    FSK_TEMP_EGRESS_DEADLINE_EPOCH: process.env.FSK_TEMP_EGRESS_DEADLINE_EPOCH,
    FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH:
      process.env.FSK_TEMP_EGRESS_CLEANUP_DEADLINE_EPOCH,
    FSK_TEMP_EGRESS_CLEANUP_OWNER: process.env.FSK_TEMP_EGRESS_CLEANUP_OWNER,
  };
  const countKeys = [
    "applicationRouteCount", "natGatewayCount", "elasticIpCount",
    "routeTableCount", "subnetCount", "internetGatewayCount",
    "operationsSecurityGroupCount", "databaseIngressRuleCount",
  ];
  const trigger = (process.env.FSK_CONTROL_STATUS_EVIDENCE ?? "")
    .replace(/^CLEANUP_PASS:/, "");
  if (state.version !== 2 || state.cleanupResult !== "PASS" ||
      state.cleanupTrigger !== trigger ||
      Object.entries(expectedOwnership).some(([key, value]) => state[key] !== value) ||
      !/^\d+$/.test(state.cleanupAttempts ?? "") ||
      Number(state.cleanupAttempts) < 1 ||
      Number(state.stableZeroObservations) < 3 ||
      Number(state.stableZeroDurationSeconds) <
        Number(process.env.FSK_TEMP_EGRESS_MIN_ZERO_OBSERVATION_SECONDS) ||
      countKeys.some((key) => state.counts?.[key] !== "0")) {
    process.exit(2);
  }
'
fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
FSK_TASK8_WORKER_STATUS_HISTORY_JSON="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter-history \
    --region ap-northeast-1 --name "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
    --max-results 50 \
    --query 'Parameters[].{Version:Version,LastModifiedDate:LastModifiedDate,Value:Value}' \
    --output json
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_WORKER_STATUS_PARAMETER"
FSK_TASK8_WORKER_STATUS_HISTORY_JSON="$FSK_TASK8_WORKER_STATUS_HISTORY_JSON" node -e '
  const history = JSON.parse(process.env.FSK_TASK8_WORKER_STATUS_HISTORY_JSON ?? "");
  const allowed = /^(NOT_STARTED|WORKER_RUNNING|READY_FOR_CLEANUP|FAILED:[A-Z0-9_]+)$/;
  if (!Array.isArray(history) || history.length < 1 ||
      !history.some((entry) => entry.Version === 1 && entry.Value === "NOT_STARTED") ||
      history.some((entry) => !Number.isInteger(entry.Version) ||
        typeof entry.Value !== "string" || !allowed.test(entry.Value))) {
    process.exit(2);
  }
'
FSK_TASK8_WORKER_STATUS_HISTORY_SHA256="$(
  printf '%s' "$FSK_TASK8_WORKER_STATUS_HISTORY_JSON" |
    sha256sum | awk '{ print $1 }'
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
FSK_TASK8_CONTROL_STATUS_HISTORY_JSON="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm get-parameter-history \
    --region ap-northeast-1 --name "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
    --max-results 50 \
    --query 'Parameters[].{Version:Version,LastModifiedDate:LastModifiedDate,Value:Value}' \
    --output json
)"
fsk_assert_task8_parameter_owned "$FSK_TASK8_CONTROL_STATUS_PARAMETER"
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
FSK_TASK8_FINAL_EVIDENCE_CAPTURED_AT_JST="$(
  TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z'
)"
FSK_TASK8_FINAL_EVIDENCE_JSON="$(
  FSK_CONTROL_STATE_EVIDENCE="$FSK_CONTROL_STATE_EVIDENCE" \
  FSK_CONTROL_STATUS_EVIDENCE="$FSK_CONTROL_STATUS_EVIDENCE" \
  FSK_CONTROL_STATE_EVIDENCE_SHA256="$FSK_CONTROL_STATE_EVIDENCE_SHA256" \
  FSK_TASK8_WORKER_STATUS_HISTORY_JSON="$FSK_TASK8_WORKER_STATUS_HISTORY_JSON" \
  FSK_TASK8_WORKER_STATUS_HISTORY_SHA256="$FSK_TASK8_WORKER_STATUS_HISTORY_SHA256" \
  FSK_TASK8_CONTROL_STATUS_HISTORY_JSON="$FSK_TASK8_CONTROL_STATUS_HISTORY_JSON" \
  FSK_TASK8_CONTROL_STATUS_HISTORY_SHA256="$FSK_TASK8_CONTROL_STATUS_HISTORY_SHA256" \
  FSK_CLOUDSHELL_ENVIRONMENT_DELETION_EVIDENCE_SHA256="$FSK_CLOUDSHELL_ENVIRONMENT_DELETION_EVIDENCE_SHA256" \
  FSK_TASK8_FINAL_EVIDENCE_CAPTURED_AT_JST="$FSK_TASK8_FINAL_EVIDENCE_CAPTURED_AT_JST" \
  node -e '
    process.stdout.write(JSON.stringify({
      version: 1,
      task8State: JSON.parse(process.env.FSK_CONTROL_STATE_EVIDENCE ?? ""),
      controlStatus: process.env.FSK_CONTROL_STATUS_EVIDENCE,
      stateSha256: process.env.FSK_CONTROL_STATE_EVIDENCE_SHA256,
      workerStatusHistory:
        JSON.parse(process.env.FSK_TASK8_WORKER_STATUS_HISTORY_JSON ?? ""),
      workerStatusHistorySha256:
        process.env.FSK_TASK8_WORKER_STATUS_HISTORY_SHA256,
      controlStatusHistory:
        JSON.parse(process.env.FSK_TASK8_CONTROL_STATUS_HISTORY_JSON ?? ""),
      controlStatusHistorySha256:
        process.env.FSK_TASK8_CONTROL_STATUS_HISTORY_SHA256,
      cloudShellEnvironmentDeletionEvidenceSha256:
        process.env.FSK_CLOUDSHELL_ENVIRONMENT_DELETION_EVIDENCE_SHA256,
      capturedAtJst: process.env.FSK_TASK8_FINAL_EVIDENCE_CAPTURED_AT_JST,
    }));
  '
)"
FSK_TASK8_FINAL_EVIDENCE_SHA256="$(
  printf '%s' "$FSK_TASK8_FINAL_EVIDENCE_JSON" | sha256sum | awk '{ print $1 }'
)"
printf 'Task8FinalEvidence=%s\n' "$FSK_TASK8_FINAL_EVIDENCE_JSON"
printf 'Task8FinalEvidenceSha256=%s\n' "$FSK_TASK8_FINAL_EVIDENCE_SHA256"
FSK_TASK8_FINAL_EVIDENCE_READY=1
export FSK_TASK8_FINAL_EVIDENCE_READY
```

上述 JSON 是独立于临时 SSM 的最终非敏感证据，完整保留 account/VPC/TaskId/tokens、resource IDs、foundation commit、deadlines、稳定全零窗口和 cleanup 结果；不得只保存 cleanup-only 片段。将 JSON 和 checksum 写入已批准的审计记录后，设置 `FSK_TASK8_FINAL_EVIDENCE_SAVED=1`。三个 parameter 逐个删除，每个都在 delete 前立即取两份 metadata/tags/version 快照并比对两个 token；任一个被删重建、版本/tag 漂移、查询失败或删除后重现，立即 `BLOCKED`，不得继续删除：

```bash
set -euo pipefail
test "$FSK_TASK8_SHELL_ROLE" = control
declare -F fsk_control_exit >/dev/null
declare -F fsk_delete_task8_parameter_if_owned >/dev/null
test -n "$(trap -p EXIT)"
test "${FSK_TASK8_FINAL_EVIDENCE_READY:-0}" -eq 1
test "${FSK_TASK8_FINAL_EVIDENCE_SAVED:-0}" -eq 1
FSK_TASK8_PARAMETER_DELETION_RESULT=BLOCKED
for parameter_name in \
  "$FSK_TASK8_WORKER_STATUS_PARAMETER" \
  "$FSK_TASK8_CONTROL_STATUS_PARAMETER" \
  "$FSK_TASK8_STATE_PARAMETER"; do
  if ! fsk_delete_task8_parameter_if_owned "$parameter_name"; then
    echo "TASK8_PARAMETER_FINAL_DELETE_BLOCKED:${parameter_name}" >&2
    exit 1
  fi
done
FSK_TASK8_PARAMETER_RESIDUAL_COUNT="$(
  timeout --signal=TERM --kill-after=5 20 aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters \
      "Key=Path,Option=Recursive,Values=${FSK_TASK8_PARAMETER_PREFIX}" \
    --query 'length(Parameters)' --output text
)"
if [ "$FSK_TASK8_PARAMETER_RESIDUAL_COUNT" -ne 0 ]; then
  echo 'TASK8_PARAMETER_FINAL_RESIDUAL_BLOCKED' >&2
  exit 1
fi
FSK_TASK8_PARAMETER_DELETION_RESULT=PASS
FSK_TASK8_PARAMETERS_DELETED_AT_JST="$(
  TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z'
)"
trap - EXIT HUP INT TERM
```

worker 的任何失败/timeout/INT/TERM 都只写 `FAILED:*`；control poller 随即独占执行 cleanup，并把全量 state、PASS/BLOCKED 与 counts 留在 SSM 供 CleanupOwner 取证。失败触发但 cleanup PASS 时，owner 保存完整最终证据后仍只能使用上述 owned-delete fence；cleanup BLOCKED 时不删 parameters，直到 owner 保存证据并在新批准的 deadline 中完成 residual remediation。若 worker 完全丢失，control 的 worker-init/operation deadline 分支仍会清理。不得先关 control tab。

CloudShell VPC environment 删除、DB ingress revoke 和运维 SG delete 已全部包含在上述 worker handoff + control cleanup 边界，不再运行独立、TaskId-only 的 SG cleanup 命令。Amplify branch secret 作为后续 full backend 所需受管 secret 暂时保留，但销毁时必须单独删除。CloudShell environment 已从列表消失、八类 residual count 稳定全零、最小观察时长达标、最终证据已保存且 parameters 安全删除缺一不可；未确认不得进入 full backend deploy。

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
| WorkerTrapDisarmedAfterReadyHandoff | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressResidualCounts | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressCleanupAttempts | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressStableZeroObservations | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressStableZeroDurationSeconds | `PENDING_SCHEMA_GENERATION` |
| TemporaryEgressMinimumObservationSeconds | `180` |
| TemporaryEgressCleanupStateChecksum | `PENDING_SCHEMA_GENERATION_NONSECRET` |
| Task8OperationToken | `PENDING_TASK8_APPROVAL_NONSECRET` |
| Task8WorkerInitDeadlineEpoch | `PENDING_TASK8_APPROVAL` |
| OperationsSecurityGroupResidualCount | `PENDING_SCHEMA_GENERATION` |
| DatabaseIngressRuleResidualCount | `PENDING_SCHEMA_GENERATION` |
| Task8FinalEvidenceSha256 | `PENDING_SCHEMA_GENERATION_NONSECRET` |
| Task8ParameterDeletionResult | `PENDING_SCHEMA_GENERATION` |
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

先展示最终 backend diff、AppSync/SQL Lambda/业务 Functions/日志资源和更新后的成本表，并把已审查 full-backend commit 固化为 `$FSK_APPROVED_FULL_BACKEND_COMMIT`。只有用户明确批准第二次全栈 AWS 写入后才从该 exact clean commit 执行：

```bash
set -euo pipefail
: "${AMPLIFY_APP_ID:?use the exact approved staging App ID}"
: "${FSK_APPROVED_FULL_BACKEND_COMMIT:?use the reviewed full-backend commit}"
case "$FSK_APPROVED_FULL_BACKEND_COMMIT" in
  *[!0-9a-f]*|'') echo 'FULL_BACKEND_COMMIT_INVALID_STOP' >&2; exit 1 ;;
esac
test "${#FSK_APPROVED_FULL_BACKEND_COMMIT}" -eq 40
test "$(git rev-parse HEAD)" = "$FSK_APPROVED_FULL_BACKEND_COMMIT"
test -z "$(git status --short)"
AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 CI=1 \
  pnpm exec ampx pipeline-deploy \
    --branch staging --app-id "$AMPLIFY_APP_ID" \
    --outputs-out-dir apps/web/public
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

全栈 AWS deploy 成功后，先核对 stack outputs、实际 diff 和 `$FSK_APPROVED_FULL_BACKEND_COMMIT`，再取得一个与 full backend AWS 写入分离的共享 Git ref 更新批准 `FullBackendRemoteCasApprovalId`。expected 只能是已验证 foundation commit，new 只能是已审查 full-backend commit；remote 已漂移、lease 竞态失败或更新后复验不等时都 `STOP`，不得改用普通 force：

```bash
set -euo pipefail
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_FOUNDATION_COMMIT:?use the verified foundation commit evidence}"
: "${FSK_APPROVED_FULL_BACKEND_COMMIT:?use the reviewed full-backend commit}"
: "${FSK_FULL_BACKEND_REMOTE_CAS_APPROVAL_ID:?independent shared Git approval required}"
FSK_EXPECTED_REMOTE_STAGING_COMMIT="$FSK_FOUNDATION_COMMIT"
test "$FSK_APPROVED_FULL_BACKEND_COMMIT" != "$FSK_EXPECTED_REMOTE_STAGING_COMMIT"
git cat-file -e "${FSK_APPROVED_FULL_BACKEND_COMMIT}^{commit}"
git merge-base --is-ancestor \
  "$FSK_EXPECTED_REMOTE_STAGING_COMMIT" "$FSK_APPROVED_FULL_BACKEND_COMMIT"
FSK_REMOTE_STAGING_BEFORE_FULL_CAS_LINE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging
)"
FSK_REMOTE_STAGING_BEFORE_FULL_CAS_COUNT="$(
  printf '%s\n' "$FSK_REMOTE_STAGING_BEFORE_FULL_CAS_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_REMOTE_STAGING_BEFORE_FULL_CAS_COUNT" -eq 1
FSK_REMOTE_STAGING_BEFORE_FULL_CAS="$(
  printf '%s\n' "$FSK_REMOTE_STAGING_BEFORE_FULL_CAS_LINE" |
    awk 'NR == 1 { print $1 }'
)"
if [ "$FSK_REMOTE_STAGING_BEFORE_FULL_CAS" != \
  "$FSK_EXPECTED_REMOTE_STAGING_COMMIT" ]; then
  echo 'REMOTE_STAGING_FULL_BACKEND_EXPECTED_MISMATCH_STOP' >&2
  exit 1
fi
if ! git push \
  "--force-with-lease=refs/heads/staging:${FSK_EXPECTED_REMOTE_STAGING_COMMIT}" \
  "$FSK_GIT_REMOTE" \
  "${FSK_APPROVED_FULL_BACKEND_COMMIT}:refs/heads/staging"; then
  echo 'REMOTE_STAGING_FULL_BACKEND_CAS_REJECTED_STOP' >&2
  exit 1
fi
FSK_REMOTE_STAGING_AFTER_FULL_CAS_LINE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging
)"
FSK_REMOTE_STAGING_AFTER_FULL_CAS_COUNT="$(
  printf '%s\n' "$FSK_REMOTE_STAGING_AFTER_FULL_CAS_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_REMOTE_STAGING_AFTER_FULL_CAS_COUNT" -eq 1
FSK_REMOTE_STAGING_AFTER_FULL_CAS="$(
  printf '%s\n' "$FSK_REMOTE_STAGING_AFTER_FULL_CAS_LINE" |
    awk 'NR == 1 { print $1 }'
)"
test "$FSK_REMOTE_STAGING_AFTER_FULL_CAS" = "$FSK_APPROVED_FULL_BACKEND_COMMIT"
FSK_FULL_BACKEND_REMOTE_CAS_ACTOR="$(git config user.name)"
FSK_FULL_BACKEND_REMOTE_CAS_AT_JST="$(
  TZ=Asia/Tokyo date '+%Y-%m-%dT%H:%M:%S%z'
)"
```

| Full backend remote CAS 证据字段 | 值 |
| --- | --- |
| FullBackendRemoteCasApprovalId | `PENDING_USER_APPROVAL` |
| RemoteStagingExpectedCommit | `PENDING_FOUNDATION_COMMIT` |
| RemoteStagingNewCommit | `PENDING_FULL_BACKEND` |
| RemoteStagingBeforeCas | `PENDING_FULL_BACKEND` |
| RemoteStagingCasPushResult | `PENDING_FULL_BACKEND` |
| RemoteStagingAfterCas | `PENDING_FULL_BACKEND` |
| RemoteStagingCasActor | `PENDING_FULL_BACKEND` |
| RemoteStagingCasAtJst | `PENDING_FULL_BACKEND` |

只创建 `stage-admin`、`stage-kitchen`、固定四班和合成数据。不得导入 production 或任何本地真实数据。Budget、Cost Anomaly Detection 和新 alarms 仍等待 Task 17 独立批准。

## 6. Stage 4 — Hosting build

保持 branch Auto build 关闭。只有 full backend 与 outputs 核对成功、独立 remote CAS 完成且只读 `ls-remote` 精确指向 `$FSK_APPROVED_FULL_BACKEND_COMMIT` 后，才可由 Console 手动 Start build。Console 中记录 job ID 后立即用下列只读检查核对 job commit；不匹配时对 `CREATED/PENDING/PROVISIONING/RUNNING` 一律请求 stop，然后无条件非零退出并审计。这个门防止 Hosting 继续构建 foundation 旧源码：

```bash
set -euo pipefail
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_APPROVED_FULL_BACKEND_COMMIT:?use the reviewed full-backend commit}"
: "${AMPLIFY_APP_ID:?use the exact approved staging App ID}"
: "${AMPLIFY_HOSTING_JOB_ID:?record the manual Hosting job ID}"
FSK_HOSTING_REMOTE_STAGING_LINE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging
)"
FSK_HOSTING_REMOTE_STAGING_COUNT="$(
  printf '%s\n' "$FSK_HOSTING_REMOTE_STAGING_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_HOSTING_REMOTE_STAGING_COUNT" -eq 1
FSK_HOSTING_REMOTE_STAGING_COMMIT="$(
  printf '%s\n' "$FSK_HOSTING_REMOTE_STAGING_LINE" |
    awk 'NR == 1 { print $1 }'
)"
test "$FSK_HOSTING_REMOTE_STAGING_COMMIT" = "$FSK_APPROVED_FULL_BACKEND_COMMIT"
FSK_HOSTING_JOB_STATUS="$(aws amplify get-job \
  --region ap-northeast-1 \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name staging \
  --job-id "$AMPLIFY_HOSTING_JOB_ID" \
  --query 'job.summary.status' --output text)"
FSK_HOSTING_JOB_COMMIT="$(aws amplify get-job \
  --region ap-northeast-1 \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name staging \
  --job-id "$AMPLIFY_HOSTING_JOB_ID" \
  --query 'job.summary.commitId' --output text)"
if [ "$FSK_HOSTING_JOB_COMMIT" != "$FSK_APPROVED_FULL_BACKEND_COMMIT" ]; then
  case "$FSK_HOSTING_JOB_STATUS" in
    CREATED|PENDING|PROVISIONING|RUNNING)
      if ! aws amplify stop-job \
        --region ap-northeast-1 \
        --app-id "$AMPLIFY_APP_ID" \
        --branch-name staging \
        --job-id "$AMPLIFY_HOSTING_JOB_ID"; then
        echo 'HOSTING_STOP_JOB_FAILED_AUDIT_REQUIRED' >&2
      fi
      ;;
  esac
  echo 'HOSTING_COMMIT_MISMATCH_STOP_AND_AUDIT' >&2
  exit 1
fi
case "$FSK_HOSTING_JOB_STATUS" in
  CREATED|PENDING|PROVISIONING|RUNNING|SUCCEED) ;;
  *) echo 'HOSTING_JOB_NOT_BUILDABLE_STOP_AND_AUDIT' >&2; exit 1 ;;
esac
```

构建环境固定 `VITE_RUNTIME_MODE=amplify-staging`。Hosting build 只生成 outputs 并构建 Vue，不得运行 backend deploy。继续只读轮询直到该精确 job ID terminal，只有 status `SUCCEED` 且 commit 仍精确相等才是 PASS。

| 证据字段 | 值 |
| --- | --- |
| Command | `Amplify Console: Start build` |
| Region | `ap-northeast-1` |
| AmplifyAppId | `PENDING_DEPLOYMENT` |
| HostingBranch | `staging` |
| HostingBuildId | `PENDING_HOSTING` |
| HostingCommit | `PENDING_FULL_BACKEND` |
| HostingCommitCheck | `PENDING_HOSTING` |
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
4. App、stacks、S3 retained versions 和 snapshot 的实际结果及成本责任全部留证后，才处理共享 Git ref。先从最近一次批准的部署证据取得 `FSK_CURRENT_APPROVED_REMOTE_STAGING_COMMIT`；对本次 runbook，它必须是 §5 remote CAS 复验后的 full-backend commit，不能回退为 foundation expected。若后续又有经批准部署，必须使用最新的 current expected。只读结果不精确匹配时 `STOP`，不得删除他人更新。匹配时使用 compare-and-swap deletion；lease 的 expected value 是该批准 commit，若 ref 在核对后发生竞态更新，push 必须拒绝删除，不能重试为普通 force：

```bash
set -euo pipefail
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_CURRENT_APPROVED_REMOTE_STAGING_COMMIT:?use the current approved remote commit evidence}"
FSK_EXPECTED_REMOTE_STAGING_COMMIT="$FSK_CURRENT_APPROVED_REMOTE_STAGING_COMMIT"
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
