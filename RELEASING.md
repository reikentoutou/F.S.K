# 发布说明（Releases）

## 当前发布状态

目标生产交付是独立 FSK Amplify Gen 2 WebApp。当前新架构只在本地实现/验证，`Gate A = NOT_APPROVED`、Hosting `NOT_DEPLOYED`，没有真实 SQLite/users/uploads 迁移，也没有冻结或删除旧系统。

发布状态分开记录，不得把其中一步表述为全部完成：

1. 本地 commit 与测试；
2. feature branch/tag/remote 发布；
3. Gate A：独立 FSK backend + Hosting + 合成验收；
4. Gate B：最终副本、真实数据导入、权限/两机验收和切换；
5. Gate C：观察期后的旧运行层/Foundation 精确退役。

对应手册为 [`dynamodb-deployment-runbook.md`](./docs/aws/dynamodb-deployment-runbook.md)、[`dynamodb-cutover-runbook.md`](./docs/aws/dynamodb-cutover-runbook.md) 和 [`dynamodb-retirement-runbook.md`](./docs/aws/dynamodb-retirement-runbook.md)。三个 Gate 都需要新的明确 ApprovalId，互不继承。

## legacy 源码交付

NestJS/SQLite 仍是迁移源和本地回退。在 Gate B 切换完成前，前台机可获取仓库源码，执行 **`pnpm install`**、配置 **`apps/api/.env`**、运行 **`pnpm run db:push`**，再通过 **`pnpm run dev`** 或 `build + start/preview` 启动。Gate B 后旧系统只读保留，Gate C 前不得删除其代码、数据库和 uploads 备份。

对应运行说明见根 **[README.md](./README.md)**，版本变更见 **[CHANGELOG.md](./CHANGELOG.md)**。

## GitHub Release 约定

- GitHub Release 中的 **Source code (zip/tar.gz)** 是当前标签对应的**源码快照**。
- 若团队为某个版本创建 Release，应确保 **`CHANGELOG.md`** 已同步更新。
- 当前仓库不再维护 Electron / Windows `.exe` 安装包发布链路。

## 发布前检查清单

1. 确认 worktree 只包含本次范围，未跟踪 `amplify_outputs.json`、真实数据库/uploads、凭据、Graphify 或临时迁移报告。
2. 运行 `pnpm install --frozen-lockfile`、`pnpm run check:all`、Web build、Amplify synth/contract tests 与 `git diff --check`。
3. 更新根目录 **`CHANGELOG.md`**，整理本次版本说明；明确“本地完成 / 已部署 / 已迁移 / 已退役”中的实际状态。
4. 提交并推送代码，然后创建并推送版本标签：

```bash
git add CHANGELOG.md
git commit -m "chore: release v0.0.2"
git push

git tag -a v0.0.2 -m "v0.0.2"
git push origin v0.0.2
```

## 下载说明

Release 的 **Source code** 只是源码快照，不会自动创建 Amplify 资源、生成目标环境 outputs、导入真实数据或授权退役。生产部署必须从经复审的精确 commit/tag 进入对应审批门；不要将 Release 视作已上线证明或预编译桌面安装包。
