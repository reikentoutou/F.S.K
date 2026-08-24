# FSK Amplify Data / DynamoDB 真实数据切换手册

## 0. 当前状态与授权边界

| 字段 | 值 |
| --- | --- |
| Gate | Gate B — real data cutover |
| GateStatus | `NOT_APPROVED` |
| ApprovalIdVariable | `FSK_GATE_B_APPROVAL_ID` |
| AuthorizedEffects | Read authoritative legacy sources, freeze legacy writes, import and verify real FSK data |
| RealData | `PENDING_GATE_B` |
| LegacyFreeze | `PENDING_GATE_B` |
| LegacyDeletion | `FORBIDDEN` |
| Prerequisite | Gate A accepted with synthetic isolation and device evidence |

本手册只在 Gate A 验收通过、权威源位置确认、dry-run 复审完成且 Gate B 取得新的明确批准后使用。Gate A 的部署批准、过去 PostgreSQL migration 批准、用户“已登录”或一般性的“继续”都不是 Gate B 授权。

Gate B 允许一次“冻结旧写入 → 最终副本 → 幂等 apply → 独立 verify → 两机验收”的切换。它**不允许删除**旧 NestJS、SQLite、uploads、备份或旧 Cloud Foundation；这些内容上线后继续只读保留，直到 Gate C。

## 1. 切换前只读盘点和备份

先确定且记录唯一权威来源：SQLite 绝对路径、uploads 绝对目录、旧运行主机、数据库 inode/size/hash、uploads 文件数/字节/hash、班次/责任人/设置/日报数量、最早/最晚营业日。任何路径不明确、软链接、源在输出目录内、SQLite foreign key check 失败或存在未解释的 orphan/重复 key 时停止。

在**冻结前**制作只读备份并离线验证可读性；原件和副本均生成 SHA-256 manifest。dry-run 输出放到权限受控的绝对目录，不进 Git。复审至少比较：

- ShiftDefinition、ResponsiblePerson、AppSetting、DailyReport 与附件数量；
- 全局及逐营业日七项原始金额、五项共享派生金额；
- 现金/支付宝网管餐费分别合计；
- 确定性 `businessDate#shiftId` 冲突；
- 每个附件的源路径、目标 key、size 与 SHA-256；
- 缺失用户/master reference、无效时间/金额/状态、未消费 orphan。

dry-run 只形成 Gate B 审批输入，不允许提前 apply、建真实 Cognito 用户或冻结旧系统。

## 2. 切换窗口与回退边界

选择下一班次提交前的窗口，现场指定业务负责人、执行人、核对人、设备负责人和回退负责人。公告后暂停旧系统写入，并用应用入口、API 和文件权限三处验证“旧系统只读”；仅隐藏按钮不算冻结。

冻结后重新制作**最终** SQLite/uploads 副本，重新运行 transform/dry-run。最终副本 hash 或汇总只要与审批元组不同，就停止并重新批准；不得把预盘点副本当最终数据。

导入顺序固定为：班次 → 责任人 → 设置 → 历史日报 → 附件。工具使用确定性 key 和条件写；失败后只能用同一 bundle、target fingerprint 和 checkpoint 做受控续跑。不得双写或手工改目标表来“补齐”。

回退规则：

- 在新系统**首笔真实账务提交前**，若 verify/权限/设备验收失败，可停用新入口并恢复旧系统写入；记录目标中已导入对象，禁止静默遗留。
- 首笔真实账务提交后，不得直接恢复双写。先停止两端新写入，导出新记录，完成受控对账并取得新的处置批准。
- 任一结果不确定、AWS 响应丢失、权限负向测试意外成功或 GameList 隔离证据失败时停止切换。

## 3. Gate B 执行模板

下面只展示经 Task 10/11 本地测试的 CLI 顺序。目标配置文件只能包含经 Gate A 只读核对的 FSK stack/table/bucket/pool IDs；不得包含 GameList ARN。临时密码不作为参数、日志或报告内容保存。

```bash
set -euo pipefail
: "${FSK_GATE_B_APPROVAL_ID:?Gate B approval required}"
: "${FSK_EXPECTED_AWS_ACCOUNT_ID:?approved account required}"
: "${FSK_EXPECTED_AWS_REGION:?approved region required}"
: "${FSK_AMPLIFY_APP_ID:?approved independent FSK App ID required}"
: "${FSK_AMPLIFY_BRANCH:?approved FSK branch required}"
: "${FSK_DEPLOY_COMMIT:?approved 40-character commit required}"
: "${FSK_SQLITE_SNAPSHOT:?absolute final SQLite snapshot required}"
: "${FSK_UPLOADS_SNAPSHOT:?absolute final uploads snapshot required}"
: "${FSK_MIGRATION_OUTPUT_DIR:?absolute protected output directory required}"
: "${FSK_TARGET_CONFIG:?absolute reviewed FSK target config required}"
: "${FSK_EXPECTED_BUNDLE_SHA256:?approved bundle SHA-256 required}"
test "$FSK_EXPECTED_AWS_ACCOUNT_ID" = "444083008754"
test "$FSK_EXPECTED_AWS_REGION" = "ap-northeast-1"
test "${#FSK_DEPLOY_COMMIT}" -eq 40
case "$FSK_DEPLOY_COMMIT" in *[!0-9a-f]*|'') exit 2 ;; esac
for fsk_path in "$FSK_SQLITE_SNAPSHOT" "$FSK_UPLOADS_SNAPSHOT" "$FSK_MIGRATION_OUTPUT_DIR" "$FSK_TARGET_CONFIG"; do
  case "$fsk_path" in /*) ;; *) exit 3 ;; esac
done
test "$(aws sts get-caller-identity --query Account --output text)" = "$FSK_EXPECTED_AWS_ACCOUNT_ID"
test "$(git rev-parse HEAD)" = "$FSK_DEPLOY_COMMIT"
test -z "$(git status --porcelain)"
FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_APP_ID="$FSK_AMPLIFY_APP_ID" node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(c.accountId!==process.env.FSK_EXPECTED_AWS_ACCOUNT_ID||c.region!==process.env.FSK_EXPECTED_AWS_REGION||c.amplifyApp?.appId!==process.env.FSK_AMPLIFY_APP_ID||c.amplifyApp?.name!=="FSK") process.exit(1)' "$FSK_TARGET_CONFIG"
pnpm run migration:dry-run -- --sqlite "$FSK_SQLITE_SNAPSHOT" --uploads "$FSK_UPLOADS_SNAPSHOT" --out "$FSK_MIGRATION_OUTPUT_DIR"
test "$(shasum -a 256 "$FSK_MIGRATION_OUTPUT_DIR/bundle.json" | awk '{print $1}')" = "$FSK_EXPECTED_BUNDLE_SHA256"
pnpm run migration:import -- --apply --approval-id "$FSK_GATE_B_APPROVAL_ID" --bundle "$FSK_MIGRATION_OUTPUT_DIR/bundle.json" --uploads-root "$FSK_UPLOADS_SNAPSHOT" --checkpoint "$FSK_MIGRATION_OUTPUT_DIR/import-checkpoint.json" --target-config "$FSK_TARGET_CONFIG"
pnpm run migration:verify -- --bundle "$FSK_MIGRATION_OUTPUT_DIR/bundle.json" --target-config "$FSK_TARGET_CONFIG"
```

## 4. 独立验证和业务验收

apply 进程的成功日志不能作为 verify。由另一位核对人从只读接口重新取得目标数据与对象清单，并保存以下证据：

| 证据 | 通过标准 | 当前值 |
| --- | --- | --- |
| 冻结证据 | 旧 UI/API/文件写入均拒绝，旧副本 hash 固定 | `PENDING_GATE_B` |
| 模型数量 | 四类目标记录与最终 bundle 完全一致 | `PENDING_GATE_B` |
| 金额 | 逐日/全局原始与共享派生汇总一致 | `PENDING_GATE_B` |
| 网管餐费 | 现金、支付宝分别一致，实际売上规则一致 | `PENDING_GATE_B` |
| 附件 | 目标 prefix 无多余/缺失，size/hash 全一致 | `PENDING_GATE_B` |
| 幂等 | 同 bundle 再执行不新增、不覆盖冲突记录 | `PENDING_GATE_B` |
| OWNER | 历史、编辑、统计、设置、CSV、附件通过 | `PENDING_GATE_B` |
| KITCHEN 正向 | 只读取安全上下文并创建新日报/本人附件 | `PENDING_GATE_B` |
| KITCHEN 负向 | get/list 历史、统计、设置、update/delete、附件 read/list/delete 全拒绝 | `PENDING_GATE_B` |
| 重复 key | 同营业日同班次第二次 create 冲突且不覆盖 | `PENDING_GATE_B` |
| 两机 | iPhone 16 Pro Max 与 iPhone 7 Plus/iOS 15.8.4 standalone 完成角色验收 | `PENDING_GATE_B` |
| 隔离 | FSK 与 GameList resource/ARN/data 交集仍为 0 | `PENDING_GATE_B` |

全部通过后，新入口才可标记正式启用；旧系统保持只读。记录切换时刻、首笔新日报 key、双方签字和回退状态。Gate B 完成不会自动启动观察期之外的销毁工作。
