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

Gate C manifest 是权限受控的 JSON 文件，不入 Git，使用 `schemaVersion=1`，精确包含：approval ID、账号、region、已部署新系统 commit、观察期结束时刻、两个保护集 hash、待退役资源和保护资源。每个 resource item 只能包含 `category`、完整 `arn`、CloudFormation `resourceType`、`retentionPolicy`、`owner`；禁止通配符、重复 ARN、跨账号/region ARN、未知 service/type/category 和 retire/protect 交集。

新 FSK 与 GameList 的保护清单分别由只读盘点生成独立 JSON 和 SHA-256，并作为 Gate C 审批输入。manifest 的 `protect` 必须精确等于两份权威清单之并集；新 FSK 清单必须显式保护 App、User Pool、AppSync API、四张表、Storage bucket、Kitchen Function 和至少一个活动 stack，GameList 清单不得为空。不能用 manifest 自己声称的 protect 集合替代外部权威清单。

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
: "${FSK_NEW_FSK_PROTECT_SET:?absolute authoritative new FSK protect set required}"
: "${FSK_NEW_FSK_PROTECT_SET_SHA256:?approved new FSK protect set SHA-256 required}"
: "${FSK_GAMELIST_PROTECT_SET:?absolute authoritative GameList protect set required}"
: "${FSK_GAMELIST_PROTECT_SET_SHA256:?approved GameList protect set SHA-256 required}"
test "$FSK_EXPECTED_AWS_ACCOUNT_ID" = "444083008754"
test "$FSK_EXPECTED_AWS_REGION" = "ap-northeast-1"
test "${#FSK_DEPLOY_COMMIT}" -eq 40
case "$FSK_DEPLOY_COMMIT" in *[!0-9a-f]*|'') exit 2 ;; esac
case "$FSK_RETIREMENT_MANIFEST" in /*) ;; *) exit 3 ;; esac
case "$FSK_NEW_FSK_PROTECT_SET" in /*) ;; *) exit 3 ;; esac
case "$FSK_GAMELIST_PROTECT_SET" in /*) ;; *) exit 3 ;; esac
test "$(aws sts get-caller-identity --query Account --output text)" = "$FSK_EXPECTED_AWS_ACCOUNT_ID"
test "$(git rev-parse HEAD)" = "$FSK_DEPLOY_COMMIT"
FSK_GATE_C_APPROVAL_ID="$FSK_GATE_C_APPROVAL_ID" FSK_EXPECTED_AWS_ACCOUNT_ID="$FSK_EXPECTED_AWS_ACCOUNT_ID" FSK_EXPECTED_AWS_REGION="$FSK_EXPECTED_AWS_REGION" FSK_AMPLIFY_APP_ID="$FSK_AMPLIFY_APP_ID" FSK_DEPLOY_COMMIT="$FSK_DEPLOY_COMMIT" FSK_RETIREMENT_MANIFEST_SHA256="$FSK_RETIREMENT_MANIFEST_SHA256" FSK_NEW_FSK_PROTECT_SET_SHA256="$FSK_NEW_FSK_PROTECT_SET_SHA256" FSK_GAMELIST_PROTECT_SET_SHA256="$FSK_GAMELIST_PROTECT_SET_SHA256" node - "$FSK_RETIREMENT_MANIFEST" "$FSK_NEW_FSK_PROTECT_SET" "$FSK_GAMELIST_PROTECT_SET" <<'NODE'
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [manifestPath, newFskPath, gameListPath] = process.argv.slice(2);
const readEvidence = (path, expectedSha256) => {
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) process.exit(1);
    const buffer = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(path, { bigint: true });
    const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && after.dev === pathAfter.dev && after.ino === pathAfter.ino && after.size === pathAfter.size && after.mtimeNs === pathAfter.mtimeNs && after.ctimeNs === pathAfter.ctimeNs && before.size === BigInt(buffer.length) && !pathAfter.isSymbolicLink();
    if (!stable || createHash('sha256').update(buffer).digest('hex') !== expectedSha256) process.exit(1);
    return buffer;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};
const manifestBuffer = readEvidence(manifestPath, process.env.FSK_RETIREMENT_MANIFEST_SHA256);
const newFskBuffer = readEvidence(newFskPath, process.env.FSK_NEW_FSK_PROTECT_SET_SHA256);
const gameListBuffer = readEvidence(gameListPath, process.env.FSK_GAMELIST_PROTECT_SET_SHA256);
const manifest = JSON.parse(manifestBuffer.toString('utf8'));
const newFsk = JSON.parse(newFskBuffer.toString('utf8'));
const gameList = JSON.parse(gameListBuffer.toString('utf8'));
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const itemKeys = ['category', 'arn', 'resourceType', 'retentionPolicy', 'owner'];
const newFskCategoryType = {
  NEW_FSK_AMPLIFY_APP: 'AWS::Amplify::App',
  NEW_FSK_COGNITO_POOL: 'AWS::Cognito::UserPool',
  NEW_FSK_APPSYNC_API: 'AWS::AppSync::GraphQLApi',
  NEW_FSK_DYNAMODB_TABLE: 'AWS::DynamoDB::Table',
  NEW_FSK_STORAGE_BUCKET: 'AWS::S3::Bucket',
  NEW_FSK_FUNCTION: 'AWS::Lambda::Function',
  NEW_FSK_CLOUDFORMATION_STACK: 'AWS::CloudFormation::Stack',
};
const legacyCategoryType = {
  LEGACY_FSK_AMPLIFY_APP: 'AWS::Amplify::App',
  LEGACY_FSK_COGNITO_POOL: 'AWS::Cognito::UserPool',
  LEGACY_FSK_APPSYNC_API: 'AWS::AppSync::GraphQLApi',
  LEGACY_FSK_DYNAMODB_TABLE: 'AWS::DynamoDB::Table',
  LEGACY_FSK_STORAGE_BUCKET: 'AWS::S3::Bucket',
  LEGACY_FSK_FUNCTION: 'AWS::Lambda::Function',
  LEGACY_FSK_STACK: 'AWS::CloudFormation::Stack',
  LEGACY_FSK_RDS_CLUSTER: 'AWS::RDS::DBCluster',
  LEGACY_FSK_RDS_INSTANCE: 'AWS::RDS::DBInstance',
  LEGACY_FSK_RDS_CLUSTER_PARAMETER_GROUP: 'AWS::RDS::DBClusterParameterGroup',
  LEGACY_FSK_RDS_SUBNET_GROUP: 'AWS::RDS::DBSubnetGroup',
  LEGACY_FSK_VPC: 'AWS::EC2::VPC',
  LEGACY_FSK_SUBNET: 'AWS::EC2::Subnet',
  LEGACY_FSK_ROUTE_TABLE: 'AWS::EC2::RouteTable',
  LEGACY_FSK_VPC_ENDPOINT: 'AWS::EC2::VPCEndpoint',
  LEGACY_FSK_SECURITY_GROUP: 'AWS::EC2::SecurityGroup',
  LEGACY_FSK_INTERNET_GATEWAY: 'AWS::EC2::InternetGateway',
  LEGACY_FSK_NAT_GATEWAY: 'AWS::EC2::NatGateway',
  LEGACY_FSK_EIP: 'AWS::EC2::EIP',
  LEGACY_FSK_SECRET: 'AWS::SecretsManager::Secret',
};
const arnContractByType = {
  'AWS::Amplify::App': { service: 'amplify', resource: /^apps\/[a-z0-9]+$/ },
  'AWS::Cognito::UserPool': { service: 'cognito-idp', resource: /^userpool\/ap-northeast-1_[A-Za-z0-9]+$/ },
  'AWS::AppSync::GraphQLApi': { service: 'appsync', resource: /^apis\/[A-Za-z0-9]+$/ },
  'AWS::DynamoDB::Table': { service: 'dynamodb', resource: /^table\/[A-Za-z0-9_.-]+$/ },
  'AWS::Lambda::Function': { service: 'lambda', resource: /^function:[A-Za-z0-9_-]+$/ },
  'AWS::CloudFormation::Stack': { service: 'cloudformation', resource: /^stack\/[A-Za-z0-9_.-]+\/[0-9a-f-]+$/i },
  'AWS::RDS::DBCluster': { service: 'rds', resource: /^cluster:[A-Za-z0-9_.-]+$/ },
  'AWS::RDS::DBInstance': { service: 'rds', resource: /^db:[A-Za-z0-9_.-]+$/ },
  'AWS::RDS::DBClusterParameterGroup': { service: 'rds', resource: /^cluster-pg:[A-Za-z0-9_.-]+$/ },
  'AWS::RDS::DBSubnetGroup': { service: 'rds', resource: /^subgrp:[A-Za-z0-9_.-]+$/ },
  'AWS::EC2::VPC': { service: 'ec2', resource: /^vpc\/vpc-[A-Za-z0-9-]+$/ },
  'AWS::EC2::Subnet': { service: 'ec2', resource: /^subnet\/subnet-[A-Za-z0-9-]+$/ },
  'AWS::EC2::RouteTable': { service: 'ec2', resource: /^route-table\/rtb-[A-Za-z0-9-]+$/ },
  'AWS::EC2::VPCEndpoint': { service: 'ec2', resource: /^vpc-endpoint\/vpce-[A-Za-z0-9-]+$/ },
  'AWS::EC2::SecurityGroup': { service: 'ec2', resource: /^security-group\/sg-[A-Za-z0-9-]+$/ },
  'AWS::EC2::InternetGateway': { service: 'ec2', resource: /^internet-gateway\/igw-[A-Za-z0-9-]+$/ },
  'AWS::EC2::NatGateway': { service: 'ec2', resource: /^natgateway\/nat-[A-Za-z0-9-]+$/ },
  'AWS::EC2::EIP': { service: 'ec2', resource: /^elastic-ip\/eipalloc-[A-Za-z0-9-]+$/ },
  'AWS::SecretsManager::Secret': { service: 'secretsmanager', resource: /^secret:[A-Za-z0-9/_+=.@-]+$/ },
  'AWS::S3::Bucket': { service: 's3', resource: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/ },
};
const validateItem = (item, protect) => {
  if (!exactKeys(item, itemKeys) || typeof item.owner !== 'string' || item.owner.trim() !== item.owner || !item.owner || /[*?\[\]{}]/.test(item.arn)) return false;
  const expectedType = protect ? (item.category === 'GAMELIST_RESOURCE' ? item.resourceType : newFskCategoryType[item.category]) : legacyCategoryType[item.category];
  if (!expectedType || expectedType !== item.resourceType) return false;
  const parts = typeof item.arn === 'string' ? item.arn.split(':') : [];
  if (parts.length < 6 || parts[0] !== 'arn' || parts[1] !== 'aws') return false;
  const service = parts[2];
  const arnContract = arnContractByType[item.resourceType];
  if (!arnContract || arnContract.service !== service) return false;
  const resource = parts.slice(5).join(':');
  if (service === 's3') {
    if (parts[3] !== '' || parts[4] !== '' || !arnContract.resource.test(resource)) return false;
  } else if (parts[3] !== process.env.FSK_EXPECTED_AWS_REGION || parts[4] !== process.env.FSK_EXPECTED_AWS_ACCOUNT_ID || !arnContract.resource.test(resource)) return false;
  if (protect) return item.retentionPolicy === 'DO_NOT_DELETE' && (item.category.startsWith('NEW_FSK_') || item.category === 'GAMELIST_RESOURCE');
  return item.category.startsWith('LEGACY_FSK_') && ['DELETE', 'RETAIN', 'DELETE_AFTER_APPROVED_FINAL_SNAPSHOT'].includes(item.retentionPolicy);
};
const manifestKeys = ['schemaVersion', 'approvalId', 'accountId', 'region', 'newSystemCommit', 'observationEndedAt', 'newFskProtectSetSha256', 'gameListProtectSetSha256', 'retire', 'protect'];
const observationDate = typeof manifest.observationEndedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.observationEndedAt) ? new Date(manifest.observationEndedAt) : null;
if (!exactKeys(manifest, manifestKeys) || manifest.schemaVersion !== 1 || manifest.approvalId !== process.env.FSK_GATE_C_APPROVAL_ID || manifest.accountId !== process.env.FSK_EXPECTED_AWS_ACCOUNT_ID || manifest.region !== process.env.FSK_EXPECTED_AWS_REGION || manifest.newSystemCommit !== process.env.FSK_DEPLOY_COMMIT || !observationDate || Number.isNaN(observationDate.valueOf()) || observationDate.toISOString() !== manifest.observationEndedAt || manifest.newFskProtectSetSha256 !== process.env.FSK_NEW_FSK_PROTECT_SET_SHA256 || manifest.gameListProtectSetSha256 !== process.env.FSK_GAMELIST_PROTECT_SET_SHA256 || !Array.isArray(manifest.retire) || manifest.retire.length === 0 || !Array.isArray(manifest.protect) || !Array.isArray(newFsk) || !Array.isArray(gameList) || gameList.length === 0) process.exit(1);
if (!manifest.retire.every((item) => validateItem(item, false)) || !manifest.protect.every((item) => validateItem(item, true)) || !newFsk.every((item) => validateItem(item, true) && item.category.startsWith('NEW_FSK_')) || !gameList.every((item) => validateItem(item, true) && item.category === 'GAMELIST_RESOURCE')) process.exit(1);
const canonical = (items) => JSON.stringify([...items].sort((left, right) => left.arn.localeCompare(right.arn)));
const manifestNewFsk = manifest.protect.filter((item) => item.category.startsWith('NEW_FSK_'));
const manifestGameList = manifest.protect.filter((item) => item.category === 'GAMELIST_RESOURCE');
if (canonical(manifestNewFsk) !== canonical(newFsk) || canonical(manifestGameList) !== canonical(gameList)) process.exit(1);
const all = [...manifest.retire, ...manifest.protect];
const arns = all.map((item) => item.arn);
if (new Set(arns).size !== arns.length) process.exit(1);
const counts = new Map();
for (const item of newFsk) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
const exactRequired = { NEW_FSK_AMPLIFY_APP: 1, NEW_FSK_COGNITO_POOL: 1, NEW_FSK_APPSYNC_API: 1, NEW_FSK_DYNAMODB_TABLE: 4, NEW_FSK_STORAGE_BUCKET: 1, NEW_FSK_FUNCTION: 1 };
if (Object.entries(exactRequired).some(([category, count]) => counts.get(category) !== count) || (counts.get('NEW_FSK_CLOUDFORMATION_STACK') ?? 0) < 1) process.exit(1);
const expectedAppArn = `arn:aws:amplify:${process.env.FSK_EXPECTED_AWS_REGION}:${process.env.FSK_EXPECTED_AWS_ACCOUNT_ID}:apps/${process.env.FSK_AMPLIFY_APP_ID}`;
if (!newFsk.some((item) => item.category === 'NEW_FSK_AMPLIFY_APP' && item.arn === expectedAppArn)) process.exit(1);
NODE
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
