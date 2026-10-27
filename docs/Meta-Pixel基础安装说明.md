# Meta Pixel 基础安装与正式部署

Pixel ID：`1697741321689628`。已于北京时间 2026-10-23 14:25 发布到 https://jerseyshelf.com/ 。`jerseyshelf` 重启成功，状态 active/running，启动结果 success。

## 发布范围

项目为原生 Node.js HTTP + 服务端模板 + SQLite。发布前审计了本地与线上程序、线上首页：未发现已有 Meta Pixel 或 Google Tag Manager。两端目录均无 Git 仓库，采用线上文件下载比对、SHA-256 清单及备份发布。去除 Pixel 补丁后，三个本地原文件与线上基线完全一致。

仅更新网站 `/www/wwwroot/jerseyshelf` 中以下五个文件：

- `apps/storefront/meta-pixel.mjs`：官方基础加载器、初始化、PageView、防重复执行、同意控制和 Pixel 隐私告知。
- `apps/storefront/public/meta-pixel.css`：仅作用于广告同意提示和设置入口的样式。
- `apps/storefront/views.mjs`：普通前台共用布局。
- `apps/storefront/checkout.mjs`：独立结账布局，仅 PageView。
- `apps/api/server.mjs`：CSP 哈希及必要来源、同意 Cookie 识别、样式路由、隐私页的 Pixel 告知。已有隐私正文会保留并追加告知。

本地另有测试、文档和 `scripts/ops/deploy-meta-pixel.py` 运维脚本。运维脚本只放在服务器独立发布目录。没有上传数据库、storage、媒体、客户或订单数据，没有修改生产环境变量、支付配置或业务逻辑。没有添加 AddToCart、InitiateCheckout、Purchase。

## 同意控制

上线前发现线上隐私页只有占位文字，没有广告追踪同意机制，因此在本次授权范围内补齐必要控制后再发布：

- 全球访客默认关闭 Pixel。无明确接受、拒绝、到期或启用 Global Privacy Control 时，不加载 Meta SDK、不发送 PageView。
- 同等显示接受和拒绝按钮，拒绝不影响购物；每页提供广告 Cookie 设置入口，可撤回。
- 选择存于第一方 `js_meta_consent` Cookie，最长 180 天；localStorage 信号仅用于同步同浏览器标签页，不含客户资料。
- 撤回时对已加载 SDK 执行 consent revoke，清除可访问的 `_fbp`、`_fbc`，停止本站后续 Pixel 事件；不承诺删除已发送给 Meta 的数据。
- 保留官方 noscript 图片，放在 body 开头；仅服务器识别到有效接受 Cookie 且没有 `Sec-GPC: 1` 时输出，避免无 JavaScript 时绕过同意。
- 每个文档最多初始化一次、调用一次 PageView。同一文档撤回再接受不重复发送。

告知涵盖 Meta 接收方、用途、数据类型、Cookie、选择期限、跨境处理可能性及撤回。经营者仍需完善其他数据处理对应的完整隐私声明、经营主体及联系方式；本次不构成全面法律合规保证。

参考：[ICO 广告追踪同意指引](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/how-do-the-rules-apply-to-online-advertising/)、[Meta 隐私政策](https://www.facebook.com/privacy/policy/)。

## 备份和回滚

发布目录：`/opt/jerseyshelf/meta-pixel-release`。

线上备份：`/opt/jerseyshelf/meta-pixel-release/backups/20261023T062511096446Z`。保存被替换的三个旧文件和发布清单；两个新文件此前不存在。先校验线上基线 SHA-256，再备份、原子替换、检查语法并重启；发布脚本在健康或页面检查失败时自动回滚。

人工回滚：将备份里的 `apps/storefront/views.mjs`、`apps/storefront/checkout.mjs`、`apps/api/server.mjs` 恢复到网站原路径，保持权限，执行 `systemctl restart jerseyshelf` 并检查 `/health`。两个新文件届时不再被引用，可保留。不要恢复本地数据库。

## 验证结果

- 同意控制单元测试 5 项通过；定向前台及业务集成测试 17 项通过。
- 本地 Chrome 隔离检查通过：未同意零 Meta 请求，接受后仅一次 SDK 和模拟 PageView，拒绝刷新后无新事件，无 CSP 错误。模拟请求被拦截，未向 Meta 发送模拟事件。桌面、手机截图检查通过。
- 线上正式 HTTPS：首页、指定商品详情、隐私告知页均 200；每页一处 init 和 PageView 调用，CSP SHA-256 与实际脚本匹配，没有启用 unsafe-inline。
- 线上只有有效接受 Cookie 才输出一个 noscript 图片；Sec-GPC: 1 阻止输出。样式资源 200。
- 服务 active/running，启动结果 success，启动时间北京时间 2026-10-23 14:25:11。
- 普通 Chrome 正式站网络验收通过：未同意零 Meta 请求；接受后首页和商品页各发送一次 PageView，两个 `/tr/` 请求均返回 200；SDK 与配置均 200，无 CSP 或其他浏览器错误。无界面 Chrome 被 Meta 自带 HeadlessChrome 机器人规则过滤，未改动该过滤配置，最终结果以普通浏览器为准。

前一轮扩展回归有 43 项通过、2 项汇率相关失败，未经基线对照确认原因；本次未改动汇率逻辑，未宣称全套测试通过。

证据：服务器 `deployment-result.json`；本地发布清单、日志和截图在 `storage/meta-pixel-release/`，真实浏览器结果为 `production-normal-browser.log`。真实 Meta 网络验收另见正式上线记录。代码中的 ID、SDK 200、SDK 内部 eventCount 都不能代替 Events Manager 收件确认；本次已另行确认真实事件请求 200，但未登录 Events Manager。

## 在 Meta Events Manager 验证

1. 登录拥有此 Pixel 权限的账户，选择 ID `1697741321689628`，进入“测试事件”。
2. 通过网站测试入口打开 https://jerseyshelf.com/ ，主动点击“接受广告 Cookie”。未选择或拒绝时不应出现本站 PageView。
3. 确认 PageView 的 ID 和访问网址正确；再打开商品页，每次完整页面加载应只有一次 PageView，不应出现本次未添加的购物或购买事件。
4. 配合 Meta Pixel Helper 和 Network 检查。SDK 配置请求不算 PageView；检查事件名和 Pixel ID，避免把隐私沙箱辅助请求误判为重复事件。
5. 在“广告 Cookie 设置”拒绝并刷新，确认后续页面没有 Meta SDK 或 PageView。可关闭广告拦截扩展测试接受场景。

本次未登录 Meta 广告账户，Events Manager 内部收件须由账户持有人确认。
