# FSK Amplify Data / DynamoDB 架构设计

日期：2026-08-24  
状态：已确认，待编写实施计划

## 1. 决策摘要

FSK 改为独立的 Amplify Gen 2 全栈 WebApp：Vue/PWA 使用 Amplify Hosting，认证使用 Cognito，业务数据使用 Amplify Data（AppSync + DynamoDB），文件使用 Amplify Storage/S3，只有导出等确有必要的特殊逻辑使用 Amplify Functions。

不再把 PostgreSQL、Aurora、NestJS、Prisma migration、NAT 或 VPC 数据库访问作为目标架构。现有 PostgreSQL/Data API 设计文档保留为历史记录；与本设计冲突时，以本设计为准。

本系统不要求离线填报。网络不可用时保留当前页面输入，但不在设备上建立离线队列，也不后台自动重传。

## 2. 系统边界与隔离

新建独立 FSK Amplify Gen 2 App，不复用 GameList 的任何后端资源。FSK 与 GameList 可以位于同一 AWS 账号和东京区域，但必须分别拥有独立的：

- Amplify App 和 Hosting 部署；
- Cognito User Pool 和用户组；
- AppSync API；
- DynamoDB 表；
- Storage/S3 bucket；
- CloudFormation/CDK stacks；
- `amplify_outputs.json`。

两者只共享 AWS 账号总账单和账号级服务配额。FSK 所有可标记资源使用 `Project=FSK`、`Environment=production`；不得授予 FSK 身份访问 GameList ARN，反之亦然。

FSK 内部不为厨房单独建立数据库。老板和厨房访问同一套 FSK 数据表，由 Cognito 用户组和 Amplify Data 授权规则隔离操作权限。

## 3. 目标组件

| 组件 | 服务 | 职责 |
| --- | --- | --- |
| Web/PWA | Vue 3 + Amplify Hosting | 老板后台、厨房填报、主屏幕 WebApp |
| Auth | Cognito | 登录、`OWNER` / `KITCHEN` 用户组 |
| API/Data | Amplify Data + AppSync + DynamoDB | 类型安全 API、账务持久化、授权 |
| Files | Amplify Storage/S3 | 历史 uploads、未来账务附件 |
| Special logic | Amplify Functions | 仅在 Excel/PDF 导出等客户端不适合的场景使用 |

第一版不启用 AppSync 实时订阅、DynamoDB Streams、定时任务、离线同步或预计算汇总表。

## 4. 身份与授权

Cognito 只建立两个业务组：

- `OWNER`：老板账号；
- `KITCHEN`：厨房设备账号。

不建立 `webmaster` 角色。旧 bcrypt 密码不迁移；上线时创建新的 Cognito 用户并设置临时密码。

授权遵循 deny-by-default，并在后端规则中执行，不能只隐藏前端菜单。

| 数据或能力 | OWNER | KITCHEN |
| --- | --- | --- |
| 创建班次账务 | 允许 | 允许 |
| 查询班次账务 | 允许 | 禁止 |
| 修改/删除班次账务 | 允许 | 禁止 |
| 查询历史和统计 | 允许 | 禁止 |
| ShiftDefinition | 增删改查 | 只读填报所需字段 |
| AppSetting | 增删改查 | 禁止 |
| 导出 | 允许 | 禁止 |
| 附件 | 读写 | 仅写入当前提交路径，不允许列表或历史读取 |

厨房的创建权限使用只允许 `create` 的 owner 规则，使 Amplify 从 Cognito 身份写入记录 owner；`submittedBy` 不接受客户端自报值作为审计依据。厨房提交成功页只使用本次 create 响应展示摘要，不再发起历史查询。账务填错后由老板修正。

## 5. 数据模型

### 5.1 DailyReport

`DailyReport` 表示一个营业日的一个班次账务。使用 `businessDate + shiftId` 作为复合标识符，保证同一营业日、同一班次只能创建一条记录。

字段包含：

- `businessDate`：东京营业日，格式 `YYYY-MM-DD`；
- `shiftId`：班次标识；
- 由 Cognito/Amplify 写入的 owner，以及 `submittedAt`；
- 当前 SQLite/NestJS 数据契约中的全部原始营业额、现金、支付宝和支出字段；
- `staffMealCashYen`；
- `staffMealAlipayYen`；
- 备注；
- 附件 key 数组；
- Amplify 自动维护的 `createdAt`、`updatedAt`。

所有金额均为整数日元。派生合计不作为厨房可提交的权威字段；确认页、老板统计和导出统一通过共享业务计算模块从原始字段计算。

按营业日建立 secondary index。老板查询期间统计时按日期逐日查询，避免全表 scan；当前每天只有约两条记录，无需建立汇总表。

### 5.2 ShiftDefinition

字段包含班次 ID、名称、排序和启用状态。老板可维护；厨房只能读取填表所需的班次列表，不能访问设置页面。

### 5.3 AppSetting

保存店铺和账务设置。仅 `OWNER` 可读写。第一版只迁移现有系统真正使用的设置，不引入通用配置平台。

## 6. 账务规则

网管餐费遵循以下唯一规则：

- `staffMealCashYen` 计入现金入金金额；
- `staffMealCashYen` 不计入实际売上；
- `staffMealAlipayYen` 不计入实际売上；
- 支付宝餐费独立保存；
- 日报、期间统计、班次统计和明细分别展示两种餐费。

共享计算模块是确认页、老板后台、导出和迁移校验的共同事实来源，禁止各页面复制公式。

## 7. 提交流程与错误处理

1. 厨房登录后只进入填报流程。
2. 客户端校验必填项、非负整数金额和营业日/班次。
3. 点击提交后立即锁定按钮，直到请求结束。
4. 创建 `businessDate + shiftId` 对应的 `DailyReport`。
5. 成功时展示本次请求返回的确认摘要。
6. 明确失败时保留页面输入，允许人工重试。
7. 如果响应丢失但写入成功，重试会得到重复标识符冲突；页面显示“可能已经提交，请老板确认”，不得覆盖原记录。

不提供离线保存、后台重传或自动合并。网络中断期间刷新/关闭页面可能丢失尚未提交的输入，这是已接受的产品边界。

## 8. 统计与导出

老板端按营业日查询 `DailyReport`，在客户端使用共享计算模块生成日报、期间总计和按班次统计。由于每天约两条记录，第一版无需统计表、Streams 或定时聚合。

普通 CSV 可在浏览器生成。只有 Excel/PDF 或需要受控文件生成时才增加单个 Function；Function 使用同一业务计算模块，并仅允许 `OWNER` 调用。

## 9. Storage

现有 uploads 迁移到 FSK 独立 Storage/S3 bucket，迁移时保存对象 key、大小和校验值。Storage 规则按用户组和路径明确授权，默认拒绝未声明访问。

S3 开启 versioning。厨房若需要上传附件，只能写入 `submissions/{identity_id}/*`，且只授予 write，不授予 list/read/delete；账务记录保存返回的对象 key。老板可管理全部 FSK 附件。

## 10. PWA 与设备支持

WebApp 使用：

- `manifest.json`；
- `display: "standalone"`；
- `apple-mobile-web-app-capable`；
- Apple 主屏幕图标和状态栏声明；
- HTTPS Amplify Hosting。

不增加离线 Service Worker 账务缓存。目标设备为 iPhone 16 Pro Max 当前系统和 iPhone 7 Plus / iOS 15.8.4；两台设备均需在添加到主屏幕后以 standalone 模式打开。

## 11. 数据迁移与切换

迁移采用“并行建设、一次切换”，禁止新旧系统长期双写。

1. 部署独立 FSK Amplify App，并只用合成数据验证。
2. 建立 `OWNER` 和 `KITCHEN` Cognito 用户。
3. 对 SQLite、uploads、班次和设置做只读盘点及备份。
4. 运行导入 dry-run，生成记录数、金额汇总、附件数量和冲突报告。
5. 在正式切换窗口暂停旧系统写入，制作最终 SQLite/uploads 副本。
6. 按班次、设置、历史账务、附件顺序执行幂等导入。
7. 独立核对记录数量、每日金额、网管餐费两类合计和附件校验值。
8. 完成权限负向测试和两台 iPhone 验收。
9. 新系统正式启用，旧系统改为只读。

导入使用确定性标识符；同一输入重复执行不得生成重复账务。导入过程不迁移 bcrypt hash，也不修改 GameList 资源。

切换应安排在下一班次提交之前。如果首笔新账务前验收失败，可直接恢复旧系统写入；首笔新账务后不得直接恢复双写，必须先导出新记录并进行受控对账。

## 12. 备份、退役和成本

DynamoDB 表启用 PITR，S3 启用 versioning；原始 SQLite 和 uploads 备份不因上线立即删除。

目标架构不创建 Aurora、NAT、VPC 数据库网络或常驻服务器。DynamoDB 使用 On-Demand，AppSync 和 Hosting 按使用量计费。实际费用以 AWS Cost Explorer 为准。

现有 Aurora/PostgreSQL Foundation 与失败 migration 记录属于旧方案。只有在 DynamoDB 系统导入、统计、权限和设备验收全部通过后，才可通过单独批准删除旧 Foundation；新系统部署不隐含删除权限。

## 13. 测试与验收

### 自动化测试

- 共享账务计算单元测试；
- 网管餐费现金/支付宝规则测试；
- 确认页、统计和导出一致性测试；
- `businessDate + shiftId` 重复提交测试；
- `OWNER` 正向权限测试；
- `KITCHEN` 创建正向测试，以及历史、统计、设置、修改和删除的负向测试；
- SQLite 转换、幂等导入和金额汇总测试；
- manifest 和 Apple PWA metadata 测试。

### 上线验收

- 厨房可登录、填写和提交，但无法查看历史、统计和设置；
- 老板可查看、修改、统计和导出；
- 网管餐费计算符合第 6 节；
- 同一营业日和班次不能产生重复记录；
- 导入前后记录数、金额和附件校验一致；
- 两台目标 iPhone 主屏幕 standalone 运行通过；
- 旧系统只读且没有双写；
- FSK 与 GameList 的 Auth、Data、Storage 和 Hosting 资源相互隔离；
- 旧 Foundation 删除后，FSK 不再保留 Aurora、NAT 或长期服务器资源。

## 14. 明确不在第一版范围

- 离线填报和后台同步；
- 多店铺、多厨房账号或细粒度员工管理；
- 实时订阅；
- 预计算统计表；
- 通用工作流、审批流或消息通知；
- 自动删除旧 Aurora；
- GameList 资源或数据迁移。
