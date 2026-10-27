# KITVAULT 功能移植与双店协同实施方案

> 2026-10-24 起草，**2026-10-26 全部阶段实施完成**（阶段 0/1/2/3/4/5/6/7/S，226 项测试 222 通过 0 失败）。各阶段实现要点与本文档规划一致；差异：免费翻译源（Google gtx/Lingva）默认关闭需在后台一键开启（避免非官方端点影响既有接力链），其余按方案落地。目标：把 `D:\独立站`（KITVAULT/JERSEYDOCK）项目中已验证的功能按本项目的技术路线（Node HTTP + SQLite + 服务端模板、零第三方运行依赖）重新实现，安全与工程标准取两个项目中更严格的一方；同时解决两个商店上线后**共用图库、单一入口上架自动同步**的架构问题。
>
> 原则：**只参考 KITVAULT 的实现思路（协议、算法、交互流程），代码全部按本项目架构重写**，不引入 Next.js/Prisma 依赖。

## 一、现状盘点（决策依据）

| 维度 | 球衣独立站（本项目，jerseyshelf.com） | KITVAULT（D:\独立站，未上线） |
|---|---|---|
| 商品库 | SQLite 真库：4,166 件 / 138 分类 / 定制 / 翻译 / 推荐 | 静态数据集编译进代码 3,736 件 + overrides 文件 |
| 图库 | **内容寻址**：`media` 表以 SHA-256 为主键，文件名即哈希，35,019 张原图 **34 GB**，派生 webp 819 MB（已去重） | 部分本地化 + 热链原站 CDN |
| 支付 | 无（货到付款 + 人工登记收款） | Stripe Checkout + PayPal Orders v2 真实实现（webhook 验签可被"未配置即跳过"绕过） |
| 物流 | 手工：官网/17TRACK 外链，多包裹，CSV 下单表 | 真实 OMS 对接（oms.cfky888.com）+ 17TRACK API v2.2 |
| 邮件 | 无发送能力 | Resend API（仅验证码；开发模式回显验证码） |
| 登录 | 邮箱密码 + 会话表 + CSRF | 同类 + Google/Apple OAuth（Google id_token 未验签） |
| 后台权限 | 单管理员 + audit_log | 多管理员 + 角色 + 细粒度权限键 + 最后 owner 保护 |
| 图搜 | 已上线，Python CLIP 进程，4,166 件全量索引 | 本地 CLIP + dHash 快路径 + 视觉大模型兜底 |
| 翻译/汇率 | 四家翻译接力（Azure/百度/DeepL/MyMemory，带配额）+ currencylayer 实时 | 免费源轮换（Google 免费端点/lingva）+ 4 家免费汇率源 + 心理定价 |

## 二、双店图库与商品同步架构（新增核心需求）

### 2.1 需求还原

上线后两个商店（jerseyshelf 与 JERSEYDOCK）卖同一盘货。要求：图库不重复占用硬盘；**在一个后台上架一次，另一个商店自动出现**。

### 2.2 图库层：三个候选方案的硬盘账

当前图库 **34 GB 原图 + 0.8 GB 派生图**，任何"各存一份"的方案每多一个商店就多约 35 GB。

| 方案 | 做法 | 硬盘增量 | 评价 |
|---|---|---|---|
| A. 各自全量复制 | 每店独立目录，各自 34 GB | **+35 GB/店** | 直接排除 |
| B. **共用内容寻址目录（推荐）** | 两应用共用同一个 `media/` 目录（文件名=哈希），各自 DB 只存登记记录；派生图同理（`<hash>-480.webp` 命名确定，天然去重） | **≈0**（总数仍约 35 GB） | 同机部署或共享卷时最优；本项目 media 表本来就是哈希寻址、immutable 缓存，零改造即可共享 |
| C. 对象存储（R2/S3/MinIO） | 图库整体上云，两店经 CDN 读 | 服务器 -34 GB，云上 ~$0.5/月（R2） | 干净但引入外部依赖，34 GB 迁移成本高；R2 免费层 10 GB 装不下。**列为将来多机部署时的演进项** |
| D. 跨店热链 | KITVAULT 直接引用 jerseyshelf 的 `/media/<hash>` URL | 0 | 两店不同机、无共享卷时的兜底；缺点是 jerseyshelf 变成图床、可用性耦合、需放开 KITVAULT 的 CSP `img-src` |

**结论：主方案 B，兜底 D，演进方向 C。** 同步协议里媒体条目同时携带 `hash + 绝对URL`，消费端先查共享目录（命中即零成本），未命中再按 URL 拉取并以哈希命名落盘——**按需复制 + 内容寻址保证无论部署形态如何都不会重复占盘**。

### 2.3 商品层：为什么是"主从同步"而不是别的

| 方案 | 评价 |
|---|---|
| 双向同步 | 冲突解决无解，排除 |
| 共用一个数据库 | 两站技术栈（raw SQLite vs Prisma）与迁移机制完全耦合，一次迁移双站停机，排除 |
| **主从（jerseyshelf 为主库，KITVAULT 订阅）** | jerseyshelf 商品后台最全（分类/定制/翻译/推荐/导入管线），作为唯一上架入口（PIM）；KITVAULT 拉取增量并保留**字段级 overrides**（定价倍率、上下架状态、文案微调）——它已有 overrides 概念，正好接住"两店同货不同价不同品牌" |

### 2.4 同步协议设计（阶段 S 详细步骤见第四章）

- **方向**：单向 jerseyshelf → KITVAULT；拉取式（KITVAULT 定时 poll + 手动"立即同步"），避免主站需要感知消费者。
- **主站出口**：`GET /api/sync/catalog?cursor=<seq>&limit=200`，令牌鉴权（令牌封存于 settings，复用 `seal/unseal` 密钥文件机制）。响应含 upsert 商品包（slug、标题、描述、价格、分类、规格、定制、**媒体清单 hash+url**、状态、`seq`）与 tombstone 删除清单。
- **变更捕获**：新增 `catalog_changes` outbox 表（`seq INTEGER PRIMARY KEY, product_id, op`），在商品保存/上下架/删除/媒体变更的所有写路径（`catalog.mjs`、后台商品编辑、导入脚本）统一追加；不需要触发器，风险可控可回放。
- **幂等**：消费端记 cursor；商品包带内容哈希，未变直接跳过；重复投递无副作用。
- **消费端落库**：upsert 进 KITVAULT 自己的库；本店差异只写 overrides 表（价格系数/状态/文案覆盖），主数据永不回写。
- **媒体处理**：见 2.2——先查共享目录，未命中按 URL 拉取、哈希命名落盘，`bytes` 校验后登记。
- **前置条件（S0）**：KITVAULT 必须先从 JSONL 文件迁移到真实数据库（其 Prisma schema 已备好，SQLite provider 即可起步）。往 JSONL 里做事务性 upsert 不可靠，这一步不可省。

## 三、功能移植总表（每项标注采纳方案）

| # | 功能 | 采纳方案（取最优） | 阶段 |
|---|---|---|---|
| 1 | 后台多管理员 + 细粒度权限 | KITVAULT 的权限键模型，落到 SQLite `users.permissions`，路由级集中校验（比它的逐接口松散检查更严） | 0 |
| 2 | 登录防爆破锁定 | KITVAULT 的 5 次失败锁 15 分钟，用现有 `limited()` 实现 | 0 |
| 3 | 在线支付 Stripe + PayPal | KITVAULT 的 redirect-only 流程（对 CSP 友好），**重写并修正：未配置密钥时 webhook 直接拒绝而非跳过验签** | 1 |
| 4 | OMS 履约对接 | KITVAULT 的 OMS 客户端协议 + 队列 worker，落 SQLite 队列表，回写现有 `shipments` 体系 | 2 |
| 5 | 17TRACK 轨迹同步 | KITVAULT 的 API v2.2 客户端，写入 `shipment_events`，外链页保留为兜底 | 2 |
| 6 | 邮件通知（Resend） | KITVAULT 的 Resend HTTP 调用思路，扩为**订单确认/发货/退款**三类模板（比它只发验证码更进一步），复用 WhatsApp 队列的 outbox 模式 | 3 |
| 7 | Google OAuth | KITVAULT 流程 + **补上它缺的 id_token JWKS 验签**（纯 node:crypto 实现，不加依赖） | 4 |
| 8 | 商品批量导入 UI | KITVAULT 的"上传+模板下载"交互，格式改 **CSV(UTF-8 BOM)** 保持零依赖（xlsx 需 ExcelJS，放弃）；导入即进主库、即触发同步 | 5 |
| 9 | 图搜增强 | KITVAULT 的 dHash 快路径 + 视觉大模型兜底（OpenAI 兼容接口，密钥后台配置），接到现有 Python 引擎后面 | 6 |
| 10 | 免费翻译源 | 把 KITVAULT 的 Google 免费端点/lingva 作为无密钥提供方插入现有接力链头部 | 7 |
| 11 | 免费汇率源 | KITVAULT 的 4 源轮换替换 reference 模式取数（open.er-api → exchangerate-api → frankfurter → jsdelivr），保留 currencylayer live 模式 | 7 |
| 12 | 图库共用 + 商品主从同步 | 见第二章，主方案 B | S |

**明确不移植**：KITVAULT 的 JSONL 文件存储、Prisma（本站保持 raw SQLite）、演示访客数补底、子串打分搜索（本站已有 search_keywords + normalize 索引）、CSV 退款弹窗（本站售后闭环更完整）、WhatsApp 深链（本站已有 Cloud API 全套）。

## 四、分阶段实施步骤

> 每阶段独立开关（settings 配置，默认关闭），可单独上线、单独回滚。迁移文件序号从 026 起，命名 `database/migrations/NNN-<名称>.sql`，启动时由 `apps/api/db.mjs` 自动执行。

### 阶段 0：权限与安全基座（约 2 人日）

1. **迁移 026-staff-permissions.sql**：`ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'`；`CREATE TABLE login_failures(email TEXT PRIMARY KEY, fails INTEGER, locked_until INTEGER)`。
2. **权限模型**（新文件 `apps/api/permissions.mjs`）：权限键沿用 KITVAULT 命名——`dashboard.view / products.edit / orders.view / orders.edit / customers.view / settings.edit / staff.manage / data.export`；`requirePerm(user, key)` 辅助函数；现有唯一管理员默认持有全部权限（owner）。
3. **路由接入**（`apps/api/server.mjs`）：`/admin` 前缀的 POST 分支在现有 admin 角色判断后追加 `requirePerm`；未授权返回 403 并 `audit()` 记录。
4. **登录锁定**（`apps/api/security.mjs`）：登录失败计数（按邮箱），5 次锁 15 分钟，成功清零；复用 `limited()` 思路但按账号维度。
5. **员工管理页**（新 `apps/admin/staff.mjs` + 路由 `/admin/staff`，仅 `staff.manage` 可见）：增删管理员、重置密码、勾选权限键；"最后一个 owner 不可降级/删除"保护（KITVAULT 逻辑重写）。
6. **测试**：`tests/staff-permissions.test.mjs`——无权限 403、锁定解锁、最后 owner 保护。
7. **验收**：新建只读账号登录后台，只能看不能改；错误密码 5 次后锁定。

### 阶段 1：在线支付 Stripe + PayPal（约 5 人日）

1. **迁移 027-payments.sql**：`CREATE TABLE payment_sessions(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), provider TEXT NOT NULL, provider_ref TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL)`；`orders` 增 `order_kind` 已存在（test/external），新增取值 `online`（TEXT 无 CHECK，直接写入）。
2. **提供方模块**（新 `apps/api/payments.mjs`，参考 `whatsapp-provider.mjs` 的 provider 形态 + KITVAULT `packages/shared/src/payment/index.ts` 协议思路重写）：
   - Stripe：`POST https://api.stripe.com/v1/checkout/sessions`（form 编码，`Authorization: Bearer sk_...`），`mode=payment`、`success_url=/checkout/return?sid=`、`cancel_url=/checkout`、金额用最小货币单位；`GET /v1/checkout/sessions/{id}` 查状态。
   - PayPal：OAuth2 client_credentials 换 token → `POST /v2/checkout/orders`（redirect 流）→ return 页 `POST /v2/checkout/orders/{id}/capture`。
   - **验签（修正 KITVAULT 缺陷）**：Stripe webhook 用 v1 头 `Stripe-Signature` 做 HMAC-SHA256 计时安全比较 + 5 分钟时间戳容差（`node:crypto.timingSafeEqual`）；PayPal 调官方 `POST /v1/notifications/verify-webhook-signature`。**任一密钥未配置 → 记日志并返回 400 拒绝处理，绝不"跳过验签"**。
3. **凭据封存**：settings 键 `payment`，secret 字段用 `fx-provider.mjs` 的 `seal/unseal` 模式新建 `payment-credentials.key`（备份脚本 `scripts/ops/backup.mjs` 同步纳入）。
4. **路由**（`server.mjs`）：
   - `POST /checkout/pay`：订单金额服务端重算（不信任客户端），创建 `payment_sessions`，302 跳转 provider 托管页（302 导航不受现有 CSP `form-action` 限制，**无需改 CSP**）。
   - `GET /checkout/return`：服务端向 provider 复核会话/PayPal capture → 幂等置 `payment_status='paid'`（复用 `customer-payments.mjs` 第 29 行的 paid/paid_at 写入路径）→ 跳订单页。
   - `POST /webhooks/stripe`、`POST /webhooks/paypal`：与 `/webhooks/whatsapp` 并列的公开端点，先 `limited()` 限流再验签再处理；`checkout.session.completed` / `PAYMENT.SALE.COMPLETED` 与 return 页共用同一幂等标记函数。
5. **结账页**：支付方式选择（货到付款保持默认 / 在线支付）；订单中心资金分区显示 provider 会话与回调记录。
6. **后台设置页**（新 `apps/admin/payments.mjs`，`settings.edit` 权限）：模式开关（off/Stripe/PayPal/都开）、密钥录入（封存）、webhook 密钥、沙箱/生产切换、连通性自检按钮（各发一次最小 API 探测）。
7. **测试**：`tests/payments.test.mjs`——签名错误 400、未配置密钥 400（回归 KITVAULT 缺陷）、重复回调幂等、return 页 capture 失败不置 paid。Stripe/PayPal 各用官方沙箱凭据人工过一遍真实链路。
8. **验收**：沙箱环境完成一笔支付，订单变 paid、`order_receipts` 生成记录、后台可见；篡改 webhook 体被拒。

### 阶段 2：物流自动化：OMS + 17TRACK（约 5 人日）

1. **迁移 028-oms.sql**：`CREATE TABLE oms_queue(id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), op TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`；`CREATE TABLE oms_labels(order_id TEXT NOT NULL, carrier TEXT, tracking TEXT, url TEXT, fetched_at TEXT NOT NULL)`。
2. **OMS 客户端**（新 `apps/api/oms.mjs`，按 KITVAULT `packages/shared/src/oms/index.ts` 的接口清单重写为纯 fetch）：`getShippingMethod / GetWarehouse / CreateLogisticsOrder（reference_no=订单号幂等）/ GetTrackingNumber / GetOrderTrack / CreateOrderLabel / CancelOrder / BlockOrder`。凭据（customer_code/customer_pwd/base_url）封存 settings `oms`；**强制 https base_url**（KITVAULT 默认 http 明文，不沿用）。
3. **队列 worker**（`oms.mjs` 内 `startOmsWorker()`，仿 `whatsapp-queue.mjs` 的 `startWaWorker`）：`setInterval` 3 秒出队、指数退避重试 5 次；每 30 分钟轨迹同步。在 `server.mjs` 启动段与现有 worker 并列启动（`unref()`）。
4. **与现有流程咬合**（关键，KITVAULT 没有的部分）：
   - 货到付款确认（`cod.mjs` confirmCod）成功后自动入队 `CreateLogisticsOrder`；
   - 拉回运单写入 **019 的 `shipments`/`shipment_items`**（复用多包裹与商品数量分配），轨迹写 `shipment_events`，中文状态→英文映射表（已签收→delivered 等，取 KITVAULT 正则表重写为字典）；
   - 履约状态只升不降（delivered 粘滞），沿现有 `fulfillment_status` 值域；
   - 拒收/退回走现有 COD 回流与售后入库，不另起状态机。
5. **17TRACK**（新 `apps/api/tracking17.mjs`）：`POST https://api.17track.net/track/v2.2/gettrackinfo`（头 `17track-api-token`），30 分钟缓存；对 OMS 未覆盖的运单补同步；事件同样写 `shipment_events`，`/track` 前台页与外链兜底保留。
6. **后台页**（新 `apps/admin/oms.mjs` + `/admin/oms`，权限 `orders.edit`）：渠道/仓库缓存查看与刷新、队列状态、单笔重推/取消、面单 PDF 列表（存 `storage/oms-labels/`，仅 OMS 只保 20 天链接，本地永久留档）。
7. **测试**：`tests/oms.test.mjs`——队列重试、幂等键防重复下单、轨迹状态映射；17TRACK mock 响应解析。
8. **验收**：测试订单推送 OMS 沙箱 → 拉回运单 → 订单详情物流分区出现轨迹事件 → `/track` 页可查。

### 阶段 3：邮件通知（约 3 人日）

1. **迁移 029-email.sql**：`CREATE TABLE email_messages(id TEXT PRIMARY KEY, customer_id INTEGER, order_id TEXT, to_email TEXT NOT NULL, kind TEXT NOT NULL, locale TEXT NOT NULL, subject TEXT, body TEXT, status TEXT NOT NULL, attempts INTEGER DEFAULT 0, next_attempt INTEGER DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', platform_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`——结构对照 `whatsapp_messages` outbox。
2. **发送模块**（新 `apps/api/mailer.mjs`）：Resend HTTP API（`POST https://api.resend.com/emails`，Bearer 密钥封存 settings `email`）；未配置时队列静默挂起（**不做 KITVAULT 的 devCode 式回显**）。
3. **触发点**：订单 paid（确认邮件）、`shipments` 首次回填运单（发货邮件，含 `/track` 链接）、售后退款登记（确认邮件）。主题/正文模板复用**现有翻译作业体系**按 `orders.currency` 对应语言出多语版本（站内已有 29 语种字典基础则直接用，没有的语种回退英文）。
4. **worker**：`startEmailWorker()` 3 秒出队，与 WhatsApp 队列同款退避；后台 `/admin/settings` 邮件区显示发送记录与失败重试。
5. **测试**：`tests/email.test.mjs`——队列退避、去重键、未配置不发。
6. **验收**：沙箱 Resend 收到三封模板邮件；后台可见状态流转。

### 阶段 4：Google OAuth 登录（约 2 人日）

1. **迁移 030-oauth.sql**：`ALTER TABLE users ADD COLUMN oauth_provider TEXT NOT NULL DEFAULT ''`；`ADD COLUMN oauth_sub TEXT NOT NULL DEFAULT ''` + 唯一索引 `(oauth_provider, oauth_sub)`。
2. **模块**（新 `apps/api/oauth.mjs`）：
   - `/account/google/start`：生成 state（随机 + 过期存 session 行），302 到 Google 授权页；
   - `/account/google/callback`：换 token 后**严格验签 id_token**——拉取 Google JWKS（`https://www.googleapis.com/oauth2/v3/certs`），用 `node:crypto.createVerify('RSA-SHA256')` 验签名，校验 `iss/aud/exp/nonce`（补上 KITVAULT 只 base64 解码不验签的漏洞）；
   - 命中已绑订账户直接登录；未绑订：邮箱存在则绑定，否则自动注册（走现有 `registerAccount` 的建档 + WhatsApp 跟进待办链路，复用而非另写）。
3. **后台/前台**：登录页加"使用 Google 继续"（未配置时隐藏）；账户页可解绑。
4. **凭据**：client_id/secret 封存 settings `oauth`。
5. **测试**：`tests/oauth.test.mjs`——错签名拒绝、错 audience 拒绝、nonce 重放拒绝。
6. **验收**：真实 Google 账号完成登录并自动建档出现在 `/admin/customers` 新注册分组。

### 阶段 5：商品批量导入 UI（约 3 人日）

1. **迁移 031-import-batches.sql**：`CREATE TABLE import_batches(id INTEGER PRIMARY KEY, filename TEXT, status TEXT, total INTEGER, ok INTEGER, failed INTEGER, log TEXT, actor_id INTEGER, created_at TEXT)`。
2. **解析模块**（新 `apps/api/import.mjs`）：把 `scripts/import/catalog.mjs` 的入库逻辑抽成可调用函数；CSV 解析纯手写（表头中文/英文映射表取 KITVAULT `import-parse.ts` 的字段字典思路），UTF-8 BOM 兼容 Excel；图片 zip 解压用 `node:zlib`（zip 需要极小 reader 实现——若评估超 150 行则退为"图片走 URL 列 + 服务器代抓"，仍零依赖）。
3. **路由**：`GET /admin/products/import`（上传页 + 模板下载 `?format=csv|json`，模板带字段说明表）；`POST /admin/products/import`（限流 + 权限 `products.edit`，逐行校验，错误行号回显，成功批次记 `import_batches`）。
4. **与同步咬合**：导入写库走与后台编辑相同的保存函数 → 自动追加 `catalog_changes`（见阶段 S）→ 联动另一店。
5. **测试**：`tests/import.test.mjs`——坏行报错不落库、批次可追溯、幂等重导。
6. **验收**：用模板录入 5 件新商品（含图片 URL），前台可见、批次日志正确。

### 阶段 6：以图搜款增强（约 2 人日）

1. **dHash 快路径**：检查 `scripts/image-search/engine.py` 是否已含感知哈希；没有则加 64 位 dHash，汉明距离 ≤5 直接判同款，跳过 CLIP（KITVAULT 参数照搬：阈值 5）。
2. **视觉大模型兜底**（`apps/api/image-search.mjs`）：CLIP 最高分低于 `minScore`（现 0.90，改后台可调 0.80–0.95）时，把原图 base64 发 OpenAI 兼容 `/chat/completions`（vision），提示词要求输出「球队+赛季+类型+主客场」结构化属性，用属性关键词走现有 `search_keywords` 文本检索出候选；提供方多密钥轮换（密钥封存 settings `image_search.fallback`），全部失败时维持现在的"无结果"文案。
3. **后台**：`/admin/image-search` 设置页加兜底模型区（base_url、密钥、模型名、连通测试）。
4. **测试**：`tests/image-search-fallback.test.mjs`——低分触发、LLM 失败降级、属性检索命中。
5. **验收**：上传一张 CLIP 认不出的街拍，经属性兜底返回正确球队候选。

### 阶段 7：免费翻译源 + 免费汇率源（约 2 人日）

1. **翻译**（`apps/api/translation-providers.mjs`）：新增两个无密钥提供方 `google-free`（translate.googleapis.com gtx 端点）与 `lingva`，插在接力链最前（免额度压力，MyMemory 兜底不变）；沿用现有配额/冷却/usage 表结构（额度设∞，仅记失败冷却）。
2. **汇率**（`apps/api/fx-provider.mjs`）：reference 模式取数改为 4 免费源轮换（open.er-api.com → exchangerate-api open 端点 → frankfurter → jsdelivr currency-api），任一成功即写 `exchange_rates` 快照 + 记录来源；全部失败保留旧快照（现状语义）。live 模式（currencylayer）不动。
3. **测试**：`tests/translation-providers.test.mjs`、`tests/fx-sources.test.mjs`——mock 各源响应、失败轮换。
4. **验收**：后台翻译提供方页出现两个免费源且默认可用；汇率页显示来源与更新时间。

### 阶段 S：图库共用与商品主从同步（约 6 人日，KITVAULT 上线前完成）

1. **S0（KITVAULT 侧前置，约 2 人日）**：JSONL → 真数据库（其 Prisma schema 落 SQLite provider 即可起步，Postgres 之后再换）；orders/users/events 等表迁移脚本；原有文件只读保留。
2. **S1 主站出口（约 2 人日）**：
   - 迁移 `032-catalog-sync.sql`：`CREATE TABLE catalog_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, op TEXT NOT NULL CHECK(op IN('upsert','delete')), created_at TEXT NOT NULL)`；
   - 新 `apps/api/catalog-sync.mjs`：导出打包函数（商品全字段 + 规格 + 分类 + 定制模板 + 媒体清单 `{hash,ext,bytes,url}`）；`GET /api/sync/catalog` 令牌鉴权（令牌封存 settings `sync`）+ `limited()` 限流；`catalog.mjs` 及所有商品写路径追加 outbox 记录（含阶段 5 导入路径）；
   - 后台 `/admin/sync` 页：令牌生成/重置、消费者 cursor 查看、手动重建全量快照。
3. **S2 消费端（KITVAULT 侧，约 1.5 人日）**：定时（10 分钟）+ 手动拉取；upsert 入库；媒体条目先查共享目录命中即跳过，未命中按 URL 拉取、`hash` 命名落盘、`bytes` 校验；本店差异（价格系数/上下架/文案）写 overrides 表。
4. **S3 验证（约 0.5 人日）**：主站改一件商品价格 → 10 分钟内 JERSEYDOCK 出现；删除 → tombstone 生效；拔掉共享卷改走 URL 拉取 → 硬盘不重复（抽查哈希文件唯一）。
5. **部署形态决策点**：两店同机（或同 NAS 卷）→ 共享目录挂载为两应用 `mediaDir`；不同机 → 消费端按需 URL 拉取（每店增量硬盘 ≈ 该店实际引用的新图），或将图库整体迁 R2（方案 C，另立项目）。

## 五、实施顺序与里程碑

```
阶段0 权限安全 ──→ 阶段1 支付 ──→ 阶段2 物流 ──→ 阶段S 同步（KITVAULT 上线门槛）
      └──────────→ 阶段3 邮件 ──→ 阶段4 OAuth ──→ 阶段5 导入UI ──→ 阶段6 图搜 ──→ 阶段7 翻译汇率
```

- 阶段 0 是所有新后台页的权限地基，最先做；
- 阶段 1、2 决定 JERSEYDOCK 能否开张（在线支付 + 自动履约），优先级最高；
- 阶段 S 依赖阶段 5（导入走同一写路径才能联动），可与 3/4 并行；
- 阶段 6、7 独立，随时可插空。

**总量约 30 人日**；每阶段独立开关、独立回滚（关掉 settings 开关即回到现状，数据表留存无害）。

## 六、风险与回滚

| 风险 | 缓解 |
|---|---|
| 支付 webhook 伪造 | 阶段 1 已内建"未配置即拒绝"；上线后用 provider 事件测试工具回归 |
| OMS 凭据泄露 | 封存密钥文件 + 强制 https + 备份脚本不含明文 |
| 同步把坏数据放大到两店 | outbox 可回放 + 消费端内容哈希跳过 + 主站保存函数单一出口；删除走 tombstone 需人工确认开关 |
| 图库误删影响两店 | 共享目录只增不删（哈希寻址天然支持）；清理任务需双人权限（阶段 0 权限键控制） |
| KITVAULT 落库迁移丢数据 | S0 迁移脚本 dry-run 对照行数；旧 JSONL 只读保留一个版本周期 |
| 34GB 图床带宽叠加 | 派生 webp（480/960）由两店各自缓存命中共享；监控 `traffic` 页带宽异常 |

## 七、生产部署清单（每阶段上线时执行）

1. `node --test tests/*.test.mjs` 全绿；
2. `scripts/ops/backup.mjs` 全量备份（**新密钥文件 `payment-credentials.key`、`oms`、`email`、`oauth`、`sync` 封存后须与库成套备份**，模式同 `translation-credentials.key`）；
3. 生产重启自动跑迁移（db.mjs 启动段），观察 `storage/server.log` 无 SQL 报错；
4. 对应功能页冒烟：支付沙箱一笔、OMS 推单一单、同步改价一件；
5. 回滚预案：settings 开关置 off + `git revert`（无需回滚数据库，新表留存无害）。
