# FSK Amplify Gen 2 迁移设计书

## 1. 文档目的

本设计将现有 FSK 本地账务系统迁移为独立的 AWS Amplify Gen 2 Web App，同时先完成“网管餐费”数据契约，确保 SQLite 与目标 PostgreSQL 使用同一套最终字段和公式，避免迁移期间重复调整数据库和重复搬运数据。

本设计是总体架构基线，不把所有工作合并为一次发布。实施必须拆成可独立验证和回滚的阶段；第一份实施计划只覆盖网管餐费契约，后续 AWS 基础设施、业务迁移、PWA 和数据切换分别建立实施计划。

## 2. 已确认目标

- 新建独立的 FSK Amplify Gen 2 App，不复用现有其他项目的 Amplify App、Cognito User Pool、RDS 或 S3 Bucket。
- Vue 3 前端作为 PWA 部署到 Amplify Hosting。
- 身份认证迁移到 Amazon Cognito。
- 关系型业务数据迁移到 Amazon RDS for PostgreSQL，并通过 Amplify Data/AppSync 暴露受控接口。
- 附件从本地 `uploads/` 迁移到 Amplify Storage/S3。
- 统计、导出、账务事务、管理员修正和迁移编排使用 Amplify Functions、自定义 Query/Mutation 或受控 SQL Resolver。
- 现有 NestJS + SQLite 运行层在云端完成验收和切换后逐步退役，不采用长期双写。
- 保留既有固定四班、历史日报 ID、外键关系、金额、快照和附件。
- 支持 iPhone 16 Pro Max 当前最新 iOS，以及 iPhone 7 Plus iOS 15.8.4 的 Safari 和主屏幕 PWA 模式。

## 3. 当前系统基线

当前仓库是 pnpm workspace：

- `apps/api`：NestJS 10、Prisma、SQLite、JWT、bcrypt、本地 `uploads/`。
- `apps/web`：Vue 3、Vite、Element Plus、Pinia、vue-router，通过 axios 调用 REST API。
- 备份格式：`finance-system-backup-v1` ZIP，包含 `manifest.json`、`sqlite/app.sqlite` 和 `uploads/`。
- 当前恢复机制会断开 Prisma、替换正在使用的 SQLite 文件并覆盖本地附件目录；该机制不能直接沿用到 PostgreSQL/S3。
- 当前角色是 `ADMIN` 和 `WEBMASTER`；目标系统取消 `WEBMASTER`，只保留 `ADMIN` 和严格受限的 `KITCHEN`。
- 固定班次为 `网管早班(1) → 白班(2) → 夜班(3) → 网管夜班(4)`，夜班只承接同一业务日白班的结束时间。
- `DailyReport` 以 `[reportDate, shiftId]` 唯一，历史数据不能因迁移重建班次 ID 或改写快照。

## 4. 目标架构

### 4.1 资源边界

FSK 使用独立资源边界：

1. Amplify Hosting 托管 Vue/PWA 静态产物并提供 CDN、HTTPS、分支预览与原子发布。
2. Cognito User Pool 负责登录；Cognito Group 只承载 `ADMIN`、`KITCHEN` 两种角色。
3. Amplify Data/AppSync 提供类型化读取接口和自定义 Query/Mutation。
4. RDS PostgreSQL 保存账务主数据、日报、审计记录、导出任务和迁移状态。
5. Amplify Storage/S3 保存日报附件、导出文件和一次性迁移暂存文件。
6. Amplify Functions 负责服务器可信计算、事务写入、统计、导出、管理员修正和迁移任务。
7. CloudWatch 保存结构化日志和告警；日志不得记录密码、Cognito Token、数据库连接串或完整附件内容。

Amplify Data 是 PostgreSQL 的 API/连接层，不替代数据库实例。PostgreSQL 必须先作为独立 RDS 资源创建，再从实际数据库结构生成 Amplify SQL schema。生成的 `schema.sql.ts` 只由生成命令维护，不手工修改；授权规则、重命名和自定义接口在其外层组合。

### 4.2 环境与发布

- `main` 对应生产环境；非生产分支使用独立 Amplify backend branch/sandbox，不能连接生产数据库或生产 Bucket。
- 生产资源固定在 `ap-northeast-1`。
- 创建资源和日常部署不得使用 AWS root 用户；使用 IAM Identity Center 或受控管理员角色，并遵循最小权限。
- RDS 必须启用静态加密、TLS、删除保护、14 天自动备份和最终快照。
- RDS 实例规格与 Single-AZ/Multi-AZ 是成本审批项；在成本表获批前不得创建生产数据库。无论最终规格如何，不能降低前述加密、备份和删除保护要求。
- 初期用户和并发量很低，不默认创建 RDS Proxy；出现连接耗尽证据后再引入。
- Storage 设置 `keepOnDelete: true`，并启用 S3 Versioning；删除 Amplify App 不能自动删除正式附件。

## 5. 网管餐费数据契约

### 5.1 原始字段

`DailyReport` 新增两个服务器认可的原始金额字段：

| 字段 | 含义 | 规则 |
| --- | --- | --- |
| `staffMealCashYen` | 网管餐费现金 | 日元整数，`0..2_000_000_000`，默认 `0` |
| `staffMealAlipayYen` | 网管餐费支付宝 | 日元整数，`0..2_000_000_000`，默认 `0` |

金额继续使用“日元整数”，禁止浮点输入。旧日报迁移时两个字段统一回填为 `0`，不改变旧日报的其他金额。

### 5.2 派生值与公式

```text
cashDepositYen = cashTotalYen - registerFloatYen
staffMealTotalYen = staffMealCashYen + staffMealAlipayYen
totalSalesYen = newageYen + cashDepositYen - staffMealCashYen
deviationYen = totalSalesYen + expenseYen - imosSalesYen
```

规则解释：

- 网管餐费现金已经包含在钱箱实点现金中，因此仍进入 `cashDepositYen`。
- 网管餐费现金不是营业销售，所以计算 `totalSalesYen` 时只扣除 `staffMealCashYen`。
- 支付宝餐费单独保存，从未加入 `cashDepositYen` 或 `newageYen`，因此不再重复扣减。
- `expenseYen` 和网管餐费是两个独立业务概念，不合并字段。
- `staffMealTotalYen` 是派生值，不接受客户端直接提交；前端预览和后端都使用同一组测试向量，后端结果为最终权威。
- `cashDepositYen`、`totalSalesYen`、`deviationYen` 由服务器重新计算，不能相信客户端提交值。

### 5.3 展示、统计和导出

- 日报表单在“支出”区域下方显示“网管餐费”，包含现金和支付宝两个金额框。
- 日报确认页、管理员日报详情、Excel 和 PDF 同时显示现金、支付宝及合计。
- 后台统计分别汇总 `staffMealCashYen`、`staffMealAlipayYen`、`staffMealTotalYen`。
- “明细”定义为按业务日、班次、日报展示两种支付方式；当前范围不增加“每一顿饭一条记录”的子表。
- 实际销售统计只使用修订后的 `totalSalesYen`，不能把支付宝餐费或餐费合计加入营业销售。

## 6. 身份、角色和授权

### 6.1 Cognito 与应用用户

Cognito 保存认证身份；PostgreSQL `AppUser` 保存业务资料并映射：

- `id`：保留旧用户 ID；新用户使用字符串 ID。
- `cognitoSubject`：Cognito `sub`，唯一。
- `usernameSnapshot`：用于历史显示，不依赖 Cognito 后续改名。
- `role`：只允许 `ADMIN` 或 `KITCHEN`。
- `active`、`createdAt`、`updatedAt`。

现有 `ADMIN` 用户保持 `ADMIN`；所有现有 `WEBMASTER` 用户迁移时转换为 `KITCHEN`。转换必须保留旧用户 ID、用户名、创建时间和既有日报关联，目标系统不创建 `WEBMASTER` Cognito Group，也不保留 `WEBMASTER` 运行权限。

该角色转换发生在云迁移阶段。阶段 A 只完成网管餐费契约，不提前改动本地 JWT 角色，避免在 Cognito 切换前同时维护两套认证模型。

现有 bcrypt 使用 cost 10。目标 User Pool 若支持 Cognito 密码哈希导入，则直接导入 bcrypt 哈希，使转换后的 `KITCHEN` 用户继续使用原用户名和密码；导入前验证所有哈希格式和 cost。若目标 User Pool 不提供该能力，则保留用户名并要求首次重设密码。不得为了保留旧密码而长期保留 NestJS/SQLite 登录服务。

### 6.2 权限矩阵

| 能力 | `ADMIN` | `KITCHEN` |
| --- | :---: | :---: |
| 填写班次账务 | 是 | 是 |
| 查看历史账务 | 是 | 否 |
| 查看统计与导出 | 是 | 否 |
| 修改设置与主数据 | 是 | 否 |
| 修改已提交账务 | 是，必须写审计 | 否 |
| 删除已提交账务 | 否，采用更正记录 | 否 |

`KITCHEN` 的菜单和后端接口同时收口：

- 可以读取固定班次、有效负责人、底钱和完成表单所必需的最小上下文。
- 可以调用一次受控的 `submitKitchenDailyReport` Mutation。
- 不能调用日报列表、日报详情、统计、导出、用户管理和设置写接口。
- 输入上下文接口只能返回建议开始时间、前值、底钱和“该班次是否已提交”等必要值，不能返回历史日报内容或销售金额列表。
- 同一业务日、同一班次已存在日报时，提交接口返回冲突，不返回既有日报内容。

### 6.3 厨房提交锁定

- 厨房表单在提交前可以检查和修改；未提交草稿不作为云端日报。
- PWA 可以在本机保存尚未提交的临时草稿，但不得离线自动提交或在恢复联网后静默重放；登录用户变化、退出登录或提交成功时必须清除草稿。
- 成功提交后立即锁定；`KITCHEN` 不能重新打开、更新或删除。
- 数据库唯一约束 `[reportDate, shiftId]` 和事务写入共同防止重复提交。
- 客户端为每次提交生成 `idempotencyKey`；相同 Key 重试返回同一结果，不创建第二份日报。
- 管理员更正必须填写原因，并写入 `DailyReportRevision`：日报 ID、修改前快照、修改后快照、修改人 Cognito `sub`、用户名快照、原因和修改时间。
- 原提交人的 ID、用户名快照和提交时间永远保留，管理员修正不能覆盖原始提交者。

## 7. PostgreSQL 数据模型原则

目标 PostgreSQL 包含现有业务实体及下列扩展：

- `AppUser`：Cognito 与业务用户映射。
- `Shift`、`ResponsiblePerson`、`AppSettings`：保留现有 ID 和语义。
- `DailyReport`：保留现有字段、快照和唯一约束，增加两项网管餐费字段、原提交人和创建时间。
- `DailyReportRevision`：管理员更正审计。
- `Attachment`：日报 ID、S3 Object Key、原文件名、MIME、字节数、SHA-256、上传人和创建时间。
- `ExportJob`：导出类型、筛选条件、状态、S3 Key、失败原因、创建人和过期时间。
- `MigrationRun`：迁移版本、来源备份哈希、阶段、状态、计数、校验摘要和错误。
- `MigrationItem`：需要逐项幂等记录的附件或批次迁移结果。

数据库要求：

- 所有表有显式主键，确保 Amplify 能生成 SQL schema。
- `reportDate` 在 PostgreSQL 使用 `DATE`，客户端保持 `YYYY-MM-DD`；业务日和默认日期按 `Asia/Tokyo` 计算。
- 日报单项金额按整数保存；跨日报聚合在 PostgreSQL 使用 `BIGINT`，API 以十进制字符串或经过安全范围检查的数值返回，避免 GraphQL/JavaScript 整数溢出。
- 所有外键在导入完成后必须通过孤儿记录检查。
- schema 迁移必须纳入版本控制并由受控部署步骤执行；不能依靠 Amplify Data 自动创建或修改 PostgreSQL 表。

## 8. 数据访问与业务逻辑边界

### 8.1 Amplify Data 直接读取

下列只读能力可由 Amplify Data 的模型读取或受控 SQL Query 提供：

- 管理员日报列表与详情。
- 固定班次、负责人和设置读取。
- 管理员审计记录读取。

所有读取都必须配置 Cognito Group 授权，不能使用 public API key 或 guest access。

### 8.2 服务器可信写入

下列操作必须通过自定义 Mutation/Function 或事务 SQL Handler，不能开放通用客户端 CRUD：

- 厨房日报提交与幂等检查。
- 日报金额重新计算。
- 管理员补录和更正审计。
- 设置、负责人和用户状态变更。
- 附件确认与日报关联。
- 迁移、统计快照和导出任务。

Function 在事务中读取服务端底钱、验证班次/负责人/角色、计算派生金额并写入日报。客户端传入的 `createdByUserId`、角色、派生金额和审计人信息一律忽略，以 Cognito Claims 和数据库映射为准。

## 9. Storage、附件和导出

### 9.1 Storage 路径

建议路径：

```text
pending/{cognitoSubject}/{draftId}/{attachmentId}/{sanitizedFileName}
daily-reports/{reportId}/{attachmentId}/{sanitizedFileName}
exports/{cognitoSubject}/{exportJobId}/{fileName}
migration-staging/{migrationRunId}/source.zip
```

- `KITCHEN` 只可读写自己的 `pending/` 路径，不能直接写 `daily-reports/`。
- 日报提交事务确认成功后，由 Function 把临时对象复制到正式路径并删除临时对象；正式附件只允许管理员和获得明确授权的 Function 访问。
- `KITCHEN` 提交成功后失去对应附件的读取和删除能力。
- 管理员通过限时签名 URL 查看附件和下载导出。
- S3 Object Key 由服务器生成，不能直接使用客户端路径作为授权依据。
- 上传完成后 Function 校验大小、允许的 MIME、SHA-256 和日报关联，再把临时对象转为正式附件。

### 9.2 导出

- Excel 和 PDF 使用 `ExportJob` 异步生成并写入 S3，前端轮询任务状态后获取限时下载 URL。
- 导出必须包含网管餐费现金、支付宝、合计及修订后的实际销售。
- PDF 使用 Lambda 兼容的 Chromium Layer/容器依赖；若打包、内存或执行时间验收不通过，则改为生成可打印 HTML，而不是阻塞迁移主线。
- 过期导出通过 S3 Lifecycle 删除；日报原始附件不随导出过期。

## 10. SQLite、用户和 uploads 迁移

### 10.1 原则

- 迁移是一次性 ETL，不是把旧“替换 SQLite 文件”的恢复功能搬进 Lambda。
- 不长期双写 SQLite 和 PostgreSQL，避免形成两个账务权威源。
- 导入器必须幂等：相同来源备份 SHA-256 重跑不会重复创建记录或附件。
- 保留旧 ID、外键、业务日、班次快照、负责人快照、时间和金额；旧日报的网管餐费字段回填 `0`。
- 迁移前后都保留原 ZIP、SQLite 只读副本、RDS 快照和校验报告。

### 10.2 迁移流程

1. 在本地副本运行 SQLite 完整性检查和来源统计，生成不可变的迁移清单。
2. 将 `finance-system-backup-v1` ZIP 直接上传到 `migration-staging/`，不得把整包作为同步 Lambda 请求体。
3. 管理员启动 `MigrationRun`；Function 只接收 S3 Key、来源哈希和迁移版本。
4. 导入器读取 SQLite，按 `AppSettings → User → Shift → ResponsiblePerson → DailyReport → Attachment` 顺序写入。
5. 每批写入记录来源 ID和状态；失败批次可从检查点重试。
6. users 映射到 Cognito 和 `AppUser`；密码导入结果单独校验。
7. uploads 计算 SHA-256 后写入正式 Storage，并建立 `Attachment` 记录。
8. 运行数据库行数、主键、外键、唯一约束、金额汇总、附件数量/字节数/哈希校验。
9. 生成机器可读 JSON 和人工可读迁移报告；任何关键校验失败都不得切换生产入口。

Lambda 同步调用存在请求大小和最长执行时间限制，因此大文件上传走 S3，多批次迁移走异步任务。若一次完整迁移无法稳定在 Function 时限内完成，则使用 Step Functions 分批编排；不通过提高超时把整个迁移硬塞进一次调用。

### 10.3 验收校验

至少比较：

- 每张业务表总行数和主键集合。
- `[reportDate, shiftId]` 唯一组合数量。
- `cashTotalYen`、`expenseYen`、`totalSalesYen`、`cashDepositYen`、`deviationYen` 及两项餐费的分业务日汇总。
- 所有外键孤儿数必须为 `0`。
- uploads 文件数、总字节数和逐文件 SHA-256。
- Cognito/AppUser 用户数量、用户名和角色。
- 来源 `ADMIN` 必须逐个映射为目标 `ADMIN`，来源 `WEBMASTER` 必须逐个映射为目标 `KITCHEN`；目标角色集合中不能出现 `WEBMASTER`。
- 固定四班 ID、名称、顺序和 active 状态。

## 11. PWA 与移动端兼容

### 11.1 iOS 主屏幕独立模式

iPhone 7 Plus 的 iOS 15.8.4 支持从 Safari 的分享菜单选择“添加到主屏幕”。从主屏幕图标启动后，FSK 必须以独立 Web App 运行，不显示 Safari 地址栏和底部工具栏，也不能表现为只会跳回 Safari 的网页书签。

实现必须同时提供标准 Web App Manifest 和 iOS 兼容标签：

```json
{
  "name": "FSK 班次账务",
  "short_name": "FSK 账务",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#ffffff"
}
```

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="FSK 账务">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

- `display: "standalone"` 和 `apple-mobile-web-app-capable=yes` 共同保证主屏幕启动时隐藏 Safari 浏览器 UI。
- 使用 `black-translucent` 时页面必须通过 `env(safe-area-inset-top)`、`env(safe-area-inset-bottom)` 避让状态栏和 Home Indicator。
- iOS 系统状态栏仍可能显示，Web App 不能承诺像原生沉浸式应用一样强制隐藏所有系统 UI；本项目的“全屏”验收定义是“不显示 Safari 地址栏和底部工具栏”。
- iOS 15.8.4 必须使用 Safari 执行“添加到主屏幕”；不能把第三方浏览器安装作为该设备的验收路径。
- 提供专用 `apple-touch-icon.png`，并同时在 Manifest 中声明图标；iOS 15.8.4 优先验证 Apple Touch Icon 的实际显示效果。
- 首次从主屏幕图标启动时按独立应用会话处理，必须验证 Cognito 登录、Token 持久化和退出登录，不能假定 Safari 标签页中的登录状态自动复用。
- 应用启动后使用 `window.navigator.standalone === true` 或 `window.matchMedia('(display-mode: standalone)').matches` 做诊断提示；该检测只用于提示安装状态，不能改变授权逻辑。

### 11.2 缓存与旧设备兼容

- PWA 提供 manifest、Apple Touch Icon、standalone 显示、Safe Area 和 `viewport-fit=cover`。
- Service Worker 只缓存带哈希的静态资源和离线壳；Cognito、AppSync、Storage、统计和账务提交全部 network-only。
- 不实现离线账务队列，不在恢复联网后自动提交。
- 固定 Amplify JS、Vue、Vite 和 PWA 依赖版本；升级必须重新执行 iOS 15.8.4 实机回归。
- 若 Amplify JS 或浏览器 API 在 iOS 15.8.4 缺失能力，使用局部 polyfill 或锁定已验证版本，不以“桌面 Safari 正常”替代旧 iPhone 验收。
- 金额框使用适合 iOS 的数字键盘提示，但仍由应用解析并验证日元整数。
- 所有主要操作按钮满足触控尺寸、安全区和软键盘弹出后的可见性要求。

实体设备验收矩阵：

| 设备 | 系统 | 浏览器模式 | 必测流程 |
| --- | --- | --- | --- |
| iPhone 16 Pro Max | 当前最新 iOS | Safari、主屏幕独立模式 | 安装图标、无 Safari UI、登录、完整日报、附件、提交锁定、管理员统计/导出 |
| iPhone 7 Plus | iOS 15.8.4 | Safari 安装、主屏幕独立模式 | 安装图标、无 Safari UI、独立会话登录、金额输入、滚动/键盘、安全区、附件、重复提交、Token 过期 |

## 12. 错误处理与可观测性

- 业务冲突使用稳定错误码，例如 `REPORT_ALREADY_SUBMITTED`、`REPORT_LOCKED`、`ROLE_FORBIDDEN`、`IDEMPOTENCY_CONFLICT`。
- 客户端只显示可操作的中文/日文业务提示，不暴露 SQL、S3 Key、堆栈和内部 ARN。
- Function 日志包含 request ID、actor `sub`、操作名、日报 ID和结果，但对金额之外的敏感输入做最小化记录。
- 迁移和导出任务保存明确状态：`queued`、`running`、`succeeded`、`failed`；失败保存受控错误摘要并允许管理员重试。
- CloudWatch 对 Function 错误率、迁移失败、导出失败、Cognito 登录异常和 RDS 存储/连接设置告警。

## 13. 切换、回滚和退役

### 13.1 切换前门槛

- 网管餐费契约已在当前 SQLite 版本通过 API/Web 测试和人工验收。
- AWS staging 环境端到端流程通过。
- 至少完成一次生产数据副本 dry-run，迁移校验全部通过。
- 两台目标 iPhone 完成实机验收。
- Cognito 用户已完成导入或重设密码演练。
- RDS 快照、原 SQLite ZIP和 uploads 备份已生成并验证可读。

### 13.2 正式切换

1. 宣布维护窗口并阻止本地系统新增/修改日报。
2. 生成最终 ZIP和来源 SHA-256。
3. 执行最终导入和全量校验。
4. 用管理员和厨房实体手机做登录、提交、锁定、统计和附件抽查。
5. 仅在全部门槛通过后发布生产入口。
6. 旧 NestJS/SQLite 保持只读，不接受新写入。

### 13.3 回滚

- 生产入口切换前校验失败：保持本地系统为权威源，修复迁移程序后从新 MigrationRun 重做。
- 切换后出现阻断性故障：暂停云端写入，导出切换后新增记录清单，恢复本地写入前由管理员逐笔确认回放方案；禁止直接丢弃云端已提交账务。
- 回滚完成后重新比较两侧记录和金额，形成独立校验报告。
- NestJS 只在稳定观察期后退役；退役不删除原始 SQLite、最终 ZIP、迁移报告或 RDS/S3 备份。

## 14. 测试策略

### 14.1 网管餐费契约

- API 公式单元测试：现金餐费扣除、支付宝不进入实际销售、两项默认 `0`、边界和非法金额。
- Web 公式与表单测试：输入、预览、提交 DTO、确认页和旧日报兼容。
- API 服务测试：服务端覆盖客户端伪造派生金额。
- 统计和 Excel/PDF 输出测试：现金、支付宝、合计和实际销售一致。

### 14.2 云端授权与事务

- Cognito Group授权测试覆盖所有允许/拒绝组合。
- 验证目标 Cognito 和 PostgreSQL 只接受 `ADMIN`、`KITCHEN`，并拒绝创建或授权 `WEBMASTER`。
- `KITCHEN` 无法调用列表、详情、统计、导出和设置接口。
- 厨房首次提交成功、重复提交冲突、相同幂等 Key 重试返回同一结果、提交后修改被拒绝。
- 管理员更正产生完整 `DailyReportRevision`，原提交者不变。

### 14.3 迁移

- 使用脱敏 SQLite fixture 测试 ID/外键/金额/附件迁移。
- 同一备份连续运行两次，第二次不能增加任何业务记录或附件。
- 注入中途失败并从检查点恢复。
- 对真实备份副本执行 dry-run 和独立校验脚本。

### 14.4 项目级验证

- 当前阶段继续运行 API Vitest、Web Vitest、API/Web strict typecheck和两端 build。
- Amplify 阶段增加 sandbox/staging 部署验证、授权集成测试和浏览器 E2E。
- 两台 iPhone 均从主屏幕图标冷启动，确认 `navigator.standalone === true` 或 `window.matchMedia('(display-mode: standalone)').matches === true`，且画面没有 Safari 地址栏和底部工具栏。
- iPhone 7 Plus 必须通过 Safari 分享菜单安装，并验证独立会话登录、退出后 Token 清除、重新启动和版本更新后的缓存刷新。
- 完成两台实体 iPhone 验收后才能切换生产。

## 15. 分阶段交付

### 阶段 A：网管餐费数据契约

在现有 NestJS/SQLite/Vue 中新增最终字段、公式、统计、详情、导出和测试。该阶段不创建 AWS 资源，不改变认证和部署方式。完成后 PostgreSQL 直接按最终契约建表。

### 阶段 B：Amplify Gen 2 基础设施

创建独立 Amplify App、Cognito、RDS PostgreSQL、Amplify Data、Storage、Functions 基础、staging/production 环境与安全配置。此阶段不迁移生产数据。

### 阶段 C：云端账务与权限

实现 Cognito 角色、服务器可信日报 Mutation、提交锁定、审计、统计和导出，使用测试数据完成集成验证。

### 阶段 D：Vue/PWA 迁移

将 axios/JWT/本地 uploads 调用替换为 Amplify Auth/Data/Storage，加入 PWA、旧 iOS 兼容和 `KITCHEN` 专用导航。

### 阶段 E：数据迁移与生产切换

完成 SQLite/users/uploads 导入器、dry-run、校验、维护窗口、最终切换和回滚演练。

### 阶段 F：NestJS 退役

观察期内保持旧系统只读；确认云端稳定、备份和恢复流程可用后，停止 NestJS 运行服务。仓库内迁移工具和历史备份说明保留，运行时依赖再按单独计划清理。

每个阶段必须有独立实施计划、测试证据和继续/停止门槛。阶段 A 完成前不能建立生产 PostgreSQL 最终表；阶段 E 验收完成前不能停止本地写入层；阶段 F 完成前不能删除任何回滚数据。

## 16. 明确不在当前范围

- 不开发原生 iOS App。
- 不实现离线账务同步或多端冲突合并。
- 不把网管餐费扩展为逐人、逐餐明细子系统。
- 不长期运行 SQLite/PostgreSQL 双写。
- 不复用其他项目的 Amplify、Cognito、RDS 或 S3 资源。
- 不在本设计阶段创建 AWS 资源、部署生产或改动业务代码。
- 不在总体设计书中锁定 RDS 计费规格；该规格必须通过阶段 B 的成本表审批。

## 17. 参考资料

- Amplify Gen 2 连接 PostgreSQL：<https://docs.amplify.aws/react/build-a-backend/data/connect-to-existing-data-sources/connect-postgres-mysql-database/>
- Amplify Data 自定义业务逻辑：<https://docs.amplify.aws/vue/build-a-backend/data/custom-business-logic/>
- Amplify Storage：<https://docs.amplify.aws/vue/build-a-backend/storage/set-up-storage/>
- Cognito 用户导入：<https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-using-import-tool.html>
- Lambda 配额：<https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html>
- RDS 自动备份保留：<https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html>
- Amplify Hosting：<https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html>
- AWS root 用户最佳实践：<https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html>
- Apple Safari Web Content Guide，主屏幕独立模式：<https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html>
- Apple Safari HTML Reference，iOS Web App Meta Tags：<https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html>
- WebKit，iOS 主屏幕 Web App 与 Manifest：<https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>
