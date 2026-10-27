# JerseyShelf Meta Pixel 正式上线记录

北京时间 2026-10-23 14:25，Pixel `1697741321689628` 已正式部署，服务重启成功。上线操作获用户明确授权。

## 环境与备份

- 服务器：沿用固定主机密钥校验的现有 SSH 连接，`189.24.79.73`。
- 程序目录：`/www/wwwroot/jerseyshelf`。
- 服务：`jerseyshelf.service`，以用户 `jerseyshelf` 运行。
- 本地和线上目录均非 Git 仓库；发布前下载三个现有线上程序文件，确认除 Pixel 补丁外与本地相同。
- 备份：`/opt/jerseyshelf/meta-pixel-release/backups/20261023T062511096446Z`。
- 发布清单与结果：`/opt/jerseyshelf/meta-pixel-release/manifest.json`、`deployment-result.json`。
- 原文件均在替换前备份，SHA-256 核对通过；服务返回 active/running，Result=success，ActiveEnterTimestamp 为 2026-10-23 14:25:11 CST。

## 线上文件

仅更新以下五个网站程序文件，两个新增、三个修改：

| 文件 | 用途 | SHA-256 |
| --- | --- | --- |
| `apps/storefront/meta-pixel.mjs`（新增） | 基础 Pixel、同意控制、告知 | `efcdc6a2cc875e1dfaea631129b63c167fb408ea302b1320a1f07532111726f8` |
| `apps/storefront/public/meta-pixel.css`（新增） | 同意提示的独立样式 | `a06c112a9eadfd39dbd730c67abdad9803b02803f82add18ca867e3c10535ae0` |
| `apps/storefront/views.mjs` | 全站前台共用模板 | `e34d0b250a0eab6b547de7ade50fda54b92d428c9441eeaa8896f062b0fa5557` |
| `apps/storefront/checkout.mjs` | 独立结账模板 | `4a1b68fc976e687281cd34926fd237cad0d4aefbb70fc94ec88b11b079540415` |
| `apps/api/server.mjs` | CSP、样式路由、同意识别、告知页 | `1575c4e7b78d0caf0e51c8e3de325e667703edc3a5cc37332befad7a5d6b4bbb` |

发布包不包含数据库、客户、商品、订单、购物车、媒体、环境变量或支付配置。没有编写数据更新 SQL、运行导入脚本或更改业务功能。重启沿用现有服务启动流程。运维脚本、发布包和验收结果仅保存在独立 `/opt/jerseyshelf/meta-pixel-release` 目录。

## 去重、CSP 与同意

部署前线上没有已有 Pixel、GTM 或广告同意控制，隐私页只有占位内容。本次补齐 Meta 专项告知和默认拒绝的广告 Cookie 选择；没有把注册邮件或 WhatsApp 授权当成 Pixel 同意。

- 接受前不加载 SDK，不发送 PageView；拒绝仍可购物。
- 180 天第一方选择 Cookie、每页设置入口、撤回及跨标签同步；尊重 Global Privacy Control。
- noscript 只有在有效接受 Cookie 且无 Sec-GPC: 1 时输出。
- 同一文档的初始化和 PageView 均有去重保护，撤回再接受不重复发送。
- CSP 精确允许该内联脚本的 SHA-256、`connect.facebook.net` 脚本与 `www.facebook.com` / `www.facebook.net` 请求和图片；没有启用 unsafe-inline。
- 只添加基础 PageView，没有添加 AddToCart、InitiateCheckout、Purchase 或客户资料自定义事件。

经营者仍需完善包含经营主体、联系方式及其他处理活动的完整隐私声明。本次只补齐此 Pixel 的告知和技术同意控制，不作全面合规保证。

## 验收

- 5 项同意控制单元检查及 17 项定向集成检查通过。
- 本地 Chrome 隔离测试无 CSP 违规：未同意零 Meta 请求，接受后单次初始化/PageView，撤回并刷新后无新增事件；所有模拟 Meta 请求均拦截，未向 Meta 发送模拟事件。
- 正式 HTTPS 首页、商品页 `/products/2026-27-bayern-munich-away-kit-fan-edition`、隐私页和新增 CSS 均返回 200。
- 页面各一处 init 和 PageView 调用，CSP 哈希与实际输出匹配；noscript 接受/GPC 分支检查通过。
- 普通 Chrome 真实网络验证：首页与商品页状态均 200；未同意时 Meta 请求 0；接受后首页一次 PageView，进入商品页再一次，总共 2 次。两次 `www.facebook.com/tr/` 请求均 200。SDK 和配置请求均 200，无 CSP 错误或其他浏览器错误。
- 无界面 Chrome 先前未产生事件，检查 Meta 公开配置发现启用 BotBlocking 且包含 HeadlessChrome 过滤，随后改用普通 Chrome 验收。没有绕改 Meta 过滤配置。

真实浏览器证据：`storage/meta-pixel-release/production-normal-browser.log`。截图：`storage/meta-pixel-release/production-consent.png`。发布与本地验证日志均在同一独立本地发布目录。

## 账户端后续验证

本次未登录 Meta Events Manager，网络事件 200 不等于已确认账户后台展示。账户持有人进入 Events Manager，选择 `1697741321689628` → 测试事件 → 打开网站并接受广告 Cookie，应看到 PageView；浏览商品页后再出现一次。未选择或拒绝时不应发送本站事件。

回滚及详细操作见 [基础安装与正式部署说明](Meta-Pixel基础安装说明.md)。
