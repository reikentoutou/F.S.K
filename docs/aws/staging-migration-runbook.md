# FSK staging CloudShell VPC migration Runbook

## 0. 边界与责任

本手册只用于获得独立 Migration ApprovalId 后的一次性 staging DDL。当前 `GateStatus=APPROVED_MIGRATION`，只允许按第 7 节绑定的 exact operation tuple、网络范围和截止时间执行；任何不一致立即停止。

允许的临时拓扑只有：普通 CloudShell control session、VPC CloudShell worker session、带完整 ownership tuple 的单个运维 SG/数据库 ingress、IGW、public subnet/route table、EIP、NAT，以及两个 application route table 上的临时默认路由。长期状态仍是无 NAT、无 Interface Endpoint、无 `5432` ingress。

两个 shell 的权限和生命周期严格分离：

- **control** 创建临时状态和网络，运行 deadline watchdog，并独占 EC2/SSM cleanup；control tab 不得关闭。
- **worker** 只准备 exact source、构造进程内数据库 URL、执行 migration 两次和 verify、发布状态；worker 绝不删除自己的路由或 SG。
- 三个临时 SSM `String` parameters 只传 operation state/status、持久化 cleanup failure latch 和非敏感资源 ID。worker 只能在临时 NAT 就绪后访问它们。它们不是长期 endpoint 的替代品，最终必须删除。

Migration ApprovalId 必须给出：account `444083008754`、region `ap-northeast-1`、exact foundation commit/tag、TaskId、UUIDv4 OperationToken、operation deadline、稍晚的 cleanup deadline、临时 public CIDR/AZ、两个 application route table IDs、CostOwner 和 CleanupOwner。OperationToken 是非秘密所有权证据，不是授权凭据。

## 1. 远程源码和初始残留门

control 和 worker 都只接受 immutable remote tag、remote `staging` 和批准 commit 三者精确相等。clone/fetch 后使用 detached HEAD；origin URL 不得含 credentials，工作树必须 clean。

```bash
set -euo pipefail
: "${FSK_GIT_REMOTE_URL:=https://github.com/reikentoutou/F.S.K.git}"
: "${FSK_FOUNDATION_TAG:=fsk-staging-data-api-foundation-v1}"
: "${FSK_FOUNDATION_COMMIT:?use the approved 40-character commit}"
case "$FSK_FOUNDATION_COMMIT" in
  *[!0-9a-f]*|'') echo 'FOUNDATION_COMMIT_INVALID_STOP' >&2; exit 1 ;;
esac
test "${#FSK_FOUNDATION_COMMIT}" -eq 40
FSK_REMOTE_TAG_COMMIT="$(
  git ls-remote --tags "$FSK_GIT_REMOTE_URL" \
    "refs/tags/${FSK_FOUNDATION_TAG}^{}" | awk 'NF { print $1 }'
)"
FSK_REMOTE_STAGING_COMMIT="$(
  git ls-remote --heads "$FSK_GIT_REMOTE_URL" refs/heads/staging |
    awk 'NF { print $1 }'
)"
test "$FSK_REMOTE_TAG_COMMIT" = "$FSK_FOUNDATION_COMMIT"
test "$FSK_REMOTE_STAGING_COMMIT" = "$FSK_FOUNDATION_COMMIT"
```

任何同 ownership tuple 的残留都先进入恢复/清理，不得新建第二套资源。同 TaskId 但不同 OperationToken 的资源属于未知所有者，只报告并 `STOP`，不得删除。

## 2. 公共 guard、deadline 和 ownership

下面函数在两个 session 使用；control 先设置 `FSK_MIGRATION_SHELL_ROLE=control`，worker 恢复相同证据后设置 `worker`。所有长命令都经 operation deadline 派生的 `timeout`，且不使用 `--foreground`，从而让 TERM/KILL 覆盖 pnpm/Node 子树。

```bash
fsk_render_temporary_tags() {
  node -e '
    const required = [
      ["Project", "FSK"],
      ["Environment", "staging"],
      ["ManagedBy", "AmplifyGen2"],
      ["CostCenter", "FSK"],
      ["AccountId", process.env.FSK_AWS_ACCOUNT_ID],
      ["VpcId", process.env.FSK_VPC_ID],
      ["TaskId", process.env.FSK_MIGRATION_TASK_ID],
      ["OperationToken", process.env.FSK_MIGRATION_OPERATION_TOKEN],
    ];
    if (required.some(([, value]) => !value)) process.exit(2);
    process.stdout.write(JSON.stringify(
      required.map(([Key, Value]) => ({ Key, Value })),
    ));
  '
}

fsk_assert_operation_token() {
  local token="${1:-}"
  if [[ ! "$token" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    echo 'OPERATION_TOKEN_INVALID_STOP' >&2
    return 1
  fi
}

fsk_assert_migration_deadline() {
  if [ "$(date +%s)" -ge "$FSK_MIGRATION_OPERATION_DEADLINE_EPOCH" ]; then
    echo 'MIGRATION_OPERATION_DEADLINE_EXCEEDED' >&2
    return 124
  fi
}

fsk_run_before_migration_deadline() {
  local remaining
  fsk_assert_migration_deadline
  remaining=$((FSK_MIGRATION_OPERATION_DEADLINE_EPOCH - $(date +%s)))
  timeout --signal=TERM --kill-after=10 "$remaining" "$@"
}

fsk_seconds_before_cleanup_deadline() {
  local remaining
  remaining=$((FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH - $(date +%s)))
  if [ "$remaining" -le 0 ]; then
    echo 'CLEANUP_DEADLINE_EXCEEDED_BLOCKED' >&2
    return 124
  fi
  printf '%s\n' "$remaining"
}

fsk_run_before_cleanup_deadline() {
  local remaining limit
  remaining="$(fsk_seconds_before_cleanup_deadline)" || return $?
  : "${FSK_CLEANUP_COMMAND_MAX_SECONDS:=30}"
  limit="$remaining"
  if [ "$limit" -gt "$FSK_CLEANUP_COMMAND_MAX_SECONDS" ]; then
    limit="$FSK_CLEANUP_COMMAND_MAX_SECONDS"
  fi
  timeout --signal=TERM --kill-after=5 "$limit" "$@"
}

fsk_sleep_before_cleanup_deadline() {
  local seconds="${1:?sleep seconds required}"
  [ "$seconds" -eq 0 ] || \
    fsk_run_before_cleanup_deadline sleep "$seconds"
}

fsk_run_current_deadline() {
  if [ "${FSK_MIGRATION_PHASE:-operation}" = cleanup ]; then
    fsk_run_before_cleanup_deadline "$@"
  else
    fsk_run_before_migration_deadline "$@"
  fi
}

fsk_require_single_owned_id() {
  local values="${1:-}"
  local prefix="${2:?ID prefix required}"
  local count
  count="$(printf '%s\n' "$values" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [ "$count" -ne 1 ]; then
    echo 'OWNED_ID_COUNT_NOT_ONE_STOP' >&2
    return 1
  fi
  values="$(printf '%s\n' "$values" | awk 'NF { print $1 }')"
  case "$values" in
    "${prefix}"*) printf '%s\n' "$values" ;;
    *) echo 'OWNED_ID_FORMAT_INVALID_STOP' >&2; return 1 ;;
  esac
}

fsk_assert_exact_ownership_tags() {
  local tags_json="${1:?tags JSON required}"
  FSK_TAGS_JSON="$tags_json" \
  FSK_EXPECTED_ACCOUNT_ID="$FSK_AWS_ACCOUNT_ID" \
  FSK_EXPECTED_VPC_ID="$FSK_VPC_ID" \
  FSK_EXPECTED_TASK_ID="$FSK_MIGRATION_TASK_ID" \
  FSK_EXPECTED_OPERATION_TOKEN="$FSK_MIGRATION_OPERATION_TOKEN" \
  node -e '
    const tags = JSON.parse(process.env.FSK_TAGS_JSON ?? "");
    if (!Array.isArray(tags)) process.exit(2);
    const expected = {
      Project: "FSK",
      Environment: "staging",
      ManagedBy: "AmplifyGen2",
      CostCenter: "FSK",
      AccountId: process.env.FSK_EXPECTED_ACCOUNT_ID,
      VpcId: process.env.FSK_EXPECTED_VPC_ID,
      TaskId: process.env.FSK_EXPECTED_TASK_ID,
      OperationToken: process.env.FSK_EXPECTED_OPERATION_TOKEN,
    };
    const byKey = new Map();
    for (const tag of tags) {
      if (typeof tag?.Key !== "string" || typeof tag?.Value !== "string" ||
          byKey.has(tag.Key)) process.exit(2);
      byKey.set(tag.Key, tag.Value);
    }
    if (Object.entries(expected).some(([key, value]) =>
      !value || byKey.get(key) !== value)) process.exit(2);
  '
}

fsk_select_exact_owned_resource_ids() {
  local collection="${1:?collection required}"
  local id_field="${2:?ID field required}"
  local input candidates id encoded tags_json
  input="$(cat)"
  candidates="$(FSK_RESOURCE_JSON="$input" \
    FSK_RESOURCE_COLLECTION="$collection" \
    FSK_RESOURCE_ID_FIELD="$id_field" \
    node -e '
      const input = JSON.parse(process.env.FSK_RESOURCE_JSON ?? "");
      const collection = process.env.FSK_RESOURCE_COLLECTION;
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          !collection || !Object.hasOwn(input, collection) ||
          !Array.isArray(input[collection])) process.exit(2);
      const resources = input[collection];
      for (const resource of resources) {
        const id = resource?.[process.env.FSK_RESOURCE_ID_FIELD];
        const tags = resource?.Tags;
        const keys = Array.isArray(tags) ? tags.map((tag) => tag?.Key) : [];
        if (!resource || typeof resource !== "object" || Array.isArray(resource) ||
            typeof id !== "string" || !id || !Array.isArray(tags) ||
            tags.some((tag) => !tag || typeof tag !== "object" ||
              typeof tag.Key !== "string" || !tag.Key ||
              typeof tag.Value !== "string") ||
            new Set(keys).size !== keys.length) process.exit(2);
        process.stdout.write(`${id}\t${encodeURIComponent(JSON.stringify(resource.Tags))}\n`);
      }
    '
  )" || return 1
  while IFS=$'\t' read -r id encoded; do
    [ -n "$id" ] || continue
    tags_json="$(FSK_ENCODED_TAGS="$encoded" node -e '
      process.stdout.write(decodeURIComponent(process.env.FSK_ENCODED_TAGS ?? ""));
    ')" || return 1
    if fsk_assert_exact_ownership_tags "$tags_json"; then
      printf '%s\n' "$id"
    fi
  done <<< "$candidates"
}

fsk_assert_no_task_id_collision() {
  local mappings candidates arn encoded tags_json parameters parameter_names name tags
  mappings="$(fsk_run_current_deadline \
    aws resourcegroupstaggingapi get-resources --region ap-northeast-1 \
      --tag-filters Key=TaskId,Values="$FSK_MIGRATION_TASK_ID" \
      --output json)" || return 1
  candidates="$(FSK_COLLISION_JSON="$mappings" node -e '
    const input = JSON.parse(process.env.FSK_COLLISION_JSON ?? "");
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        !Object.hasOwn(input, "ResourceTagMappingList") ||
        !Array.isArray(input.ResourceTagMappingList)) process.exit(2);
    for (const item of input.ResourceTagMappingList) {
      const tags = item?.Tags;
      const keys = Array.isArray(tags) ? tags.map((tag) => tag?.Key) : [];
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          typeof item.ResourceARN !== "string" || !item.ResourceARN ||
          !Array.isArray(tags) || tags.some((tag) =>
            !tag || typeof tag !== "object" ||
            typeof tag.Key !== "string" || !tag.Key ||
            typeof tag.Value !== "string") ||
          new Set(keys).size !== keys.length) process.exit(2);
      process.stdout.write(`${item.ResourceARN}\t${encodeURIComponent(JSON.stringify(tags))}\n`);
    }
  ')" || return 1
  while IFS=$'\t' read -r arn encoded; do
    [ -n "$arn" ] || continue
    tags_json="$(FSK_ENCODED_TAGS="$encoded" node -e '
      process.stdout.write(decodeURIComponent(process.env.FSK_ENCODED_TAGS ?? ""));
    ')" || return 1
    if ! fsk_assert_exact_ownership_tags "$tags_json"; then
      echo 'TASK_ID_OWNERSHIP_COLLISION_STOP' >&2
      return 1
    fi
  done <<< "$candidates"

  parameters="$(fsk_run_current_deadline aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters \
      "Key=Name,Option=BeginsWith,Values=/fsk/staging/migration/${FSK_MIGRATION_TASK_ID}/" \
    --output json)" || return 1
  parameter_names="$(FSK_PARAMETERS_JSON="$parameters" node -e '
    const input = JSON.parse(process.env.FSK_PARAMETERS_JSON ?? "");
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        !Object.hasOwn(input, "Parameters") ||
        !Array.isArray(input.Parameters)) process.exit(2);
    for (const parameter of input.Parameters) {
      if (!parameter || typeof parameter !== "object" || Array.isArray(parameter) ||
          typeof parameter.Name !== "string" || !parameter.Name) process.exit(2);
      console.log(parameter.Name);
    }
  ')" || return 1
  while read -r name; do
    [ -n "$name" ] || continue
    tags="$(fsk_run_current_deadline aws ssm list-tags-for-resource \
      --region ap-northeast-1 --resource-type Parameter \
      --resource-id "$name" --query TagList --output json)" || return 1
    if ! fsk_assert_exact_ownership_tags "$tags"; then
      echo 'TASK_ID_OWNERSHIP_COLLISION_STOP' >&2
      return 1
    fi
  done <<< "$parameter_names"
}
```

```bash
set -euo pipefail
export AWS_REGION=ap-northeast-1
export AWS_DEFAULT_REGION=ap-northeast-1
FSK_AWS_ACCOUNT_ID=444083008754
: "${FSK_MIGRATION_APPROVAL_ID:?separate Migration approval required}"
: "${FSK_MIGRATION_SHELL_ROLE:?control or worker required}"
: "${FSK_MIGRATION_TASK_ID:?approved TaskId required}"
: "${FSK_MIGRATION_OPERATION_TOKEN:?approved UUIDv4 required}"
: "${FSK_MIGRATION_OPERATION_DEADLINE_EPOCH:?approved operation deadline required}"
: "${FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH:?approved cleanup deadline required}"
: "${FSK_MIGRATION_CLEANUP_OWNER:?approved CleanupOwner required}"
: "${FSK_VPC_ID:?exact Foundation VpcId required}"
: "${FSK_DB_SECURITY_GROUP_ID:?exact Foundation database SG required}"
: "${FSK_APP_ROUTE_TABLE_A_ID:?application route table A required}"
: "${FSK_APP_ROUTE_TABLE_B_ID:?application route table B required}"
case "$FSK_MIGRATION_SHELL_ROLE" in control|worker) ;; *) exit 2 ;; esac
case "$FSK_MIGRATION_TASK_ID" in
  *[!A-Za-z0-9_-]*|'') echo 'TASK_ID_INVALID_STOP' >&2; exit 1 ;;
esac
fsk_assert_operation_token "$FSK_MIGRATION_OPERATION_TOKEN"
case "$FSK_MIGRATION_OPERATION_DEADLINE_EPOCH:$FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH" in
  *[!0-9:]*|:*|*:) echo 'DEADLINE_INVALID_STOP' >&2; exit 1 ;;
esac
test "$FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH" -gt \
  "$FSK_MIGRATION_OPERATION_DEADLINE_EPOCH"
test "$((FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH - FSK_MIGRATION_OPERATION_DEADLINE_EPOCH))" \
  -ge 195
test "$(aws sts get-caller-identity --query Account --output text)" = \
  "$FSK_AWS_ACCOUNT_ID"
FSK_TEMP_EC2_TAGS="$(fsk_render_temporary_tags)"
FSK_STATE_PREFIX="/fsk/staging/migration/${FSK_MIGRATION_TASK_ID}/${FSK_MIGRATION_OPERATION_TOKEN}"
FSK_WORKER_STATUS_PARAMETER="${FSK_STATE_PREFIX}/worker-status"
FSK_CONTROL_STATUS_PARAMETER="${FSK_STATE_PREFIX}/control-status"
FSK_STATE_PARAMETER="${FSK_STATE_PREFIX}/state"
```

## 3. 临时状态所有权

每次 overwrite/delete 前后都复验 parameter 名称、类型和完整 tags。状态只含非敏感 ID、commit、deadline、cleanup 观察值和单向 `cleanupFailed` latch；绝不包含 Secret、用户名、密码、数据库 endpoint 或 URL。任何 cleanup mutation/discovery 失败都先持久化 latch；CleanupOwner 重启后必须重新读取，曾经失败的 operation 永远不得发布 PASS。

```bash
fsk_snapshot_state_parameter() {
  local name="${1:?parameter name required}"
  local metadata tags tag_list
  metadata="$(fsk_run_current_deadline aws ssm get-parameter \
    --region ap-northeast-1 \
    --name "$name" \
    --query 'Parameter.{Name:Name,Type:Type,Version:Version}' --output json)" || return 1
  tags="$(fsk_run_current_deadline aws ssm list-tags-for-resource \
    --region ap-northeast-1 \
    --resource-type Parameter --resource-id "$name" --output json)" || return 1
  tag_list="$(FSK_PARAMETER_TAGS="$tags" node -e '
    const input = JSON.parse(process.env.FSK_PARAMETER_TAGS ?? "");
    process.stdout.write(JSON.stringify(input.TagList ?? input));
  ')" || return 1
  fsk_assert_exact_ownership_tags "$tag_list" || return 1
  FSK_PARAMETER_METADATA="$metadata" FSK_PARAMETER_TAGS="$tags" \
  FSK_EXPECTED_PARAMETER_NAME="$name" \
  node -e '
    const metadata = JSON.parse(process.env.FSK_PARAMETER_METADATA ?? "");
    const tagInput = JSON.parse(process.env.FSK_PARAMETER_TAGS ?? "");
    const parameter = metadata.Parameter ?? metadata;
    const tags = tagInput.TagList ?? tagInput;
    if (parameter.Name !== process.env.FSK_EXPECTED_PARAMETER_NAME ||
        parameter.Type !== "String" || !Number.isInteger(parameter.Version) ||
        !Array.isArray(tags)) process.exit(2);
    const byKey = new Map(tags.map((tag) => [tag.Key, tag.Value]));
    process.stdout.write(JSON.stringify({
      name: parameter.Name,
      version: parameter.Version,
      tags: [...byKey.entries()].sort(),
    }));
  '
}

fsk_assert_state_parameter_owned() {
  fsk_snapshot_state_parameter "${1:?parameter name required}" >/dev/null
}

fsk_load_cleanup_failure_latch() {
  local value
  fsk_assert_state_parameter_owned "$FSK_STATE_PARAMETER" || return 1
  value="$(fsk_run_current_deadline aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_STATE_PARAMETER" \
    --query 'Parameter.Value' --output text)" || return 1
  FSK_OPERATION_STATE="$value" node -e '
    const state = JSON.parse(process.env.FSK_OPERATION_STATE ?? "");
    if (!state || typeof state !== "object" || Array.isArray(state) ||
        state.version !== 1 || state.sensitive !== false ||
        typeof state.cleanupFailed !== "boolean") process.exit(2);
    process.stdout.write(state.cleanupFailed ? "1" : "0");
  '
}

fsk_record_cleanup_failure_latch() {
  local value updated
  fsk_assert_state_parameter_owned "$FSK_STATE_PARAMETER" || return 1
  value="$(fsk_run_current_deadline aws ssm get-parameter \
    --region ap-northeast-1 --name "$FSK_STATE_PARAMETER" \
    --query 'Parameter.Value' --output text)" || return 1
  updated="$(FSK_OPERATION_STATE="$value" node -e '
    const state = JSON.parse(process.env.FSK_OPERATION_STATE ?? "");
    if (!state || typeof state !== "object" || Array.isArray(state) ||
        state.version !== 1 || state.sensitive !== false ||
        typeof state.cleanupFailed !== "boolean") process.exit(2);
    process.stdout.write(JSON.stringify({ ...state, cleanupFailed: true }));
  ')" || return 1
  fsk_run_current_deadline aws ssm put-parameter --region ap-northeast-1 \
    --name "$FSK_STATE_PARAMETER" --type String --value "$updated" \
    --overwrite --query Version --output text >/dev/null || return 1
  fsk_assert_state_parameter_owned "$FSK_STATE_PARAMETER"
}

fsk_publish_worker_status() {
  local value="${1:?worker status required}"
  fsk_assert_state_parameter_owned "$FSK_WORKER_STATUS_PARAMETER" || return 1
  fsk_run_current_deadline aws ssm put-parameter --region ap-northeast-1 \
    --name "$FSK_WORKER_STATUS_PARAMETER" --type String \
    --value "$value" --overwrite --query Version --output text >/dev/null || return 1
  fsk_assert_state_parameter_owned "$FSK_WORKER_STATUS_PARAMETER"
}

fsk_publish_control_status() {
  local value="${1:?control status required}"
  fsk_assert_state_parameter_owned "$FSK_CONTROL_STATUS_PARAMETER" || return 1
  fsk_run_current_deadline aws ssm put-parameter --region ap-northeast-1 \
    --name "$FSK_CONTROL_STATUS_PARAMETER" --type String \
    --value "$value" --overwrite --query Version --output text >/dev/null || return 1
  fsk_assert_state_parameter_owned "$FSK_CONTROL_STATUS_PARAMETER"
}

fsk_create_temporary_state_parameters() {
  local name initial
  local tag_args=(
    Key=Project,Value=FSK
    Key=Environment,Value=staging
    Key=ManagedBy,Value=AmplifyGen2
    Key=CostCenter,Value=FSK
    "Key=AccountId,Value=${FSK_AWS_ACCOUNT_ID}"
    "Key=VpcId,Value=${FSK_VPC_ID}"
    "Key=TaskId,Value=${FSK_MIGRATION_TASK_ID}"
    "Key=OperationToken,Value=${FSK_MIGRATION_OPERATION_TOKEN}"
  )
  for name in \
    "$FSK_WORKER_STATUS_PARAMETER" \
    "$FSK_CONTROL_STATUS_PARAMETER" \
    "$FSK_STATE_PARAMETER"; do
    test "$(fsk_run_current_deadline aws ssm describe-parameters \
      --region ap-northeast-1 \
      --parameter-filters "Key=Name,Option=Equals,Values=${name}" \
      --query 'length(Parameters)' --output text)" -eq 0
    case "$name" in
      "$FSK_WORKER_STATUS_PARAMETER") initial=WAITING_FOR_WORKER ;;
      "$FSK_CONTROL_STATUS_PARAMETER") initial=CONTROL_RUNNING ;;
      *) initial='{"version":1,"sensitive":false,"cleanupFailed":false}' ;;
    esac
    if ! fsk_run_current_deadline aws ssm put-parameter \
      --region ap-northeast-1 \
      --name "$name" --type String --value "$initial" \
      --tags "${tag_args[@]}" --query Version --output text >/dev/null; then
      fsk_assert_state_parameter_owned "$name" || return 1
    fi
    fsk_assert_state_parameter_owned "$name" || return 1
  done
}
```

## 4. control 创建临时访问

创建前必须只读证明两个 application route table 都没有默认路由、database SG 没有本 OperationToken 的规则、完整 ownership tuple 残留数为 0。每个可标签 create 在请求中一次带齐 tags；CLI 非零或返回 ID 丢失时，只按完整 tuple 反查并要求唯一结果。

```bash
fsk_discover_owned_operations_sg_ids() {
  fsk_run_current_deadline aws ec2 describe-security-groups \
    --region ap-northeast-1 \
    --filters \
      "Name=vpc-id,Values=${FSK_VPC_ID}" \
      'Name=tag:Project,Values=FSK' \
      'Name=tag:Environment,Values=staging' \
      'Name=tag:ManagedBy,Values=AmplifyGen2' \
      'Name=tag:CostCenter,Values=FSK' \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_MIGRATION_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_MIGRATION_OPERATION_TOKEN}" \
    --output json |
    fsk_select_exact_owned_resource_ids SecurityGroups GroupId
}

fsk_create_or_recover_operations_sg() {
  fsk_create_or_recover_owned_id sg- \
    fsk_discover_owned_operations_sg_ids \
    aws ec2 create-security-group --region ap-northeast-1 \
      --vpc-id "$FSK_VPC_ID" \
      --group-name "fsk-staging-migration-${FSK_MIGRATION_TASK_ID}-${FSK_MIGRATION_OPERATION_TOKEN}" \
      --description 'FSK staging temporary migration access' \
      --tag-specifications "[{\"ResourceType\":\"security-group\",\"Tags\":${FSK_TEMP_EC2_TAGS}}]" \
      --query 'GroupId' --output text
}

fsk_create_or_recover_owned_id() {
  local prefix="${1:?ID prefix required}"
  local discovery_function="${2:?discovery function required}"
  shift 2
  local id=''
  if ! id="$(fsk_run_before_migration_deadline "$@")"; then
    id=''
  fi
  if ! fsk_require_single_owned_id "$id" "$prefix" >/dev/null 2>&1; then
    id="$("$discovery_function")" || return 1
  fi
  fsk_require_single_owned_id "$id" "$prefix"
}

fsk_discover_owned_igw_ids() {
  fsk_run_current_deadline aws ec2 describe-internet-gateways \
    --region ap-northeast-1 \
    --filters 'Name=tag:Project,Values=FSK' \
      'Name=tag:Environment,Values=staging' \
      'Name=tag:ManagedBy,Values=AmplifyGen2' \
      'Name=tag:CostCenter,Values=FSK' \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:OperationToken,Values=${FSK_MIGRATION_OPERATION_TOKEN}" \
      "Name=tag:TaskId,Values=${FSK_MIGRATION_TASK_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
    --output json |
    fsk_select_exact_owned_resource_ids InternetGateways InternetGatewayId
}

fsk_discover_owned_public_subnet_ids() {
  fsk_run_current_deadline aws ec2 describe-subnets --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      'Name=tag:Project,Values=FSK' \
      'Name=tag:Environment,Values=staging' \
      'Name=tag:ManagedBy,Values=AmplifyGen2' \
      'Name=tag:CostCenter,Values=FSK' \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:OperationToken,Values=${FSK_MIGRATION_OPERATION_TOKEN}" \
      "Name=tag:TaskId,Values=${FSK_MIGRATION_TASK_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
    --output json |
    fsk_select_exact_owned_resource_ids Subnets SubnetId
}

fsk_discover_owned_route_table_ids() {
  fsk_run_current_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 \
    --filters "Name=vpc-id,Values=${FSK_VPC_ID}" \
      'Name=tag:Project,Values=FSK' \
      'Name=tag:Environment,Values=staging' \
      'Name=tag:ManagedBy,Values=AmplifyGen2' \
      'Name=tag:CostCenter,Values=FSK' \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:OperationToken,Values=${FSK_MIGRATION_OPERATION_TOKEN}" \
      "Name=tag:TaskId,Values=${FSK_MIGRATION_TASK_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
    --output json |
    fsk_select_exact_owned_resource_ids RouteTables RouteTableId
}

fsk_discover_owned_eip_ids() {
  fsk_run_current_deadline aws ec2 describe-addresses \
    --region ap-northeast-1 \
    --filters 'Name=tag:Project,Values=FSK' \
      'Name=tag:Environment,Values=staging' \
      'Name=tag:ManagedBy,Values=AmplifyGen2' \
      'Name=tag:CostCenter,Values=FSK' \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:OperationToken,Values=${FSK_MIGRATION_OPERATION_TOKEN}" \
      "Name=tag:TaskId,Values=${FSK_MIGRATION_TASK_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
    --output json |
    fsk_select_exact_owned_resource_ids Addresses AllocationId
}

fsk_discover_owned_nat_ids() {
  fsk_run_current_deadline aws ec2 describe-nat-gateways \
    --region ap-northeast-1 \
    --filter "Name=vpc-id,Values=${FSK_VPC_ID}" \
      'Name=tag:Project,Values=FSK' \
      'Name=tag:Environment,Values=staging' \
      'Name=tag:ManagedBy,Values=AmplifyGen2' \
      'Name=tag:CostCenter,Values=FSK' \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:OperationToken,Values=${FSK_MIGRATION_OPERATION_TOKEN}" \
      "Name=tag:TaskId,Values=${FSK_MIGRATION_TASK_ID}" \
      'Name=state,Values=pending,available,deleting,failed' \
    --output json |
    fsk_select_exact_owned_resource_ids NatGateways NatGatewayId
}

fsk_select_exact_owned_db_ingress_ids() {
  local input candidates id semantic encoded tags_json
  input="$(cat)"
  candidates="$(FSK_RULES_JSON="$input" \
    FSK_EXPECTED_DB_SG="$FSK_DB_SECURITY_GROUP_ID" \
    FSK_EXPECTED_OPS_SG="$FSK_OPS_SG_ID" \
    FSK_EXPECTED_ACCOUNT="$FSK_AWS_ACCOUNT_ID" \
    node -e '
      const input = JSON.parse(process.env.FSK_RULES_JSON ?? "");
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          !Object.hasOwn(input, "SecurityGroupRules") ||
          !Array.isArray(input.SecurityGroupRules)) process.exit(2);
      for (const rule of input.SecurityGroupRules) {
        const tags = rule?.Tags;
        const keys = Array.isArray(tags) ? tags.map((tag) => tag?.Key) : [];
        const referenced = rule?.ReferencedGroupInfo;
        if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
            typeof rule.SecurityGroupRuleId !== "string" || !rule.SecurityGroupRuleId ||
            typeof rule.GroupId !== "string" || !rule.GroupId ||
            typeof rule.GroupOwnerId !== "string" || !rule.GroupOwnerId ||
            typeof rule.IsEgress !== "boolean" ||
            typeof rule.IpProtocol !== "string" || !rule.IpProtocol ||
            !Array.isArray(tags) || tags.some((tag) =>
              !tag || typeof tag !== "object" ||
              typeof tag.Key !== "string" || !tag.Key ||
              typeof tag.Value !== "string") ||
            new Set(keys).size !== keys.length ||
            (rule.FromPort !== undefined && !Number.isInteger(rule.FromPort)) ||
            (rule.ToPort !== undefined && !Number.isInteger(rule.ToPort)) ||
            (referenced !== undefined &&
              (!referenced || typeof referenced !== "object" ||
               typeof referenced.GroupId !== "string" || !referenced.GroupId ||
               typeof referenced.UserId !== "string" || !referenced.UserId))) {
          process.exit(2);
        }
        const semantic = rule.GroupId === process.env.FSK_EXPECTED_DB_SG &&
          rule.GroupOwnerId === process.env.FSK_EXPECTED_ACCOUNT &&
          rule.IsEgress === false && rule.IpProtocol === "tcp" &&
          rule.FromPort === 5432 && rule.ToPort === 5432 &&
          rule.ReferencedGroupInfo?.GroupId === process.env.FSK_EXPECTED_OPS_SG &&
          rule.ReferencedGroupInfo?.UserId === process.env.FSK_EXPECTED_ACCOUNT;
        process.stdout.write(`${rule.SecurityGroupRuleId}\t${semantic ? 1 : 0}\t${encodeURIComponent(JSON.stringify(tags))}\n`);
      }
    '
  )" || return 1
  while IFS=$'\t' read -r id semantic encoded; do
    [ -n "$id" ] || continue
    tags_json="$(FSK_ENCODED_TAGS="$encoded" node -e '
      process.stdout.write(decodeURIComponent(process.env.FSK_ENCODED_TAGS ?? ""));
    ')" || return 1
    if [ "$semantic" -eq 1 ] && fsk_assert_exact_ownership_tags "$tags_json"; then
      printf '%s\n' "$id"
    fi
  done <<< "$candidates"
}

fsk_discover_owned_db_ingress_ids() {
  fsk_run_current_deadline aws ec2 describe-security-group-rules \
    --region ap-northeast-1 \
    --filters "Name=group-id,Values=${FSK_DB_SECURITY_GROUP_ID}" \
      'Name=tag:Project,Values=FSK' \
      'Name=tag:Environment,Values=staging' \
      'Name=tag:ManagedBy,Values=AmplifyGen2' \
      'Name=tag:CostCenter,Values=FSK' \
      "Name=tag:AccountId,Values=${FSK_AWS_ACCOUNT_ID}" \
      "Name=tag:VpcId,Values=${FSK_VPC_ID}" \
      "Name=tag:TaskId,Values=${FSK_MIGRATION_TASK_ID}" \
      "Name=tag:OperationToken,Values=${FSK_MIGRATION_OPERATION_TOKEN}" \
    --output json |
    fsk_select_exact_owned_db_ingress_ids
}
```

```bash
fsk_create_temporary_access() {
  : "${FSK_TEMP_PUBLIC_CIDR:?approved unused CIDR required}"
  : "${FSK_TEMP_AZ:?approved availability zone required}"
  FSK_OPS_SG_ID="$(fsk_create_or_recover_operations_sg)"

  FSK_DB_INGRESS_RULE_ID="$(fsk_create_or_recover_owned_id sgr- \
    fsk_discover_owned_db_ingress_ids \
    aws ec2 authorize-security-group-ingress --region ap-northeast-1 \
      --group-id "$FSK_DB_SECURITY_GROUP_ID" \
      --protocol tcp --port 5432 --source-group "$FSK_OPS_SG_ID" \
      --tag-specifications "[{\"ResourceType\":\"security-group-rule\",\"Tags\":${FSK_TEMP_EC2_TAGS}}]" \
      --query 'SecurityGroupRules[0].SecurityGroupRuleId' --output text)"

  FSK_TEMP_IGW_ID="$(fsk_create_or_recover_owned_id igw- \
    fsk_discover_owned_igw_ids aws ec2 create-internet-gateway \
    --region ap-northeast-1 \
    --tag-specifications "[{\"ResourceType\":\"internet-gateway\",\"Tags\":${FSK_TEMP_EC2_TAGS}}]" \
    --query 'InternetGateway.InternetGatewayId' --output text)"
  if ! fsk_run_before_migration_deadline aws ec2 attach-internet-gateway \
    --region ap-northeast-1 \
    --internet-gateway-id "$FSK_TEMP_IGW_ID" --vpc-id "$FSK_VPC_ID"; then
    test "$(fsk_run_before_migration_deadline \
      aws ec2 describe-internet-gateways --region ap-northeast-1 \
      --internet-gateway-ids "$FSK_TEMP_IGW_ID" \
      --query 'InternetGateways[0].Attachments[0].VpcId' --output text)" = \
      "$FSK_VPC_ID"
  fi

  FSK_TEMP_PUBLIC_SUBNET_ID="$(fsk_create_or_recover_owned_id subnet- \
    fsk_discover_owned_public_subnet_ids aws ec2 create-subnet \
    --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
    --cidr-block "$FSK_TEMP_PUBLIC_CIDR" --availability-zone "$FSK_TEMP_AZ" \
    --tag-specifications "[{\"ResourceType\":\"subnet\",\"Tags\":${FSK_TEMP_EC2_TAGS}}]" \
    --query 'Subnet.SubnetId' --output text)"
  FSK_TEMP_ROUTE_TABLE_ID="$(fsk_create_or_recover_owned_id rtb- \
    fsk_discover_owned_route_table_ids aws ec2 create-route-table \
    --region ap-northeast-1 --vpc-id "$FSK_VPC_ID" \
    --tag-specifications "[{\"ResourceType\":\"route-table\",\"Tags\":${FSK_TEMP_EC2_TAGS}}]" \
    --query 'RouteTable.RouteTableId' --output text)"
  fsk_run_before_migration_deadline aws ec2 associate-route-table \
    --region ap-northeast-1 \
    --route-table-id "$FSK_TEMP_ROUTE_TABLE_ID" \
    --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" >/dev/null
  fsk_run_before_migration_deadline aws ec2 create-route \
    --region ap-northeast-1 \
    --route-table-id "$FSK_TEMP_ROUTE_TABLE_ID" \
    --destination-cidr-block 0.0.0.0/0 \
    --gateway-id "$FSK_TEMP_IGW_ID" >/dev/null

  FSK_TEMP_EIP_ID="$(fsk_create_or_recover_owned_id eipalloc- \
    fsk_discover_owned_eip_ids aws ec2 allocate-address \
    --region ap-northeast-1 --domain vpc \
    --tag-specifications "[{\"ResourceType\":\"elastic-ip\",\"Tags\":${FSK_TEMP_EC2_TAGS}}]" \
    --query 'AllocationId' --output text)"
  FSK_TEMP_NAT_ID="$(fsk_create_or_recover_owned_id nat- \
    fsk_discover_owned_nat_ids aws ec2 create-nat-gateway \
    --region ap-northeast-1 --connectivity-type public \
    --subnet-id "$FSK_TEMP_PUBLIC_SUBNET_ID" \
    --allocation-id "$FSK_TEMP_EIP_ID" \
    --tag-specifications "[{\"ResourceType\":\"natgateway\",\"Tags\":${FSK_TEMP_EC2_TAGS}}]" \
    --query 'NatGateway.NatGatewayId' --output text)"
  fsk_run_before_migration_deadline aws ec2 wait nat-gateway-available \
    --region ap-northeast-1 --nat-gateway-ids "$FSK_TEMP_NAT_ID"
  fsk_run_before_migration_deadline aws ec2 create-route \
    --region ap-northeast-1 \
    --route-table-id "$FSK_APP_ROUTE_TABLE_A_ID" \
    --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$FSK_TEMP_NAT_ID"
  fsk_run_before_migration_deadline aws ec2 create-route \
    --region ap-northeast-1 \
    --route-table-id "$FSK_APP_ROUTE_TABLE_B_ID" \
    --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$FSK_TEMP_NAT_ID"
}
```

创建后只记录资源 ID、operation tuple、deadline、actor、JST 和 state parameter version。随后用两个 application subnets、`FSK_OPS_SG_ID` 创建精确 VPC CloudShell environment。先证明 worker 能经临时 NAT 读取自己的 status，再继续；不得创建额外网络资源。

## 5. worker：exact source、migration 两次和 verify

worker 从批准证据恢复 exact commit/tag、operation token、deadline 和 parameter names。先安装失败 trap；trap 只清除敏感环境并发布 `FAILED:*`，EC2 cleanup 始终由 control 执行。

```bash
fsk_worker_exit() {
  local original_status="${1:-1}"
  trap - EXIT HUP INT TERM
  set +e
  unset DATABASE_URL
  if [ "${FSK_WORKER_READY_FOR_CLEANUP:-0}" -ne 1 ]; then
    fsk_publish_worker_status "FAILED:WORKER_EXIT_${original_status}" || true
    if [ "$original_status" -eq 0 ]; then original_status=1; fi
  fi
  exit "$original_status"
}

fsk_build_database_url() {
  set +x
  DATABASE_URL="$(
    fsk_run_before_migration_deadline aws secretsmanager get-secret-value \
      --region ap-northeast-1 --secret-id "$FSK_AURORA_SECRET_ARN" \
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
            `@${endpoint}:${port}/${database}?sslmode=require`,
          );
        } catch {
          process.exit(2);
        }
      });
    '
  )" || return 1
  export DATABASE_URL
}

fsk_worker_run_database_migration() {
  test "$FSK_MIGRATION_SHELL_ROLE" = worker
  local first_output second_output verify_output
  fsk_assert_migration_deadline
  fsk_build_database_url
  first_output="$(
    fsk_run_before_migration_deadline pnpm run db:staging:migrate
  )"
  case "$first_output" in
    *'MIGRATIONS_APPLIED count=1'*) ;;
    *) echo 'FIRST_MIGRATION_RESULT_INVALID' >&2; return 1 ;;
  esac
  second_output="$(
    fsk_run_before_migration_deadline pnpm run db:staging:migrate
  )"
  case "$second_output" in
    *'MIGRATIONS_APPLIED count=0'*) ;;
    *) echo 'SECOND_MIGRATION_NOT_NOOP' >&2; return 1 ;;
  esac
  verify_output="$(
    fsk_run_before_migration_deadline pnpm run db:staging:verify
  )"
  case "$verify_output" in
    *'SCHEMA_VERIFIED '*) ;;
    *) echo 'SCHEMA_VERIFY_RESULT_INVALID' >&2; return 1 ;;
  esac
  unset DATABASE_URL
  test -z "${DATABASE_URL+x}"
  fsk_publish_worker_status READY_FOR_CLEANUP
  FSK_WORKER_READY_FOR_CLEANUP=1
}

fsk_worker_run() {
  set -euo pipefail
  FSK_WORKER_READY_FOR_CLEANUP=0
  trap 'fsk_worker_exit "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT TERM
  test "$FSK_MIGRATION_SHELL_ROLE" = worker
  test "$(git rev-parse HEAD)" = "$FSK_FOUNDATION_COMMIT"
  test -z "$(git status --short)"
  fsk_run_before_migration_deadline pnpm install --frozen-lockfile
  fsk_worker_run_database_migration
}
```

Foundation outputs 必须从批准的 exact stack ID 读取，RDS describe 必须证明 endpoint 属于 Foundation VPC、database name 是 `fsk_staging`、全部 instances `PubliclyAccessible=false`。证据只保存“VPC 匹配、private PASS、first count=1、second count=0、verify PASS”和 exit code；不得保存完整 ARN/endpoint/Secret/URL。worker 发布 READY 后，立即在 Console 删除 exact CloudShell worker environment，让 ENI 释放；worker tab 随后关闭。

## 6. control watchdog、幂等 cleanup 和稳定零残留

control 从安装 trap 起就是唯一 cleanup 执行者。看到 `READY_FOR_CLEANUP`、任意 `FAILED:*`、连续三次 status 读取失败或 operation deadline 到达时进入同一 cleanup。control session 丢失时，CleanupOwner 从非敏感 evidence 恢复完整 tuple 和 deadline，并从 owned state parameter 重载 failure latch；不得只按 TaskId 扫描或删除。删除 exact owned NAT 后必须在 cleanup deadline 内观察到其状态为 `deleted`，之后才可释放 EIP。

```bash
fsk_control_watchdog() {
  local failures=0 status
  while [ "$(date +%s)" -lt "$FSK_MIGRATION_OPERATION_DEADLINE_EPOCH" ]; do
    if status="$(fsk_run_before_migration_deadline \
      aws ssm get-parameter --region ap-northeast-1 \
      --name "$FSK_WORKER_STATUS_PARAMETER" \
      --query 'Parameter.Value' --output text)"; then
      failures=0
      case "$status" in
        READY_FOR_CLEANUP) return 0 ;;
        FAILED:*) return 1 ;;
      esac
    else
      failures=$((failures + 1))
      if [ "$failures" -ge 3 ]; then return 1; fi
    fi
    sleep 15
  done
  return 124
}

fsk_start_control_watchdog() {
  fsk_control_watchdog &
  FSK_CONTROL_WATCHDOG_PID=$!
}

fsk_wait_for_worker_terminal_status() {
  wait "$FSK_CONTROL_WATCHDOG_PID"
}

fsk_discover_owned_residual_count() {
  local total=0 value
  value="$(fsk_discover_owned_operations_sg_ids | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  total=$((total + value))
  value="$(fsk_discover_owned_igw_ids | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  total=$((total + value))
  value="$(fsk_discover_owned_public_subnet_ids | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  total=$((total + value))
  value="$(fsk_discover_owned_route_table_ids | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  total=$((total + value))
  value="$(fsk_discover_owned_eip_ids | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  total=$((total + value))
  value="$(fsk_discover_owned_nat_ids | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  total=$((total + value))
  value="$(fsk_discover_owned_db_ingress_ids | awk 'NF { count += 1 } END { print count + 0 }')" || return 1
  total=$((total + value))
  value="$(fsk_count_owned_application_route_residuals)" || return 1
  total=$((total + value))
  printf '%s\n' "$total"
}

fsk_describe_default_route_target() {
  local route_table_id="${1:?route table ID required}"
  local response
  response="$(fsk_run_current_deadline aws ec2 describe-route-tables \
    --region ap-northeast-1 --route-table-ids "$route_table_id" \
    --output json)" || return 1
  FSK_ROUTE_TABLE_JSON="$response" \
  FSK_EXPECTED_ROUTE_TABLE_ID="$route_table_id" \
  FSK_EXPECTED_VPC_ID="$FSK_VPC_ID" \
  node -e '
    const input = JSON.parse(process.env.FSK_ROUTE_TABLE_JSON ?? "");
    if (!Array.isArray(input.RouteTables) || input.RouteTables.length !== 1) process.exit(2);
    const table = input.RouteTables[0];
    if (table.RouteTableId !== process.env.FSK_EXPECTED_ROUTE_TABLE_ID ||
        table.VpcId !== process.env.FSK_EXPECTED_VPC_ID) process.exit(2);
    const routes = (table.Routes ?? []).filter((route) =>
      route.DestinationCidrBlock === "0.0.0.0/0");
    if (routes.length === 0) {
      process.stdout.write("NONE");
      process.exit(0);
    }
    if (routes.length !== 1) process.exit(2);
    const route = routes[0];
    const targets = ["NatGatewayId", "GatewayId", "TransitGatewayId",
      "NetworkInterfaceId", "VpcPeeringConnectionId", "InstanceId"]
      .filter((key) => typeof route[key] === "string" && route[key]);
    if (targets.length !== 1) process.exit(2);
    process.stdout.write(`${targets[0]}:${route[targets[0]]}`);
  '
}

fsk_delete_owned_application_routes() {
  local nat_ids owned_nat_id='' route_table_id target
  nat_ids="$(fsk_discover_owned_nat_ids)" || return 1
  if [ -n "$nat_ids" ]; then
    owned_nat_id="$(fsk_require_single_owned_id "$nat_ids" nat-)" || return 1
  fi
  for route_table_id in \
    "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID"; do
    target="$(fsk_describe_default_route_target "$route_table_id")" || return 1
    case "$target" in
      NONE) ;;
      "NatGatewayId:${owned_nat_id}")
        [ -n "$owned_nat_id" ] || return 1
        fsk_run_before_cleanup_deadline aws ec2 delete-route \
          --region ap-northeast-1 --route-table-id "$route_table_id" \
          --destination-cidr-block 0.0.0.0/0 >/dev/null || return 1
        ;;
      *)
        echo "FOREIGN_DEFAULT_ROUTE_BLOCKED:${route_table_id}:${target}" >&2
        return 1
        ;;
    esac
  done
}

fsk_count_owned_application_route_residuals() {
  local nat_ids owned_nat_id='' route_table_id target count=0
  nat_ids="$(fsk_discover_owned_nat_ids)" || return 1
  if [ -n "$nat_ids" ]; then
    owned_nat_id="$(fsk_require_single_owned_id "$nat_ids" nat-)" || return 1
  fi
  for route_table_id in \
    "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID"; do
    target="$(fsk_describe_default_route_target "$route_table_id")" || return 1
    case "$target" in
      NONE) ;;
      "NatGatewayId:${owned_nat_id}")
        [ -n "$owned_nat_id" ] || return 1
        count=$((count + 1))
        ;;
      *)
        echo "FOREIGN_DEFAULT_ROUTE_BLOCKED:${route_table_id}:${target}" >&2
        return 1
        ;;
    esac
  done
  printf '%s\n' "$count"
}

fsk_wait_for_owned_nat_deleted() {
  local nat_id="${1:?NAT gateway ID required}"
  local response snapshot state encoded tags_json
  while :; do
    response="$(fsk_run_before_cleanup_deadline \
      aws ec2 describe-nat-gateways --region ap-northeast-1 \
        --nat-gateway-ids "$nat_id" --output json)" || return 1
    snapshot="$(FSK_NAT_JSON="$response" FSK_EXPECTED_NAT_ID="$nat_id" node -e '
      const input = JSON.parse(process.env.FSK_NAT_JSON ?? "");
      if (!Object.hasOwn(input, "NatGateways") ||
          !Array.isArray(input.NatGateways) || input.NatGateways.length !== 1) {
        process.exit(2);
      }
      const nat = input.NatGateways[0];
      if (!nat || typeof nat !== "object" ||
          nat.NatGatewayId !== process.env.FSK_EXPECTED_NAT_ID ||
          typeof nat.State !== "string" || !Array.isArray(nat.Tags)) {
        process.exit(2);
      }
      process.stdout.write(`${nat.State}\t${encodeURIComponent(JSON.stringify(nat.Tags))}`);
    ')" || return 1
    IFS=$'\t' read -r state encoded <<< "$snapshot"
    tags_json="$(FSK_ENCODED_TAGS="$encoded" node -e '
      process.stdout.write(decodeURIComponent(process.env.FSK_ENCODED_TAGS ?? ""));
    ')" || return 1
    fsk_assert_exact_ownership_tags "$tags_json" || return 1
    case "$state" in
      deleted) return 0 ;;
      pending|available|deleting|failed)
        fsk_sleep_before_cleanup_deadline "$FSK_CLEANUP_POLL_SECONDS" || return 1
        ;;
      *) echo 'NAT_DELETE_STATE_INVALID_BLOCKED' >&2; return 1 ;;
    esac
  done
}

fsk_delete_owned_temporary_resources_once() {
  local id association ids attachment_vpc
  FSK_MIGRATION_PHASE=cleanup
  fsk_delete_owned_application_routes || return 1

  ids="$(fsk_discover_owned_db_ingress_ids)" || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    fsk_run_before_cleanup_deadline aws ec2 revoke-security-group-ingress \
      --region ap-northeast-1 --group-id "$FSK_DB_SECURITY_GROUP_ID" \
      --security-group-rule-ids "$id" >/dev/null || return 1
  done <<< "$ids"

  ids="$(fsk_discover_owned_nat_ids)" || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    fsk_run_before_cleanup_deadline aws ec2 delete-nat-gateway \
      --region ap-northeast-1 --nat-gateway-id "$id" >/dev/null || return 1
    fsk_wait_for_owned_nat_deleted "$id" || return 1
  done <<< "$ids"

  ids="$(fsk_discover_owned_eip_ids)" || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    fsk_run_before_cleanup_deadline aws ec2 release-address \
      --region ap-northeast-1 --allocation-id "$id" >/dev/null || return 1
  done <<< "$ids"

  ids="$(fsk_discover_owned_route_table_ids)" || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    association="$(fsk_run_before_cleanup_deadline \
      aws ec2 describe-route-tables --region ap-northeast-1 \
        --route-table-ids "$id" \
        --query 'RouteTables[0].Associations[?Main==`false`].RouteTableAssociationId | [0]' \
        --output text)" || return 1
    case "$association" in
      ''|None) ;;
      *) fsk_run_before_cleanup_deadline aws ec2 disassociate-route-table \
        --region ap-northeast-1 --association-id "$association" >/dev/null || return 1 ;;
    esac
    fsk_run_before_cleanup_deadline aws ec2 delete-route-table \
      --region ap-northeast-1 --route-table-id "$id" >/dev/null || return 1
  done <<< "$ids"

  ids="$(fsk_discover_owned_public_subnet_ids)" || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    fsk_run_before_cleanup_deadline aws ec2 delete-subnet \
      --region ap-northeast-1 --subnet-id "$id" >/dev/null || return 1
  done <<< "$ids"

  ids="$(fsk_discover_owned_igw_ids)" || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    attachment_vpc="$(fsk_run_before_cleanup_deadline \
      aws ec2 describe-internet-gateways --region ap-northeast-1 \
        --internet-gateway-ids "$id" \
        --query 'InternetGateways[0].Attachments[0].VpcId' --output text)" || return 1
    if [ "$attachment_vpc" = "$FSK_VPC_ID" ]; then
      fsk_run_before_cleanup_deadline aws ec2 detach-internet-gateway \
        --region ap-northeast-1 --internet-gateway-id "$id" \
        --vpc-id "$FSK_VPC_ID" >/dev/null || return 1
    elif [ "$attachment_vpc" != None ] && [ -n "$attachment_vpc" ]; then
      echo 'IGW_FOREIGN_ATTACHMENT_BLOCKED' >&2
      return 1
    fi
    fsk_run_before_cleanup_deadline aws ec2 delete-internet-gateway \
      --region ap-northeast-1 --internet-gateway-id "$id" >/dev/null || return 1
  done <<< "$ids"

  ids="$(fsk_discover_owned_operations_sg_ids)" || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    fsk_run_before_cleanup_deadline aws ec2 delete-security-group \
      --region ap-northeast-1 --group-id "$id" >/dev/null || return 1
  done <<< "$ids"
}

fsk_delete_state_parameter_if_owned() {
  local name="${1:?parameter name required}"
  local before immediate residual
  FSK_MIGRATION_PHASE=cleanup
  if ! before="$(fsk_snapshot_state_parameter "$name")"; then
    residual="$(fsk_run_before_cleanup_deadline aws ssm describe-parameters \
      --region ap-northeast-1 \
      --parameter-filters "Key=Name,Option=Equals,Values=${name}" \
      --query 'length(Parameters)' --output text)" || return 1
    [ "$residual" -eq 0 ] && return 0
    return 1
  fi
  immediate="$(fsk_snapshot_state_parameter "$name")" || return 1
  test "$before" = "$immediate" || return 1
  if ! fsk_run_before_cleanup_deadline aws ssm delete-parameter \
    --region ap-northeast-1 --name "$name" >/dev/null; then
    residual="$(fsk_run_before_cleanup_deadline aws ssm describe-parameters \
      --region ap-northeast-1 \
      --parameter-filters "Key=Name,Option=Equals,Values=${name}" \
      --query 'length(Parameters)' --output text)" || return 1
    [ "$residual" -eq 0 ] || return 1
    return 0
  fi
  residual="$(fsk_run_before_cleanup_deadline aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters "Key=Name,Option=Equals,Values=${name}" \
    --query 'length(Parameters)' --output text)" || return 1
  [ "$residual" -eq 0 ]
}

fsk_delete_nonterminal_state_parameters() {
  fsk_delete_state_parameter_if_owned "$FSK_WORKER_STATUS_PARAMETER" || return 1
  fsk_delete_state_parameter_if_owned "$FSK_STATE_PARAMETER"
}

fsk_count_state_parameter_path_residuals() {
  fsk_run_before_cleanup_deadline aws ssm describe-parameters \
    --region ap-northeast-1 \
    --parameter-filters "Key=Name,Option=BeginsWith,Values=${FSK_STATE_PREFIX}/" \
    --query 'length(Parameters)' --output text
}

fsk_emit_terminal_cleanup_evidence() {
  local status="${1:?terminal status required}"
  local control_snapshot="${2:?control snapshot required}"
  FSK_TERMINAL_STATUS="$status" \
  FSK_CONTROL_SNAPSHOT="$control_snapshot" \
  FSK_OPERATION_TOKEN="$FSK_MIGRATION_OPERATION_TOKEN" \
  FSK_TASK_ID="$FSK_MIGRATION_TASK_ID" \
  node -e '
    process.stdout.write(JSON.stringify({
      event: "FSK_MIGRATION_TERMINAL_CLEANUP_EVIDENCE",
      status: process.env.FSK_TERMINAL_STATUS,
      taskId: process.env.FSK_TASK_ID,
      operationToken: process.env.FSK_OPERATION_TOKEN,
      controlSnapshot: JSON.parse(process.env.FSK_CONTROL_SNAPSHOT ?? ""),
    }) + "\n");
  '
}

fsk_finalize_cleanup_state() {
  local original_status="${1:-1}"
  local cleanup_failed residual_count control_snapshot terminal_status
  FSK_MIGRATION_PHASE=cleanup
  cleanup_failed="$(fsk_load_cleanup_failure_latch)" || return 1
  if [ "$cleanup_failed" -ne 0 ]; then
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:PREVIOUS_FAILURE:EXIT_${original_status}" || true
    return 1
  fi
  if ! fsk_publish_control_status \
    "CLEANUP_RESOURCES_STABLE_ZERO:EXIT_${original_status}"; then
    return 1
  fi
  if ! fsk_delete_nonterminal_state_parameters; then
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:STATE_DELETE:EXIT_${original_status}" || true
    return 1
  fi
  if ! fsk_assert_no_task_id_collision; then
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:TASK_ID_FINAL_QUERY:EXIT_${original_status}" || true
    return 1
  fi
  residual_count="$(fsk_discover_owned_residual_count)" || {
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:RESOURCE_FINAL_QUERY:EXIT_${original_status}" || true
    return 1
  }
  [ "$residual_count" -eq 0 ] || {
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:RESOURCE_FINAL_RESIDUAL:EXIT_${original_status}" || true
    return 1
  }
  residual_count="$(fsk_count_state_parameter_path_residuals)" || {
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:STATE_FINAL_QUERY:EXIT_${original_status}" || true
    return 1
  }
  [ "$residual_count" -eq 1 ] || {
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:STATE_FINAL_RESIDUAL:EXIT_${original_status}" || true
    return 1
  }
  terminal_status="CLEANUP_PASS:EXIT_${original_status}"
  fsk_publish_control_status \
    "CLEANUP_FINAL_CHECKS_PASS_CONTROL_DELETE_PENDING:EXIT_${original_status}" || return 1
  control_snapshot="$(
    fsk_snapshot_state_parameter "$FSK_CONTROL_STATUS_PARAMETER"
  )" || return 1
  if ! fsk_delete_state_parameter_if_owned "$FSK_CONTROL_STATUS_PARAMETER"; then
    fsk_publish_control_status \
      "CLEANUP_BLOCKED:CONTROL_DELETE:EXIT_${original_status}" || true
    return 1
  fi
  printf 'FINAL_PARAMETER_PATH_RESIDUAL_COUNT=0\n'
  fsk_emit_terminal_cleanup_evidence "$terminal_status" "$control_snapshot"
}
```

```bash
fsk_control_cleanup_owned_resources() {
  local stable_zero=0
  local stable_zero_started=0
  local residual_count delete_succeeded cleanup_failed
  FSK_MIGRATION_PHASE=cleanup
  : "${FSK_STABLE_ZERO_REQUIRED:=3}"
  : "${FSK_STABLE_ZERO_MIN_SECONDS:=180}"
  : "${FSK_CLEANUP_POLL_SECONDS:=15}"
  cleanup_failed="$(fsk_load_cleanup_failure_latch)" || {
    echo 'CLEANUP_FAILURE_LATCH_LOAD_BLOCKED' >&2
    return 1
  }
  while [ "$(date +%s)" -lt "$FSK_MIGRATION_CLEANUP_DEADLINE_EPOCH" ]; do
    delete_succeeded=0
    if fsk_delete_owned_temporary_resources_once; then
      delete_succeeded=1
    else
      fsk_record_cleanup_failure_latch || {
        echo 'CLEANUP_FAILURE_LATCH_PERSIST_BLOCKED' >&2
        return 1
      }
      cleanup_failed=1
      echo 'CLEANUP_MUTATION_FAILED_BLOCKED' >&2
    fi
    if ! residual_count="$(fsk_discover_owned_residual_count)"; then
      fsk_record_cleanup_failure_latch || {
        echo 'CLEANUP_FAILURE_LATCH_PERSIST_BLOCKED' >&2
        return 1
      }
      cleanup_failed=1
      echo 'CLEANUP_DISCOVERY_FAILED_BLOCKED' >&2
      stable_zero=0
      stable_zero_started=0
      fsk_sleep_before_cleanup_deadline "$FSK_CLEANUP_POLL_SECONDS" || return 1
      continue
    fi
    if [ "$delete_succeeded" -eq 1 ] && [ "$residual_count" -eq 0 ]; then
      if [ "$stable_zero" -eq 0 ]; then
        stable_zero_started="$(date +%s)"
      fi
      stable_zero=$((stable_zero + 1))
      if [ "$stable_zero" -ge "$FSK_STABLE_ZERO_REQUIRED" ] && \
        [ "$(( $(date +%s) - stable_zero_started ))" -ge \
          "$FSK_STABLE_ZERO_MIN_SECONDS" ]; then
        residual_count="$(fsk_discover_owned_residual_count)" || return 1
        test "$residual_count" -eq 0 || return 1
        if [ "$cleanup_failed" -ne 0 ]; then
          echo 'CLEANUP_PREVIOUS_FAILURE_BLOCKED' >&2
          return 1
        fi
        printf 'STABLE_ZERO_OBSERVATIONS=%s\n' "$stable_zero"
        return 0
      fi
    else
      stable_zero=0
      stable_zero_started=0
    fi
    fsk_sleep_before_cleanup_deadline "$FSK_CLEANUP_POLL_SECONDS" || return 1
  done
  echo 'CLEANUP_DEADLINE_BLOCKED_OWNER_REQUIRED' >&2
  return 1
}

fsk_control_exit() {
  local original_status="${1:-1}"
  local cleanup_status=0
  local blocked_status
  trap - EXIT HUP INT TERM
  set +e
  FSK_MIGRATION_PHASE=cleanup
  fsk_control_cleanup_owned_resources
  cleanup_status=$?
  if [ "$cleanup_status" -eq 0 ]; then
    fsk_finalize_cleanup_state "$original_status" || cleanup_status=1
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    blocked_status="CLEANUP_BLOCKED:EXIT_${original_status}"
    echo "$blocked_status" >&2
    fsk_publish_control_status "$blocked_status" || true
  fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}

fsk_assert_application_route_tables_ready() {
  local response
  response="$(cat)"
  FSK_ROUTE_TABLES_JSON="$response" \
  FSK_EXPECTED_ROUTE_TABLE_A_ID="$FSK_APP_ROUTE_TABLE_A_ID" \
  FSK_EXPECTED_ROUTE_TABLE_B_ID="$FSK_APP_ROUTE_TABLE_B_ID" \
  FSK_EXPECTED_VPC_ID="$FSK_VPC_ID" \
  node -e '
    const input = JSON.parse(process.env.FSK_ROUTE_TABLES_JSON ?? "");
    const expectedIds = [
      process.env.FSK_EXPECTED_ROUTE_TABLE_A_ID,
      process.env.FSK_EXPECTED_ROUTE_TABLE_B_ID,
    ];
    if (expectedIds.some((id) => typeof id !== "string" || !id) ||
        new Set(expectedIds).size !== 2 ||
        !Object.hasOwn(input, "RouteTables") ||
        !Array.isArray(input.RouteTables) || input.RouteTables.length !== 2) {
      process.exit(2);
    }
    const remaining = new Set(expectedIds);
    for (const table of input.RouteTables) {
      if (!table || typeof table !== "object" ||
          typeof table.RouteTableId !== "string" ||
          !remaining.delete(table.RouteTableId) ||
          table.VpcId !== process.env.FSK_EXPECTED_VPC_ID ||
          !Array.isArray(table.Routes)) process.exit(2);
      for (const route of table.Routes) {
        if (!route || typeof route !== "object") process.exit(2);
        if (route.DestinationCidrBlock === "0.0.0.0/0") process.exit(2);
      }
    }
    if (remaining.size !== 0) process.exit(2);
  '
}

fsk_assert_control_guard() {
  local route_tables
  test "$FSK_MIGRATION_SHELL_ROLE" = control
  fsk_assert_migration_deadline
  route_tables="$(fsk_run_before_migration_deadline \
    aws ec2 describe-route-tables --region ap-northeast-1 \
    --route-table-ids "$FSK_APP_ROUTE_TABLE_A_ID" "$FSK_APP_ROUTE_TABLE_B_ID" \
    --output json)" || return 1
  printf '%s' "$route_tables" | fsk_assert_application_route_tables_ready
}

fsk_control_run_migration() {
  trap 'fsk_control_exit "$?"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT TERM
  fsk_assert_control_guard
  fsk_assert_no_task_id_collision
  test "$(fsk_discover_owned_residual_count)" -eq 0
  fsk_create_temporary_state_parameters
  fsk_create_temporary_access
  fsk_start_control_watchdog
  fsk_wait_for_worker_terminal_status
  exit 0
}
```

## 7. 执行顺序和证据

1. control 安装 EXIT/HUP/INT/TERM trap，证明初始残留为 0，再创建临时参数和网络；任何 response loss 走 full-tuple recovery。
2. control 启动 watchdog 后保持 tab 打开；记录 watchdog PID、operation/cleanup deadline 和 CleanupOwner timer。
3. 创建 exact VPC worker environment；worker detached checkout exact foundation commit，安装 trap，再安装依赖。
4. worker 第一次执行 migration，必须得到 `MIGRATIONS_APPLIED count=1`；第二次必须得到 `count=0`；verify 必须得到 `SCHEMA_VERIFIED`。
5. worker 清除 `DATABASE_URL`、发布 READY，操作者删除 exact worker environment；失败、timeout 或 tab 丢失由 status/deadline 触发 control cleanup。
6. control 反复 discovery → delete → discovery；每个 AWS 调用都受单命令上限和 cleanup 剩余时间共同约束。应用 route table 必须属于 exact VPC，且默认路由当前 target 必须等于唯一 full-tuple-owned NAT 才允许删除；缺失或 foreign target 保持不动并进入 `CLEANUP_BLOCKED`。任何一次 mutation/discovery 失败都会留下 sticky failure evidence；后续 retry 仍可清除资源，但本 operation 永远不得转为 PASS。
7. 至少连续三次资源残留为 0，且首尾不少于 180 秒后，先发布非终态 `CLEANUP_RESOURCES_STABLE_ZERO`，再删除 worker/state 参数并复查全部临时资源与参数路径。所有 final check 完成且路径只剩 control status 后，发布非终态 `CLEANUP_FINAL_CHECKS_PASS_CONTROL_DELETE_PENDING`；control status 的 exact CAS 删除确认成功后，才输出脱离 SSM 的 `CLEANUP_PASS` terminal evidence 和最终参数路径残留 0。任一 final check 失败时 control status 仍存在并发布 `CLEANUP_BLOCKED`。

| 证据字段 | 值 |
| --- | --- |
| GateStatus | `APPROVED_MIGRATION` |
| MigrationApprovalId | `FSK-MIGRATION-20260824-145858-JST` |
| FoundationCommit/Tag/RemoteBranch | `dcff57ebc9bc6d77fbb51072b996834f5a5ca715 / fsk-staging-data-api-foundation-v1 / staging` |
| TaskId | `migration-20260824` |
| OperationToken | `c4c4eb7f-5665-4039-975f-554f36a8fae0` |
| OperationDeadlineEpoch | `1787558338 / 2026-08-24 16:58:58 JST` |
| CleanupDeadlineEpoch | `1787561038 / 2026-08-24 17:43:58 JST` |
| TemporaryPublicCidr/Az | `10.42.4.0/24 / ap-northeast-1a` |
| ApplicationRouteTableIds | `rtb-0bbea56ee741ffe5f / rtb-0b08168b07de52b49` |
| ControlActor/WatchdogPid | `PENDING_MIGRATION` |
| WorkerEnvironmentId | `PENDING_MIGRATION` |
| TemporaryResourceIds | `PENDING_MIGRATION` |
| FirstMigrationResult | `PENDING_MIGRATION` |
| SecondMigrationNoOpResult | `PENDING_MIGRATION` |
| VerifySchemaResult | `PENDING_MIGRATION` |
| DatabaseUrlCleared | `PENDING_MIGRATION` |
| WorkerEnvironmentDeleted | `PENDING_MIGRATION` |
| StableZeroObservations/Duration | `PENDING_MIGRATION` |
| FinalResidualCount | `PENDING_MIGRATION` |
| CostOwner | `reiken` |
| CleanupOwner | `reiken` |

任何 cleanup 查询失败、未知 owner、deadline 超时或残留非零都写 `BLOCKED`，保留费用责任并停止 Full backend。Migration 已获得上述一次性批准；写入开始前仍须复验初始残留为 0，且当前尚未创建本次 Migration 临时资源。
