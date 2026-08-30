# 财务统计系统 / Finance System

> **东京时区**业务日、班次账务、老板统计与 CSV 导出。
> **目标交付方式**：独立 FSK Amplify Gen 2 WebApp（Hosting + Cognito + AppSync/DynamoDB + S3）。

> **当前状态（2026-08-25）**：新架构已在本地实现和测试，但尚未取得 Gate A 部署批准，未创建/部署新的独立 Amplify App，也未迁移真实 SQLite、用户或 uploads。当前分支只保留 legacy API、SQLite/Prisma 数据契约和迁移工具作为迁移源；当前 `apps/web` 已改为 Amplify Web，不能作为旧 UI 回退。完整旧系统回退必须使用迁移前 recovery ref/checkout 与已备份的旧运行环境。

---

## 目录

1. [概述](#overview)
2. [技术栈与仓库结构](#repo-layout)
3. [先决条件](#prerequisites)
4. [前台机源码运行](#quickstart)
5. [生产环境与安全](#production)
6. [GitHub Releases](#releases)
7. [相关文档](#docs)
8. [许可证](#license)

---

<a id="overview"></a>

## 1. 概述

| 维度 | 说明 |
|------|------|
| **用途** | 厨房班次账务录入；老板历史、更正、统计、设置与 CSV 导出 |
| **固定班次** | 网管早班 → 白班 → 夜班 → 网管夜班；仅夜班默认承接同一业务日白班结束时间 |
| **目标生产架构** | 独立 FSK Amplify Hosting、Cognito、Amplify Data/AppSync/DynamoDB、Storage/S3、Kitchen Context Function |
| **当前生产状态** | `NOT_DEPLOYED`；Gate A 前只有本地实现与合成测试证据 |
| **legacy 恢复入口** | 不在当前分支提供；须从迁移前 recovery ref/checkout 启动旧 UI + API |

---

<a id="repo-layout"></a>

## 2. 技术栈与仓库结构

| 技术 | 说明 |
|------|------|
| 活动目标后端 | **Amplify Gen 2**、Cognito、AppSync、DynamoDB On-Demand/PITR、S3、最小 Function |
| Web/PWA | **Vue 3**、Vite、Element Plus、Pinia、Vue Router、Amplify Hosting |
| legacy migration source | **NestJS 10**、Prisma、SQLite、JWT；切换前保留，切换后只读，Gate C 前不删除 |

### Monorepo 路径

| 路径 | 说明 |
|------|------|
| [`amplify`](./amplify) | Cognito、Data/AppSync/DynamoDB、Storage、Function 与合成契约 |
| [`packages/domain`](./packages/domain) | 新 Web、统计、CSV、迁移共用的账务计算事实来源 |
| [`apps/web`](./apps/web) | OWNER/KITCHEN WebApp 与 standalone PWA |
| [`apps/api`](./apps/api) | legacy REST/SQLite 运行层及一次性迁移工具；不是目标生产 API |
| [`docs`](./docs) | 实施计划、备份说明、发版与索引 |
| [`AGENTS.md`](./AGENTS.md) | 协作者与 AI 助手约定（Prisma、代码风格等） |

---

<a id="prerequisites"></a>

## 3. 先决条件

在**仓库根目录**操作前请安装：

| 依赖 | 版本 |
|------|------|
| [Node.js](https://nodejs.org/) | **20+**（推荐 **22**） |
| [pnpm](https://pnpm.io/) | **9**（仓库 [`package.json`](./package.json) 已声明 `packageManager`；可用 [Corepack](https://nodejs.org/api/corepack.html) 对齐） |

---

<a id="quickstart"></a>

## 4. legacy 本地运行与新 Web 构建

### 新 Amplify WebApp（本地验证）

新 Web 启动前必须由 Amplify CLI 为当前 sandbox/branch 生成 `apps/web/public/amplify_outputs.json`；该文件被 Git ignore，禁止手工伪造或提交。未配置真实 outputs 时，应用会 fail closed，而不是回退到 legacy API。

```bash
pnpm install --frozen-lockfile
pnpm run check:all
pnpm run build:web
```

生产 Hosting 使用根目录 [`amplify.yml`](./amplify.yml)，部署、真实数据切换和旧系统退役分别遵循 Gate A/B/C：

- [`docs/aws/dynamodb-deployment-runbook.md`](./docs/aws/dynamodb-deployment-runbook.md)
- [`docs/aws/dynamodb-cutover-runbook.md`](./docs/aws/dynamodb-cutover-runbook.md)
- [`docs/aws/dynamodb-retirement-runbook.md`](./docs/aws/dynamodb-retirement-runbook.md)

### legacy NestJS/SQLite（迁移源与恢复边界）

当前分支保留 `apps/api`、Prisma schema、SQLite 读取能力及一次性迁移工具，供盘点、只读 dry-run 和 Gate B 迁移使用。当前 `apps/web` 已只通过 Amplify repositories 访问数据，因此在当前分支执行 `pnpm run dev` 或 `build + start/preview`，都不能还原旧 UI + NestJS 的完整账务系统。

需要完整旧系统回退时，必须同时具备：

1. 经复审的迁移前 commit/tag/recovery ref，并从该 ref 建立独立 checkout；
2. 与该版本匹配的 `dev.db`、`uploads`、环境变量和 Node/pnpm 运行环境备份；
3. 按该 recovery ref 自带的运行说明启动旧 Vue REST UI 与 NestJS API。

不要在唯一的真实 SQLite 或 uploads 副本上执行 `db:push`、覆盖恢复或试运行。当前分支的 legacy 代码保留并不等于可启动的旧 UI 恢复点，也不能替代 Gate A/B 批准。

### 常用脚本

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 开发时并行启动保留的 API 与当前 Amplify Web；不是旧系统回退 |
| `pnpm run dev:api` / `pnpm run dev:web` | 分别启动保留的 API / 当前 Amplify Web 开发服务 |
| `pnpm run build` | 构建 API + Web（`dist`） |
| `pnpm run db:push` | 将 Prisma schema 同步到 SQLite |
| `pnpm run db:generate` | 生成 Prisma Client（`schema.prisma` 变更后必跑） |

```bash
pnpm run db:generate
```

**说明**：根目录 `pnpm install` 会触发 `apps/api` 的 `postinstall`（含 `prisma generate`）。若 IDE 仍报模型缺字段，可尝试 **TypeScript: Restart TS Server** 或重载窗口。API 包为 **`strict: true`**，详见 [`apps/api/README.md`](./apps/api/README.md)。

**数据备份（管理员）**：ZIP 导出 / 导入见 **[`docs/data-backup-restore.md`](./docs/data-backup-restore.md)**（界面：**バックアップ・リストア**）。

**编辑器（可选）**：维护 `apps/web` 建议安装 [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar)（Volar）。若在线安装失败，可下载 **`.vsix`** 后使用 **Install from VSIX**。

### Windows：历史开发快捷脚本

仓库内脚本会打开控制台运行当前分支的 `pnpm run dev` 并访问本地 Vite；它只用于开发检查，不能启动旧 UI 回退：

| 文件 | 说明 |
|------|------|
| [`scripts/windows/start-finance-system-dev.bat`](./scripts/windows/start-finance-system-dev.bat) | 自动 `cd` 到仓库根 → `start cmd /k pnpm run dev` → 约 8 秒后打开 `http://127.0.0.1:5173/` |

完整旧系统恢复必须先切换到含旧 Vue REST UI 的迁移前 recovery checkout，再使用该版本的启动脚本和备份环境；不得把当前脚本建立为生产或灾备快捷方式。

---

<a id="production"></a>

## 5. 生产环境与安全

### Amplify Data / DynamoDB 目标架构

| 检查项 | 说明 |
|--------|------|
| **独立 FSK App** | App/Auth/AppSync/tables/bucket/stacks/outputs 必须与 GameList 零复用、零 ARN 交集 |
| **角色** | Cognito 只允许 `OWNER` / `KITCHEN`；厨房后端权限只读安全上下文并 create 日报/本人 submission 附件 |
| **数据保护** | 每张 DynamoDB 表为 On-Demand + PITR；S3 versioning、SSE-S3、public access block |
| **运行配置** | `amplify_outputs.json` 只能由目标 branch 的 CLI 生成；manifest/outputs 禁止被 SPA rewrite 成 HTML |
| **审批门** | Gate A 合成部署、Gate B 真实迁移/冻结、Gate C 退役互不替代 |

### legacy NestJS/SQLite（仅过渡期）

| 检查项 | 说明 |
|--------|------|
| **`JWT_SECRET`** | 强随机；`NODE_ENV=production` 且未设置时 API **拒绝启动** |
| **`CORS_ORIGINS`** | 前后端不同域时配置（逗号分隔 Origin） |
| **Prisma** | `schema` 变更后对实际 **`DATABASE_URL`** 执行 `db:push` 或 migrate，并 **`db:generate`** |
| **`/setup/bootstrap`** | 完成后再次调用返回 **403**；公网建议限制 `/setup` |
| **`/uploads/`** | 当前为可猜测 URL；高敏感场景需鉴权或签名 URL（未改实现，仅提示） |

---

<a id="releases"></a>

## 6. GitHub Releases

- 每个 Release 附带的 **Source code (zip/tar.gz)** 为**源码快照**，可按 [§4](#quickstart) 部署。
- 推送 **`v*`** 标签后，可在 Release 页面附带版本说明与源码快照；变更记录见 **[`CHANGELOG.md`](./CHANGELOG.md)**，发布约定见 **[`RELEASING.md`](./RELEASING.md)**。

---

<a id="docs"></a>

## 7. 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/README.md`](./docs/README.md) | 文档索引 |
| [`RELEASING.md`](./RELEASING.md) | 发版与 Release 说明 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 版本变更 |
| [`docs/data-backup-restore.md`](./docs/data-backup-restore.md) | 管理员 ZIP 备份 / 恢复 |
| [`docs/aws/dynamodb-deployment-runbook.md`](./docs/aws/dynamodb-deployment-runbook.md) | 独立 FSK App、Hosting 与 Gate A 合成验收 |
| [`docs/aws/dynamodb-cutover-runbook.md`](./docs/aws/dynamodb-cutover-runbook.md) | Gate B 真实数据盘点、冻结、导入、核对和回退 |
| [`docs/aws/dynamodb-retirement-runbook.md`](./docs/aws/dynamodb-retirement-runbook.md) | Gate C 旧运行层/Foundation 精确退役 |
| [`docs/实施计划-财务统计系统.md`](./docs/实施计划-财务统计系统.md) | 业务与实施计划 |

---

<a id="license"></a>

## 8. 许可证

私有项目或未声明许可证时，默认保留所有权利；若需开源请自行补充 `LICENSE` 并更新本说明。
