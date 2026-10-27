# 货币与汇率数据

货币清单来自 [SIX ISO 4217 当前货币表](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html)，快照发布日期2026-09-17。排除贵金属、记账基金及专用资金代码，保留155个当前货币选项。VED目前缺少公开报价，仅显示不可选；不使用猜测汇率。

初始美元基准汇率来自 [Frankfurter](https://frankfurter.dev/)，各行记录各自日期。服务器缓存汇率，运行期间每天更新一次，也可在后台站点设置手动更新。超过7天的汇率不能用于新订单。结账报价与会话、商品价格、数量及运费绑定，锁定30分钟。

商品、规格、定制费和运费仍按USD基础金额维护。顾客选择其他货币后，商品和订单以该币种显示，订单金额按该货币最小单位保存；订单额为换算后单价乘数量，再加换算运费。历史订单保存币种、汇率、汇率日期、美元基准金额，不随新汇率变化。现有正式支付未接入；本地测试订单也使用所选货币记账。

国旗图标来自 [Twemoji](https://github.com/twitter/twemoji)，版权 © X Corp and other contributors，图形采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，保存在 `apps/storefront/public/flags`。欧元和区域共用货币显示欧盟或代表地区旗帜。

## 实时模式

已接入currencylayer Live接口和后台配置入口，但默认未启用。需提供真实密钥及满足60秒更新要求的服务套餐。实时快照单独保存，不覆盖Frankfurter参考数据；服务返回的Unix时间戳超过2分钟时拒绝新换算。后台连接测试成功后才可启用，密钥加密保存。没有密钥时仍是每日参考汇率。

当前默认服务为Frankfurter，无需密钥，每24小时同步一次；启动时会补齐超过24小时未同步的数据。同步时间与数据日期分别保存，界面明确标注每日参考汇率。
