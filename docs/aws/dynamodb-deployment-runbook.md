# FSK Amplify Data / DynamoDB 部署手册

## 0. 当前状态与授权边界

| 字段 | 值 |
| --- | --- |
| Gate | Gate A — synthetic deployment |
| GateStatus | `NOT_APPROVED` |
| ApprovalIdVariable | `FSK_GATE_A_APPROVAL_ID` |
| AuthorizedEffects | Create isolated FSK Auth/Data/Storage/Function/Hosting with synthetic data only |
| RealData | `FORBIDDEN` |
| LegacyFreeze | `FORBIDDEN` |
| LegacyDeletion | `FORBIDDEN` |
| AWS Account | `444083008754` |
| Region | `ap-northeast-1` |
| CurrentRepositoryState | `LOCAL_IMPLEMENTATION_ONLY` |
| CurrentHostingState | `NOT_DEPLOYED` |

本手册描述新的活动架构。它不会复用此前的 PostgreSQL/Aurora Foundation；旧 staging 文档只作为历史失败证据保留。当前提交只建立本地配置与步骤，**没有创建 Amplify App、没有部署 Hosting、没有访问真实 SQLite/uploads，也没有取得 Gate A 批准**。

Gate A 只允许把经复审的精确 commit 部署到一个独立 FSK Amplify Gen 2 App，并使用合成 `OWNER`、`KITCHEN`、账务和附件做验收。Gate A 不授权真实数据盘点/导入、旧系统冻结或任何旧资源删除。Gate B、Gate C 的批准不得从 Gate A 推导。

## 1. 审批前必须锁定的部署元组

批准记录必须逐项给出，不允许使用“当前”“默认”“production”或 GameList 值代替：

| 字段 | Gate A 审批时填写 |
| --- | --- |
| ApprovalId / approver / JST 时间 / 过期时间 | `PENDING_GATE_A` |
| 独立 FSK Amplify App 名称与 App ID | `PENDING_GATE_A` |
| Git remote / branch / 40 位 commit / immutable tag | `PENDING_GATE_A` |
| CloudFormation backend stack 名称 | `PENDING_GATE_A` |
| Cognito User Pool ID | `PENDING_GATE_A` |
| AppSync API ID | `PENDING_GATE_A` |
| 四张 DynamoDB table 名称/ARN | `PENDING_GATE_A` |
| Storage bucket 名称/ARN | `PENDING_GATE_A` |
| Kitchen Context Function 名称/ARN | `PENDING_GATE_A` |
| Amplify service role ARN / policy evidence SHA-256 | `PENDING_GATE_A` |
| Hosting branch / domain / job ID | `PENDING_GATE_A` |
| GameList App/Auth/API/tables/bucket/stacks IDs | `PENDING_GATE_A_READ_ONLY_INVENTORY` |

App 名称必须明确含 FSK 标识且不得等于或包含已登记的 GameList App ID/名称。部署角色只能写入审批元组所列 FSK App；发现 outputs、IAM policy 或 CloudFormation resource 引用 GameList ARN 时立即停止。

## 2. Hosting 构建契约

仓库根 `amplify.yml` 使用 Amplify Gen 2 支持的 fullstack 流程：

1. 在任何依赖工具执行前，对 build 提供的 account、region、App ID、branch、commit 做 fail-closed 核对；
2. 固定 pnpm 9.15.0，执行 `pnpm install --frozen-lockfile`；
3. `ampx pipeline-deploy` 部署该 branch backend，并将 CLI 生成的 `amplify_outputs.json` 写到 `apps/web/public`；
4. 确认 outputs 非空、被 Git ignore 且未被跟踪；
5. 执行 `pnpm run check:all` 和 `pnpm run build:web`；
6. 只发布 `apps/web/dist`。

禁止手写、复制或提交 `amplify_outputs.json`。构建失败时 Amplify job 必须失败，不允许用旧 outputs 继续发布。

`customHttp.yml` 只负责响应头。SPA rewrite 是 Amplify Hosting App 的独立 Custom rule，Gate A 必须将规则精确设置为以下单条 JSON 后再启动 build；它只匹配**没有句点的路径**，因此不会把 manifest、icons、assets 或未知扩展名吞成 HTML：

```json
[
  { "source": "</^[^.]+$/>", "target": "/index.html", "status": "200" }
]
```

规则优先级/结果必须现场验证：`/manifest.json` 返回 manifest JSON MIME；`/icons/*.png` 返回 PNG；`/assets/*` 直接返回指纹资源；`/owner/*`、`/kitchen/*` 等无扩展名路由返回 `index.html`；不存在的 `.json/.js/.png/.bin` 保持 404 而不是 200 HTML。

## 3. Gate A 执行与现场证据

只有 Gate A 获得新的明确批准后，才可在干净的 detached exact commit 和目标账号会话中运行。首次连接 repository 所需的 Git provider 授权必须由批准人在 Amplify Console 人工完成。紧邻 Console 的 Create App 确认前必须重新确认批准截止时间仍未到：创建**全新的**名为 `FSK`、静态 Hosting platform=`WEB`（不是 `WEB_COMPUTE`）的 App，选择审批记录中的 exact repository，绑定 `arn:aws:iam::444083008754:role/service-role/FSKAmplifyGen2ServiceRole`，并设置四个 tags。Console 返回的 App ID 必须写入审批记录和 `FSK_AMPLIFY_APP_ID`；脚本不会搜索或猜测 App，也不会复用 GameList。

service role 在创建 App 前单独完成最小权限复审。证据包必须保存完整 `get-role` readback、permissions boundary、inline/attached policy documents；其中的审批摘要 JSON 必须记录这些 policy documents 的聚合 SHA-256、`amplify.amazonaws.com` trust、FSK-only resource/tag scope、GameList deny/no-access 结论、reviewer 和 UTC review time。原始 readback 与 policy document 不得省略，摘要文件自身的 SHA-256 与固定 role ARN 一起写入 Gate A 批准元组。需要 `Resource: "*"` 的不可资源化只读动作必须逐项解释，不能把通配写权限称为“最小权限”。下面脚本只验证经人工批准的摘要契约和 hash，不生成、放宽或猜测 IAM policy。

所有变量由审批记录逐字填入；不得写入 shell history、仓库或日志中的凭据。下面脚本随后做 App readback、受控 branch bootstrap、build environment、supported `customRules`、remote CAS、RELEASE job 和 HTTP 验收。任何未知既有 rewrite、App/repository/platform/tag/env 漂移或 job commit 漂移都会在发布验收前停止：

```bash
set -euo pipefail
: "${FSK_GATE_A_APPROVAL_ID:?Gate A approval required}"
: "${FSK_EXPECTED_AWS_ACCOUNT_ID:?approved account required}"
: "${FSK_EXPECTED_AWS_REGION:?approved region required}"
: "${FSK_AMPLIFY_APP_ID:?approved independent FSK App ID required}"
: "${FSK_AMPLIFY_BRANCH:?approved FSK branch required}"
: "${FSK_DEPLOY_COMMIT:?approved 40-character commit required}"
: "${FSK_AMPLIFY_APP_NAME:?approved independent FSK App name required}"
: "${FSK_AMPLIFY_SERVICE_ROLE_ARN:?approved Amplify service role ARN required}"
: "${FSK_AMPLIFY_SERVICE_ROLE_POLICY_EVIDENCE:?absolute reviewed service role policy evidence required}"
: "${FSK_AMPLIFY_SERVICE_ROLE_POLICY_EVIDENCE_SHA256:?approved service role evidence SHA-256 required}"
: "${FSK_HOSTING_URL:?approved FSK Hosting URL required}"
: "${FSK_ASSET_JS_PATH:?approved built hashed JavaScript asset path required}"
: "${FSK_GIT_REMOTE:?approved local Git remote name required}"
: "${FSK_GIT_REMOTE_URL:?approved repository URL required}"
: "${FSK_DEPLOY_DEADLINE_EPOCH:?approved deployment deadline required}"
test "$FSK_EXPECTED_AWS_ACCOUNT_ID" = "444083008754"
test "$FSK_EXPECTED_AWS_REGION" = "ap-northeast-1"
test "${#FSK_DEPLOY_COMMIT}" -eq 40
case "$FSK_DEPLOY_COMMIT" in *[!0-9a-f]*|'') exit 2 ;; esac
case "$FSK_DEPLOY_DEADLINE_EPOCH" in *[!0-9]*|'') exit 2 ;; esac
case "$FSK_GIT_REMOTE" in -*|*[!A-Za-z0-9._/-]*|'') exit 2 ;; esac
case "$FSK_AMPLIFY_SERVICE_ROLE_POLICY_EVIDENCE" in /*) ;; *) exit 2 ;; esac
FSK_ASSET_JS_PATH="$FSK_ASSET_JS_PATH" node -e 'if(!/^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js$/.test(process.env.FSK_ASSET_JS_PATH)) process.exit(1)'
test "$(date +%s)" -lt "$FSK_DEPLOY_DEADLINE_EPOCH"
test "$FSK_AMPLIFY_APP_NAME" = "FSK"
test "$FSK_AMPLIFY_SERVICE_ROLE_ARN" = "arn:aws:iam::444083008754:role/service-role/FSKAmplifyGen2ServiceRole"
test "$(aws sts get-caller-identity --query Account --output text)" = "$FSK_EXPECTED_AWS_ACCOUNT_ID"
test "$(git rev-parse HEAD)" = "$FSK_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
test "$(git remote get-url "$FSK_GIT_REMOTE")" = "$FSK_GIT_REMOTE_URL"
test "$(git remote get-url --push "$FSK_GIT_REMOTE")" = "$FSK_GIT_REMOTE_URL"
FSK_TMP_DIR="$(mktemp -d)"
FSK_JOB_ID=''
FSK_JOB_LAST_STATUS=''
FSK_JOB_LAST_COMMIT=''
FSK_JOB_ACCEPTED=0
fsk_require_open_deadline() {
  if ! FSK_NOW_EPOCH="$(date +%s)"; then
    return 1
  fi
  case "$FSK_NOW_EPOCH" in *[!0-9]*|'') return 1 ;; esac
  test "$FSK_NOW_EPOCH" -lt "$FSK_DEPLOY_DEADLINE_EPOCH"
}
fsk_read_job() {
  if ! aws amplify get-job --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --job-id "$FSK_JOB_ID" > "$FSK_TMP_DIR/job.json"; then
    return 1
  fi
  if ! FSK_JOB_ID="$FSK_JOB_ID" node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).job?.summary; if(!s||s.jobId!==process.env.FSK_JOB_ID||typeof s.status!=="string"||!s.status||typeof s.commitId!=="string"||!s.commitId) process.exit(1); process.stdout.write(`${s.status} ${s.commitId}\n`)' "$FSK_TMP_DIR/job.json" > "$FSK_TMP_DIR/job.fields"; then
    return 1
  fi
  if ! read -r FSK_JOB_LAST_STATUS FSK_JOB_LAST_COMMIT < "$FSK_TMP_DIR/job.fields"; then
    return 1
  fi
}
fsk_finish_after_failure() {
  FSK_ORIGINAL_STATUS="$1"
  trap - EXIT
  FSK_CLEANUP_OK=1
  if [ -n "$FSK_JOB_ID" ] && [ "$FSK_JOB_ACCEPTED" -ne 1 ]; then
    case "$FSK_JOB_LAST_STATUS" in
      FAILED|CANCELLED|SUCCEED) ;;
      CANCELLING) ;;
      *)
        if ! aws amplify stop-job --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --job-id "$FSK_JOB_ID" > "$FSK_TMP_DIR/stop-job.json"; then
          FSK_CLEANUP_OK=0
        fi
        ;;
    esac
    FSK_JOB_TERMINAL=0
    for FSK_STOP_POLL in {1..12}; do
      if ! fsk_read_job; then
        FSK_CLEANUP_OK=0
        break
      fi
      case "$FSK_JOB_LAST_STATUS" in
        FAILED|CANCELLED|SUCCEED) FSK_JOB_TERMINAL=1; break ;;
        CREATED|PENDING|PROVISIONING|RUNNING|CANCELLING) sleep 5 ;;
        *) FSK_CLEANUP_OK=0; break ;;
      esac
    done
    if [ "$FSK_JOB_TERMINAL" -ne 1 ]; then FSK_CLEANUP_OK=0; fi
  fi
  rm -rf -- "$FSK_TMP_DIR"
  if [ "$FSK_CLEANUP_OK" -ne 1 ]; then exit 97; fi
  exit "$FSK_ORIGINAL_STATUS"
}
trap 'fsk_finish_after_failure "$?"' EXIT
FSK_AMPLIFY_SERVICE_ROLE_ARN="$FSK_AMPLIFY_SERVICE_ROLE_ARN" FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_SERVICE_ROLE_POLICY_EVIDENCE_SHA256="$FSK_AMPLIFY_SERVICE_ROLE_POLICY_EVIDENCE_SHA256" node - "$FSK_AMPLIFY_SERVICE_ROLE_POLICY_EVIDENCE" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const buffer = fs.readFileSync(process.argv[2]);
if (createHash('sha256').update(buffer).digest('hex') !== process.env.FSK_AMPLIFY_SERVICE_ROLE_POLICY_EVIDENCE_SHA256) process.exit(1);
const evidence = JSON.parse(buffer.toString('utf8'));
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const reviewKeys = ['approved', 'reviewer', 'reviewedAt'];
const keys = ['schemaVersion', 'roleArn', 'accountId', 'region', 'project', 'trustPrincipal', 'resourceScope', 'gameListAccess', 'policyDocumentsSha256', 'leastPrivilegeReview'];
const review = evidence.leastPrivilegeReview;
const reviewedAt = typeof review?.reviewedAt === 'string' ? new Date(review.reviewedAt) : null;
if (!exactKeys(evidence, keys) || !exactKeys(review, reviewKeys) || evidence.schemaVersion !== 1 || evidence.roleArn !== process.env.FSK_AMPLIFY_SERVICE_ROLE_ARN || evidence.accountId !== process.env.FSK_EXPECTED_AWS_ACCOUNT_ID || evidence.region !== process.env.FSK_EXPECTED_AWS_REGION || evidence.project !== 'FSK' || evidence.trustPrincipal !== 'amplify.amazonaws.com' || evidence.resourceScope !== 'FSK_ONLY' || evidence.gameListAccess !== 'DENY' || !/^[0-9a-f]{64}$/.test(evidence.policyDocumentsSha256) || review.approved !== true || typeof review.reviewer !== 'string' || !review.reviewer || !reviewedAt || Number.isNaN(reviewedAt.valueOf()) || reviewedAt.toISOString() !== review.reviewedAt) process.exit(1);
NODE
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],JSON.stringify([{source:"</^[^.]+$/>",target:"/index.html",status:"200"}]))' "$FSK_TMP_DIR/custom-rules.json"
FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_APP_ID="$FSK_AMPLIFY_APP_ID" FSK_AMPLIFY_APP_NAME="$FSK_AMPLIFY_APP_NAME" FSK_GIT_REMOTE_URL="$FSK_GIT_REMOTE_URL" aws amplify get-app --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" > "$FSK_TMP_DIR/app-before.json"
FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_APP_ID="$FSK_AMPLIFY_APP_ID" FSK_AMPLIFY_APP_NAME="$FSK_AMPLIFY_APP_NAME" FSK_GIT_REMOTE_URL="$FSK_GIT_REMOTE_URL" FSK_AMPLIFY_SERVICE_ROLE_ARN="$FSK_AMPLIFY_SERVICE_ROLE_ARN" node -e 'const fs=require("node:fs"); const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).app; const e=process.env; const arn=`arn:aws:amplify:${e.FSK_EXPECTED_AWS_REGION}:${e.FSK_EXPECTED_AWS_ACCOUNT_ID}:apps/${e.FSK_AMPLIFY_APP_ID}`; const tags={Project:"FSK",Environment:"production",ManagedBy:"AmplifyGen2",CostCenter:"FSK"}; const desired=[{source:"</^[^.]+$/>",target:"/index.html",status:"200"}]; if(!a||a.appId!==e.FSK_AMPLIFY_APP_ID||a.appArn!==arn||a.name!==e.FSK_AMPLIFY_APP_NAME||a.repository!==e.FSK_GIT_REMOTE_URL||a.platform!=="WEB"||a.iamServiceRoleArn!==e.FSK_AMPLIFY_SERVICE_ROLE_ARN||Object.entries(tags).some(([k,v])=>a.tags?.[k]!==v)||(!Object.is(JSON.stringify(a.customRules??[]),JSON.stringify([]))&&!Object.is(JSON.stringify(a.customRules),JSON.stringify(desired)))) process.exit(1)' "$FSK_TMP_DIR/app-before.json"
FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_APP_ID="$FSK_AMPLIFY_APP_ID" FSK_AMPLIFY_BRANCH="$FSK_AMPLIFY_BRANCH" FSK_DEPLOY_COMMIT="$FSK_DEPLOY_COMMIT" node -e 'const fs=require("node:fs"); const e=process.env; fs.writeFileSync(process.argv[1],JSON.stringify({FSK_EXPECTED_AWS_ACCOUNT_ID:e.FSK_EXPECTED_AWS_ACCOUNT_ID,FSK_EXPECTED_AWS_REGION:e.FSK_EXPECTED_AWS_REGION,FSK_EXPECTED_AMPLIFY_APP_ID:e.FSK_AMPLIFY_APP_ID,FSK_EXPECTED_AMPLIFY_BRANCH:e.FSK_AMPLIFY_BRANCH,FSK_EXPECTED_DEPLOY_COMMIT:e.FSK_DEPLOY_COMMIT}))' "$FSK_TMP_DIR/branch-env.json"
if aws amplify get-branch --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" > "$FSK_TMP_DIR/branch-before.json" 2> "$FSK_TMP_DIR/branch-before.err"; then
  FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_APP_ID="$FSK_AMPLIFY_APP_ID" FSK_AMPLIFY_BRANCH="$FSK_AMPLIFY_BRANCH" FSK_DEPLOY_COMMIT="$FSK_DEPLOY_COMMIT" node -e 'const fs=require("node:fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).branch; const e=process.env; const expected={FSK_EXPECTED_AWS_ACCOUNT_ID:e.FSK_EXPECTED_AWS_ACCOUNT_ID,FSK_EXPECTED_AWS_REGION:e.FSK_EXPECTED_AWS_REGION,FSK_EXPECTED_AMPLIFY_APP_ID:e.FSK_AMPLIFY_APP_ID,FSK_EXPECTED_AMPLIFY_BRANCH:e.FSK_AMPLIFY_BRANCH,FSK_EXPECTED_DEPLOY_COMMIT:e.FSK_DEPLOY_COMMIT}; const env=b?.environmentVariables; const exactEnv=env&&Object.keys(env).length===Object.keys(expected).length&&Object.entries(expected).every(([k,v])=>env[k]===v); if(!b||b.branchName!==e.FSK_AMPLIFY_BRANCH||b.stage!=="PRODUCTION"||b.framework!=="Vue"||b.enableAutoBuild!==false||!exactEnv) process.exit(1)' "$FSK_TMP_DIR/branch-before.json"
else
  FSK_BRANCH_READ_STATUS="$?"
  if ! grep -q 'NotFoundException' "$FSK_TMP_DIR/branch-before.err"; then
    cat "$FSK_TMP_DIR/branch-before.err" >&2
    exit "$FSK_BRANCH_READ_STATUS"
  fi
  fsk_require_open_deadline
  aws amplify create-branch --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --framework Vue --stage PRODUCTION --no-enable-auto-build --environment-variables "file://$FSK_TMP_DIR/branch-env.json"
fi
fsk_require_open_deadline
aws amplify update-branch --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --framework Vue --stage PRODUCTION --no-enable-auto-build --environment-variables "file://$FSK_TMP_DIR/branch-env.json"
aws amplify get-branch --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" > "$FSK_TMP_DIR/branch-after.json"
FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_APP_ID="$FSK_AMPLIFY_APP_ID" FSK_AMPLIFY_BRANCH="$FSK_AMPLIFY_BRANCH" FSK_DEPLOY_COMMIT="$FSK_DEPLOY_COMMIT" node -e 'const fs=require("node:fs"); const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).branch; const e=process.env; const expected={FSK_EXPECTED_AWS_ACCOUNT_ID:e.FSK_EXPECTED_AWS_ACCOUNT_ID,FSK_EXPECTED_AWS_REGION:e.FSK_EXPECTED_AWS_REGION,FSK_EXPECTED_AMPLIFY_APP_ID:e.FSK_AMPLIFY_APP_ID,FSK_EXPECTED_AMPLIFY_BRANCH:e.FSK_AMPLIFY_BRANCH,FSK_EXPECTED_DEPLOY_COMMIT:e.FSK_DEPLOY_COMMIT}; const env=b?.environmentVariables; const exactEnv=env&&Object.keys(env).length===Object.keys(expected).length&&Object.entries(expected).every(([k,v])=>env[k]===v); if(!b||b.branchName!==e.FSK_AMPLIFY_BRANCH||b.stage!=="PRODUCTION"||b.framework!=="Vue"||b.enableAutoBuild!==false||!exactEnv) process.exit(1)' "$FSK_TMP_DIR/branch-after.json"
fsk_require_open_deadline
aws amplify update-app --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --platform WEB --iam-service-role-arn "$FSK_AMPLIFY_SERVICE_ROLE_ARN" --custom-rules "file://$FSK_TMP_DIR/custom-rules.json"
aws amplify get-app --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" > "$FSK_TMP_DIR/app-after.json"
FSK_AMPLIFY_SERVICE_ROLE_ARN="$FSK_AMPLIFY_SERVICE_ROLE_ARN" node -e 'const fs=require("node:fs"); const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).app; const desired=[{source:"</^[^.]+$/>",target:"/index.html",status:"200"}]; if(a?.platform!=="WEB"||a.iamServiceRoleArn!==process.env.FSK_AMPLIFY_SERVICE_ROLE_ARN||JSON.stringify(a.customRules)!==JSON.stringify(desired)) process.exit(1)' "$FSK_TMP_DIR/app-after.json"
FSK_REMOTE_OLD_COMMIT="$(git ls-remote --heads "$FSK_GIT_REMOTE_URL" "refs/heads/$FSK_AMPLIFY_BRANCH" | awk 'NF { print $1 }')"
if [ -n "$FSK_REMOTE_OLD_COMMIT" ]; then
  test "${#FSK_REMOTE_OLD_COMMIT}" -eq 40
  case "$FSK_REMOTE_OLD_COMMIT" in *[!0-9a-f]*|'') exit 3 ;; esac
fi
printf 'REMOTE_OLD_COMMIT=%s\n' "${FSK_REMOTE_OLD_COMMIT:-ABSENT}"
fsk_require_open_deadline
git push --force-with-lease="refs/heads/$FSK_AMPLIFY_BRANCH:$FSK_REMOTE_OLD_COMMIT" "$FSK_GIT_REMOTE" "$FSK_DEPLOY_COMMIT:refs/heads/$FSK_AMPLIFY_BRANCH"
test "$(git ls-remote --heads "$FSK_GIT_REMOTE_URL" "refs/heads/$FSK_AMPLIFY_BRANCH" | awk 'NF { print $1 }')" = "$FSK_DEPLOY_COMMIT"
fsk_require_open_deadline
if ! FSK_JOB_ID="$(aws amplify start-job --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --job-type RELEASE --commit-id "$FSK_DEPLOY_COMMIT" --commit-message "Gate A ${FSK_GATE_A_APPROVAL_ID}" --query 'jobSummary.jobId' --output text)"; then
  exit 6
fi
test -n "$FSK_JOB_ID"
FSK_JOB_LAST_STATUS=CREATED
while true; do
  if ! fsk_require_open_deadline; then exit 6; fi
  if ! fsk_read_job; then exit 6; fi
  if [ "$FSK_JOB_LAST_COMMIT" != "$FSK_DEPLOY_COMMIT" ]; then exit 6; fi
  case "$FSK_JOB_LAST_STATUS" in
    SUCCEED) FSK_JOB_ACCEPTED=1; break ;;
    CREATED|PENDING|PROVISIONING|RUNNING|CANCELLING) sleep 5 ;;
    FAILED|CANCELLED) exit 4 ;;
    *) exit 5 ;;
  esac
done
fsk_fetch_http_evidence() {
  FSK_HTTP_NAME="$1"
  FSK_HTTP_PATH="$2"
  if ! FSK_HTTP_STATUS="$(curl -sS -D "$FSK_TMP_DIR/$FSK_HTTP_NAME.headers" -o "$FSK_TMP_DIR/$FSK_HTTP_NAME.body" -w '%{http_code}' "${FSK_HOSTING_URL%/}$FSK_HTTP_PATH")"; then
    return 1
  fi
  case "$FSK_HTTP_STATUS" in ???) ;; *) return 1 ;; esac
  printf '%s\n' "$FSK_HTTP_STATUS" > "$FSK_TMP_DIR/$FSK_HTTP_NAME.status"
}
fsk_fetch_http_evidence manifest /manifest.json
fsk_fetch_http_evidence icon /icons/icon-180.png
fsk_fetch_http_evidence asset "$FSK_ASSET_JS_PATH"
fsk_fetch_http_evidence index /index.html
fsk_fetch_http_evidence owner /owner/reports
fsk_fetch_http_evidence kitchen /kitchen/report/new
fsk_fetch_http_evidence missing-json /missing.json
fsk_fetch_http_evidence missing-js /missing.js
fsk_fetch_http_evidence missing-png /missing.png
fsk_fetch_http_evidence missing-bin /missing.bin
node - "$FSK_TMP_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const evidence = (name) => {
  const status = fs.readFileSync(path.join(root, `${name}.status`), 'utf8').trim();
  const rawHeaders = fs.readFileSync(path.join(root, `${name}.headers`), 'utf8');
  const body = fs.readFileSync(path.join(root, `${name}.body`));
  const blocks = rawHeaders.trim().split(/\r?\n\r?\n/);
  const lines = blocks.at(-1).split(/\r?\n/).slice(1);
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) process.exit(1);
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(key)) process.exit(1);
    headers.set(key, value);
  }
  return { status, headers, body };
};
const family = (entry) => (entry.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
const cache = (entry) => (entry.headers.get('cache-control') ?? '').toLowerCase();
const noCache = 'no-cache, no-store, must-revalidate';
const manifest = evidence('manifest');
if (manifest.status !== '200' || family(manifest) !== 'application/manifest+json' || cache(manifest) !== noCache || JSON.parse(manifest.body.toString('utf8')).display !== 'standalone') process.exit(1);
const icon = evidence('icon');
if (icon.status !== '200' || family(icon) !== 'image/png' || cache(icon) !== 'public, max-age=86400' || !icon.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) process.exit(1);
const asset = evidence('asset');
if (asset.status !== '200' || !['application/javascript', 'text/javascript'].includes(family(asset)) || cache(asset) !== 'public, max-age=31536000, immutable' || asset.body.length === 0) process.exit(1);
for (const name of ['index', 'owner', 'kitchen']) {
  const page = evidence(name);
  if (page.status !== '200' || family(page) !== 'text/html' || !page.body.toString('utf8').includes('<div id="app"></div>')) process.exit(1);
  if (name === 'index' && cache(page) !== noCache) process.exit(1);
}
for (const name of ['missing-json', 'missing-js', 'missing-png', 'missing-bin']) {
  const missing = evidence(name);
  if (missing.status !== '404' || missing.body.toString('utf8').includes('<div id="app"></div>')) process.exit(1);
}
NODE
```

启动 job 后必须等待 terminal `SUCCEED`，并再次核对 job commit。失败或 commit 漂移时停止，不重试、不切换、不复用批准；形成新的部署元组和批准。

## 4. 自动与人工验收证据

以下字段在 Gate A 现场填写，值必须来自 synth、CloudFormation/服务只读查询和 HTTP 响应，不得把本地测试当作 live 证据：

| 证据 | 要求 | 当前值 |
| --- | --- | --- |
| App/branch/job/commit/domain | 全部等于 Gate A 元组 | `PENDING_GATE_A` |
| backend stacks | Auth/Data/Storage/Function stacks 全部完成 | `PENDING_GATE_A` |
| Cognito groups | 仅 `OWNER`、`KITCHEN` | `PENDING_GATE_A` |
| Data | AppSync + 四张独立 DynamoDB 表 | `PENDING_GATE_A` |
| DynamoDB billing/recovery | 每表 On-Demand + PITR enabled | `PENDING_GATE_A` |
| Storage | 独立 bucket、versioning、SSE-S3、public block | `PENDING_GATE_A` |
| Kitchen Function | 只读三张上下文表，无日报/S3/Cognito 权限 | `PENDING_GATE_A` |
| Active synth/live resource types | RDS、VPC、NAT、Proxy、Data API 均为 0 | `PENDING_GATE_A` |
| GameList references | App/Auth/API/table/bucket/stack/outputs/ARN 交集为 0 | `PENDING_GATE_A` |
| Hosting static | manifest/icons/assets MIME、cache、404 正确 | `PENDING_GATE_A` |
| Hosting SPA | OWNER/KITCHEN extensionless routes 返回 shell | `PENDING_GATE_A` |
| Synthetic auth/data | OWNER 正向、KITCHEN create 正向与历史/设置/update/delete 负向 | `PENDING_GATE_A` |
| PWA devices | iPhone 16 Pro Max 与 iPhone 7 Plus/iOS 15.8.4 standalone | `PENDING_GATE_A` |

Gate A 合成数据必须带清晰 `synthetic` 标识，并在验收报告列出清理责任人。Gate A 通过仍不允许读取或导入真实源数据；下一步只能提交 Gate B 审批材料。
