# FSK 旧运行层与 Foundation 退役手册

## 0. 当前状态与授权边界

| 字段 | 值 |
| --- | --- |
| Gate | Gate C — legacy retirement |
| GateStatus | `NOT_APPROVED` |
| ApprovalIdVariable | `FSK_GATE_C_APPROVAL_ID` |
| AuthorizedEffects | Retire only exact reviewed legacy FSK resources and source runtime listed in the Gate C manifest |
| Prerequisite | Gate B accepted plus observation period complete |
| LegacyReadOnlyRetention | `REQUIRED_UNTIL_GATE_C` |
| NewDynamoAppDeletion | `FORBIDDEN` |
| GameListDeletion | `FORBIDDEN` |

新 DynamoDB 系统的部署、Gate A 合成验收或 Gate B 真实切换都**不隐含**退役授权。切换后，旧 NestJS/SQLite/uploads 先只读保留；备份、导入报告和审计证据按照单独确认的保留期保存。

旧 Aurora/PostgreSQL Foundation 与失败 migration 记录属于历史方案。只有观察期结束、账务/权限/两机运行稳定、回退不再依赖它们，并收到列明**精确资源**的 Gate C 批准后，才可销毁。不得用项目名、tag 前缀、通配符或“所有 staging”作为删除目标。

## 1. Gate C 前置证据

| 证据 | 通过标准 | 当前值 |
| --- | --- | --- |
| Gate B | 最终 bundle、verify、设备和权限验收已签字 | `PENDING_GATE_C` |
| 观察期 | 起止时刻、班次数、异常/修正记录已复审 | `PENDING_GATE_C` |
| 新系统备份 | DynamoDB PITR 与 S3 versioning live enabled | `PENDING_GATE_C` |
| 新系统导出 | 可恢复的账务和附件清单已独立核对 | `PENDING_GATE_C` |
| 旧源备份 | SQLite/uploads hash、保存位置、保留期、owner 明确 | `PENDING_GATE_C` |
| 依赖扫描 | DNS、Hosting、代码、IAM、运维手册无旧运行依赖 | `PENDING_GATE_C` |
| 精确清单 | 每个旧 stack/resource ARN、类型、状态和删除顺序 | `PENDING_GATE_C` |
| 保护清单 | 新 FSK App/stack/table/bucket/pool/API 与 GameList 全部列为 deny-delete | `PENDING_GATE_C` |
| 成本影响 | 删除前后预计/实际成本与 final snapshot 保留成本 | `PENDING_GATE_C` |

任何未决事故、金额不一致、附件缺失、权限越界或设备回退需求都会使 Gate C 失效。先解决并重新观察、重新批准，不得边修边删。

## 2. 精确销毁清单与执行原则

Gate C manifest 是权限受控的 JSON 文件，不入 Git，至少包含：approval ID、账号、region、已部署新系统 commit、观察期结束时刻、待退役资源 ARN/stack 名、保留/快照策略、逐资源 owner。它必须有经批准的 SHA-256，且资源集合与 Gate C 审批逐字一致。

执行前先对每项做只读 `describe`，确认它属于**旧 Foundation**且不在保护清单；检测到未列出的 dependent resource、删除保护、retain/snapshot 歧义或名称冲突时停止。先停止旧 NestJS 常驻进程和旧入口，再按 manifest 逐项退役。SQLite/uploads 原始备份不随运行层自动删除。

本手册不预填任何 stack/resource 名，也不提供 project/tag 批量删除命令。实际删除命令由 Gate C 审核时针对 manifest 中每种资源生成并双人复核；当前阶段只允许下面的 fail-closed 预检，预检本身不删除资源：

```bash
set -euo pipefail
: "${FSK_GATE_C_APPROVAL_ID:?Gate C approval required}"
: "${FSK_EXPECTED_AWS_ACCOUNT_ID:?approved account required}"
: "${FSK_EXPECTED_AWS_REGION:?approved region required}"
: "${FSK_AMPLIFY_APP_ID:?approved independent FSK App ID required}"
: "${FSK_AMPLIFY_BRANCH:?approved FSK branch required}"
: "${FSK_DEPLOY_COMMIT:?approved 40-character commit required}"
: "${FSK_RETIREMENT_MANIFEST:?absolute reviewed retirement manifest required}"
: "${FSK_RETIREMENT_MANIFEST_SHA256:?approved manifest SHA-256 required}"
test "$FSK_EXPECTED_AWS_ACCOUNT_ID" = "444083008754"
test "$FSK_EXPECTED_AWS_REGION" = "ap-northeast-1"
test "${#FSK_DEPLOY_COMMIT}" -eq 40
case "$FSK_DEPLOY_COMMIT" in *[!0-9a-f]*|'') exit 2 ;; esac
case "$FSK_RETIREMENT_MANIFEST" in /*) ;; *) exit 3 ;; esac
test "$(aws sts get-caller-identity --query Account --output text)" = "$FSK_EXPECTED_AWS_ACCOUNT_ID"
test "$(git rev-parse HEAD)" = "$FSK_DEPLOY_COMMIT"
test "$(shasum -a 256 "$FSK_RETIREMENT_MANIFEST" | awk '{print $1}')" = "$FSK_RETIREMENT_MANIFEST_SHA256"
FSK_GATE_C_APPROVAL_ID="$FSK_GATE_C_APPROVAL_ID" FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_DEPLOY_COMMIT="$FSK_DEPLOY_COMMIT" node -e 'const fs=require("node:fs"); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,"utf8")); const exact=["approvalId","accountId","region","newSystemCommit","observationEndedAt","retire","protect"]; if(Object.keys(m).sort().join()!==exact.sort().join()||m.approvalId!==process.env.FSK_GATE_C_APPROVAL_ID||m.accountId!==process.env.FSK_EXPECTED_AWS_ACCOUNT_ID||m.region!==process.env.FSK_EXPECTED_AWS_REGION||m.newSystemCommit!==process.env.FSK_DEPLOY_COMMIT||!Array.isArray(m.retire)||m.retire.length===0||!Array.isArray(m.protect)||m.protect.length===0) process.exit(1); const retire=new Set(m.retire.map(x=>x.arn)); const protect=new Set(m.protect.map(x=>x.arn)); if([...retire].some(x=>!x||protect.has(x))) process.exit(1)' "$FSK_RETIREMENT_MANIFEST"
```

## 3. 删除后的核对与长期保留

Gate C 执行记录必须逐资源保存 request ID、开始/完成时间、终态、final snapshot/retain 对象和失败项。删除后至少核对：

- 新 FSK Amplify App、Hosting、Cognito、AppSync、四张 DynamoDB 表、Storage 和 Function 全部正常；
- OWNER/KITCHEN 权限与最新账务提交正常；
- GameList 所有资源不变；
- 旧入口不可写、旧常驻进程不存在；
- 旧 Foundation 目标不存在，未列入 manifest 的资源未受影响；
- Cost Explorer 在账单延迟后复核，保留 snapshot/S3 version 的持续成本有 owner；
- SQLite/uploads 备份、最终迁移 bundle、verify 报告和审批证据仍可读取且 hash 一致。

部分删除失败时不得扩大扫描范围或临时删除相似资源。停止、记录精确残留，重新复审依赖与成本，再取得新的 Gate C operation 批准。
