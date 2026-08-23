# FSK Amplify Gen 2 staging 分阶段部署 Runbook

## 0. 用途和停止门

本文是长期 stage/gate 编排器，不承载临时网络或数据库操作。Migration 的 control/worker、临时 NAT/IGW/EIP、临时运维 SG、数据库 migration、失败恢复和清理只按 [`staging-migration-runbook.md`](./staging-migration-runbook.md) 执行。

当前成本门见 [`staging-cost-approval.md`](./staging-cost-approval.md)：`GateStatus=NOT_APPROVED`。本文中的命令只是获得相应阶段批准后的执行模板；当前不得执行任何 AWS 或远程 Git 写入。

长期架构固定为：

- Foundation：Auth + Storage + VPC + Aurora/Data API，Aurora `0–1 ACU`。
- Migration：CloudShell VPC + 临时 NAT/IGW/EIP + 临时运维 SG。
- Full backend：HTTP API + Kitchen/Admin/Export Functions，Functions 不进入 VPC。
- Hosting：Vue/PWA。
- Persistent network：无 NAT、无 Interface Endpoint、无 `5432` ingress；只保留 S3 Gateway Endpoint。
- 不创建 Amplify Data/AppSync、SQL Lambda、Updater Lambda 或数据库 schema 生成链。

任一 account、region、commit/tag、资源集合、截止时间、成本上限或负责人不匹配时立即 `STOP`。Secret、连接串、密码、token、完整 endpoint 和完整账务 payload 不得进入命令参数、Git、文档、截图或日志。

## 1. 六个独立批准阶段

| 顺序 | 阶段 | 写入范围 | 当前状态 |
| --- | --- | --- | --- |
| 1 | Foundation | App/branch、Auth、Storage、VPC、Aurora/Data API | `PENDING_USER_APPROVAL` |
| 2 | Migration | CloudShell VPC、临时网络/运维访问、临时状态、DDL | `PENDING_USER_APPROVAL` |
| 3 | Full backend | HTTP API、Kitchen/Admin/Export Functions、最小 IAM | `PENDING_USER_APPROVAL` |
| 4 | Hosting | Vue/PWA build 和 delivery | `PENDING_USER_APPROVAL` |
| 5 | Budget/alarms | Budget、费用异常检测、指标和告警 | `PENDING_USER_APPROVAL` |
| 6 | Destroy | App/branch/stacks/保留资源/共享 Git ref | `PENDING_USER_APPROVAL` |

每次只批准一行。批准证据至少包含 ApprovalId、exact 40 位 commit、需要时的 immutable tag、`MonthlyCeilingJpy=25000`、Approver、ApprovedAtJst、ExpiresAtJst、CostOwner 和 CleanupOwner。

## 2. 公共只读预检

以下块不写 AWS，但访问远程 Git；在任何写入批准前可执行。它确保本地、远端 tag 和 branch 的证据没有歧义：

```bash
set -euo pipefail
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_APPROVED_COMMIT:?use the reviewed 40-character commit}"
: "${FSK_APPROVED_TAG:=fsk-staging-foundation-v1}"
case "$FSK_APPROVED_COMMIT" in
  *[!0-9a-f]*|'') echo 'APPROVED_COMMIT_INVALID_STOP' >&2; exit 1 ;;
esac
test "${#FSK_APPROVED_COMMIT}" -eq 40
test "$(git rev-parse HEAD)" = "$FSK_APPROVED_COMMIT"
test -z "$(git status --short)"
test "$(git rev-parse "${FSK_APPROVED_TAG}^{commit}")" = \
  "$FSK_APPROVED_COMMIT"
FSK_REMOTE_TAG_LINE="$(
  git ls-remote --tags "$FSK_GIT_REMOTE" "refs/tags/${FSK_APPROVED_TAG}^{}"
)"
FSK_REMOTE_TAG_COUNT="$(
  printf '%s\n' "$FSK_REMOTE_TAG_LINE" |
    awk 'NF { count += 1 } END { print count + 0 }'
)"
test "$FSK_REMOTE_TAG_COUNT" -le 1
if [ "$FSK_REMOTE_TAG_COUNT" -eq 1 ]; then
  test "$(printf '%s\n' "$FSK_REMOTE_TAG_LINE" | awk 'NR == 1 { print $1 }')" = \
    "$FSK_APPROVED_COMMIT"
fi
```

## 3. Foundation

只有 Foundation ApprovalId 完整且未过期时，才可建立 immutable remote tag 和 `staging` branch。若 ref 已存在，只接受 exact commit；若不存在，使用空 expected value 的 lease 创建。竞态失败即 `STOP`，不得改用普通 force。

```bash
set -euo pipefail
: "${FSK_FOUNDATION_APPROVAL_ID:?separate Foundation approval required}"
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_FOUNDATION_COMMIT:?use the approved 40-character commit}"
: "${FSK_FOUNDATION_TAG:=fsk-staging-foundation-v1}"
test "$(git rev-parse HEAD)" = "$FSK_FOUNDATION_COMMIT"
test "$(git rev-parse "${FSK_FOUNDATION_TAG}^{commit}")" = \
  "$FSK_FOUNDATION_COMMIT"
test -z "$(git status --short)"

FSK_REMOTE_TAG_BEFORE="$(
  git ls-remote --tags "$FSK_GIT_REMOTE" "refs/tags/${FSK_FOUNDATION_TAG}^{}" |
    awk 'NF { print $1 }'
)"
if [ -z "$FSK_REMOTE_TAG_BEFORE" ]; then
  git push \
    "--force-with-lease=refs/tags/${FSK_FOUNDATION_TAG}:" \
    "$FSK_GIT_REMOTE" \
    "${FSK_FOUNDATION_TAG}:refs/tags/${FSK_FOUNDATION_TAG}"
else
  test "$FSK_REMOTE_TAG_BEFORE" = "$FSK_FOUNDATION_COMMIT"
fi

FSK_REMOTE_BRANCH_BEFORE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging |
    awk 'NF { print $1 }'
)"
if [ -z "$FSK_REMOTE_BRANCH_BEFORE" ]; then
  git push \
    "--force-with-lease=refs/heads/staging:" \
    "$FSK_GIT_REMOTE" \
    "${FSK_FOUNDATION_COMMIT}:refs/heads/staging"
else
  test "$FSK_REMOTE_BRANCH_BEFORE" = "$FSK_FOUNDATION_COMMIT"
fi

test "$(git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging | awk 'NF { print $1 }')" = \
  "$FSK_FOUNDATION_COMMIT"
test "$(git ls-remote --tags "$FSK_GIT_REMOTE" "refs/tags/${FSK_FOUNDATION_TAG}^{}" | awk 'NF { print $1 }')" = \
  "$FSK_FOUNDATION_COMMIT"
```

在 Amplify Console 创建精确 `fsk-staging` App/`staging` branch 后立即关闭 Auto build。记录 App ID、branch ARN、bootstrap job ID/status/commit 和截图；job commit 不精确匹配时停止 job 并非零退出。随后从 detached foundation commit 执行权威 reconciliation：

```bash
set -euo pipefail
: "${AMPLIFY_APP_ID:?use the exact approved staging App ID}"
: "${FSK_FOUNDATION_COMMIT:?use the verified foundation commit}"
git switch --detach "$FSK_FOUNDATION_COMMIT"
test "$(git rev-parse HEAD)" = "$FSK_FOUNDATION_COMMIT"
AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 CI=1 \
  pnpm exec ampx pipeline-deploy \
    --branch staging \
    --app-id "$AMPLIFY_APP_ID" \
    --outputs-out-dir apps/web/public
git switch RE/amplify-gen2-staging-implementation
```

验证 stack outputs 和合成资源：Aurora private、Data API enabled、`0–1 ACU`、无 Proxy/长期网络；S3 private/versioned/retained；Cognito 禁止 self sign-up 和 guest；仅两个平台 custom-resource Functions，无业务 Functions。`amplify_outputs.json` 只核对且保持 ignored。

## 4. Migration

Foundation PASS 后暂停。取得独立 Migration ApprovalId、operation/cleanup deadline、operation token 和 CleanupOwner，再完整执行 [`staging-migration-runbook.md`](./staging-migration-runbook.md)。主流程只接受以下全部证据：

- exact foundation remote tag/branch/commit 再次匹配；
- 第一次 migration `count=1`、第二次 `count=0`、schema verify PASS；
- worker 没有 EC2 cleanup 权限，control 独占 cleanup；
- Secret/连接串已从 shell 清除且未出现在证据中；
- 临时 NAT/IGW/EIP、public subnet/route、运维 SG、DB ingress、状态参数和 CloudShell environment 已删除；
- 至少三次连续零残留，观察窗口不少于 180 秒，且在 cleanup deadline 内完成。

任一项缺失都记为 `BLOCKED`；不得进入 Full backend。

## 5. Full backend

展示最终 backend diff 和部署日成本重算。批准范围固定为 HTTP API、Cognito JWT authorizer、Kitchen/Admin/Export Functions、目标 Data API/Secret/S3 最小 IAM；Functions 不进入 VPC，不建立 PostgreSQL 连接池。

```bash
set -euo pipefail
: "${FSK_FULL_BACKEND_APPROVAL_ID:?separate Full backend approval required}"
: "${AMPLIFY_APP_ID:?use the exact staging App ID}"
: "${FSK_FOUNDATION_COMMIT:?use the verified foundation commit}"
: "${FSK_APPROVED_FULL_BACKEND_COMMIT:?use the reviewed full-backend commit}"
case "$FSK_APPROVED_FULL_BACKEND_COMMIT" in
  *[!0-9a-f]*|'') echo 'FULL_BACKEND_COMMIT_INVALID_STOP' >&2; exit 1 ;;
esac
test "${#FSK_APPROVED_FULL_BACKEND_COMMIT}" -eq 40
test "$(git rev-parse HEAD)" = "$FSK_APPROVED_FULL_BACKEND_COMMIT"
test -z "$(git status --short)"
git merge-base --is-ancestor \
  "$FSK_FOUNDATION_COMMIT" "$FSK_APPROVED_FULL_BACKEND_COMMIT"
AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 CI=1 \
  pnpm exec ampx pipeline-deploy \
    --branch staging \
    --app-id "$AMPLIFY_APP_ID" \
    --outputs-out-dir apps/web/public
```

AWS deploy 核对成功后，共享 Git ref 更新仍需单独 CAS ApprovalId。expected 只能是已验证 foundation commit，new 只能是已部署 full-backend commit：

```bash
set -euo pipefail
: "${FSK_FULL_BACKEND_REMOTE_CAS_APPROVAL_ID:?shared Git approval required}"
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_FOUNDATION_COMMIT:?use the verified foundation commit}"
: "${FSK_APPROVED_FULL_BACKEND_COMMIT:?use the deployed commit}"
FSK_REMOTE_BEFORE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging |
    awk 'NF { print $1 }'
)"
test "$FSK_REMOTE_BEFORE" = "$FSK_FOUNDATION_COMMIT"
git push \
  "--force-with-lease=refs/heads/staging:${FSK_FOUNDATION_COMMIT}" \
  "$FSK_GIT_REMOTE" \
  "${FSK_APPROVED_FULL_BACKEND_COMMIT}:refs/heads/staging"
FSK_REMOTE_AFTER="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging |
    awk 'NF { print $1 }'
)"
test "$FSK_REMOTE_AFTER" = "$FSK_APPROVED_FULL_BACKEND_COMMIT"
```

只创建合成 stage 用户、固定四班和合成数据。Kitchen 历史/Admin 路由必须真实返回 `403`；Data API 参数化、事务 rollback、幂等/冲突和数据库唤醒重试必须通过后才进入 Hosting。

## 6. Hosting

保持 Auto build 关闭。独立 Hosting ApprovalId 后，从 Console 手动 Start build；立即核对 job 的 exact commit，不匹配时停止并审计：

```bash
set -euo pipefail
: "${FSK_HOSTING_APPROVAL_ID:?separate Hosting approval required}"
: "${AMPLIFY_APP_ID:?use the exact staging App ID}"
: "${AMPLIFY_HOSTING_JOB_ID:?record the manual job ID}"
: "${FSK_APPROVED_FULL_BACKEND_COMMIT:?use the deployed commit}"
FSK_HOSTING_JOB_STATUS="$(aws amplify get-job \
  --region ap-northeast-1 \
  --app-id "$AMPLIFY_APP_ID" --branch-name staging \
  --job-id "$AMPLIFY_HOSTING_JOB_ID" \
  --query 'job.summary.status' --output text)"
FSK_HOSTING_JOB_COMMIT="$(aws amplify get-job \
  --region ap-northeast-1 \
  --app-id "$AMPLIFY_APP_ID" --branch-name staging \
  --job-id "$AMPLIFY_HOSTING_JOB_ID" \
  --query 'job.summary.commitId' --output text)"
if [ "$FSK_HOSTING_JOB_COMMIT" != "$FSK_APPROVED_FULL_BACKEND_COMMIT" ]; then
  case "$FSK_HOSTING_JOB_STATUS" in
    CREATED|PENDING|PROVISIONING|RUNNING)
      aws amplify stop-job \
        --region ap-northeast-1 \
        --app-id "$AMPLIFY_APP_ID" --branch-name staging \
        --job-id "$AMPLIFY_HOSTING_JOB_ID" || true
      ;;
  esac
  echo 'HOSTING_COMMIT_MISMATCH_STOP_AND_AUDIT' >&2
  exit 1
fi
```

构建环境固定 `VITE_RUNTIME_MODE=amplify-staging`。Hosting 只生成 outputs 并构建 Vue/PWA，不执行 backend deploy。只有 terminal `SUCCEED`、commit 仍一致、public bundle secret scan 和权限 smoke PASS 才完成。

## 7. Budget/alarms 与每阶段费用复查

Budget/Cost Anomaly Detection/alarms 属独立写入阶段。每个阶段结束先只读复查 Aurora ACU、NAT、VPC endpoints、DB ingress、S3 versions、logs 和 Amplify jobs；临时网络或状态残留非零、Aurora 不能回到 0 ACU、预测超过 `25000` 或价格证据失效时，停止新增写入并记 `BLOCKED`。

## 8. Destroy

Destroy 必须逐项列出 App/branch、四个 stacks、保留的 S3 versions、final snapshot、日志和共享 Git ref；任何未列资源都不删除。S3 `keepOnDelete` 和 snapshot 的持续成本必须有 CostOwner。remote foundation tag默认保留为 immutable 审计锚点。

只有 App/stacks/保留资源结果都留证后，才可用最新批准 commit 对 remote `staging` 做 CAS deletion：

```bash
set -euo pipefail
: "${FSK_DESTROY_APPROVAL_ID:?separate Destroy approval required}"
: "${FSK_GIT_REMOTE:=origin}"
: "${FSK_CURRENT_APPROVED_REMOTE_STAGING_COMMIT:?use the latest approved commit}"
FSK_REMOTE_BEFORE_DELETE="$(
  git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging |
    awk 'NF { print $1 }'
)"
test "$FSK_REMOTE_BEFORE_DELETE" = \
  "$FSK_CURRENT_APPROVED_REMOTE_STAGING_COMMIT"
git push \
  "--force-with-lease=refs/heads/staging:${FSK_CURRENT_APPROVED_REMOTE_STAGING_COMMIT}" \
  "$FSK_GIT_REMOTE" :refs/heads/staging
test -z "$(git ls-remote --heads "$FSK_GIT_REMOTE" refs/heads/staging)"
```

所有 `PENDING_*` 字段都表示未完成，不得解释为已批准、已部署、已验证或已清理。
