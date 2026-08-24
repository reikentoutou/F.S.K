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
| Hosting branch / domain / job ID | `PENDING_GATE_A` |
| GameList App/Auth/API/tables/bucket/stacks IDs | `PENDING_GATE_A_READ_ONLY_INVENTORY` |

App 名称必须明确含 FSK 标识且不得等于或包含已登记的 GameList App ID/名称。部署角色只能写入审批元组所列 FSK App；发现 outputs、IAM policy 或 CloudFormation resource 引用 GameList ARN 时立即停止。

## 2. Hosting 构建契约

仓库根 `amplify.yml` 使用 Amplify Gen 2 支持的 fullstack 流程：

1. 固定 pnpm 9.15.0，执行 `pnpm install --frozen-lockfile`；
2. 对 account、region、App ID、branch、commit 做 fail-closed 核对；
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

只有 Gate A 获得新的明确批准后，才可在干净的 detached exact commit 和目标账号会话中运行。所有变量由审批记录逐字填入；不得写入 shell history、仓库或日志中的凭据。下面命令没有默认 App、branch 或 commit，并在任何不一致时停止：

```bash
set -euo pipefail
: "${FSK_GATE_A_APPROVAL_ID:?Gate A approval required}"
: "${FSK_EXPECTED_AWS_ACCOUNT_ID:?approved account required}"
: "${FSK_EXPECTED_AWS_REGION:?approved region required}"
: "${FSK_AMPLIFY_APP_ID:?approved independent FSK App ID required}"
: "${FSK_AMPLIFY_BRANCH:?approved FSK branch required}"
: "${FSK_DEPLOY_COMMIT:?approved 40-character commit required}"
: "${FSK_AMPLIFY_APP_NAME:?approved independent FSK App name required}"
: "${FSK_HOSTING_URL:?approved FSK Hosting URL required}"
test "$FSK_EXPECTED_AWS_ACCOUNT_ID" = "444083008754"
test "$FSK_EXPECTED_AWS_REGION" = "ap-northeast-1"
test "${#FSK_DEPLOY_COMMIT}" -eq 40
case "$FSK_DEPLOY_COMMIT" in *[!0-9a-f]*|'') exit 2 ;; esac
test "$FSK_AMPLIFY_APP_NAME" = "FSK"
test "$(aws sts get-caller-identity --query Account --output text)" = "$FSK_EXPECTED_AWS_ACCOUNT_ID"
test "$(git rev-parse HEAD)" = "$FSK_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
FSK_TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$FSK_TMP_DIR"' EXIT
test "$(aws amplify get-app --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --query 'app.name' --output text)" = "$FSK_AMPLIFY_APP_NAME"
test "$(aws amplify get-branch --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --query 'branch.branchName' --output text)" = "$FSK_AMPLIFY_BRANCH"
FSK_JOB_ID="$(aws amplify start-job --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --job-type RELEASE --commit-id "$FSK_DEPLOY_COMMIT" --commit-message "Gate A ${FSK_GATE_A_APPROVAL_ID}" --query 'jobSummary.jobId' --output text)"
test -n "$FSK_JOB_ID"
aws amplify get-job --region "$FSK_EXPECTED_AWS_REGION" --app-id "$FSK_AMPLIFY_APP_ID" --branch-name "$FSK_AMPLIFY_BRANCH" --job-id "$FSK_JOB_ID"
curl -fsS -D "$FSK_TMP_DIR/manifest.headers" -o "$FSK_TMP_DIR/manifest.json" "${FSK_HOSTING_URL%/}/manifest.json"
node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(m.display!=="standalone") process.exit(1)' "$FSK_TMP_DIR/manifest.json"
curl -fsS -o "$FSK_TMP_DIR/owner-route.html" "${FSK_HOSTING_URL%/}/owner/reports"
grep -q '<div id="app"></div>' "$FSK_TMP_DIR/owner-route.html"
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
