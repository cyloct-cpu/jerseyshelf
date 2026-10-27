import { escape as e } from '../api/security.mjs';

// Shared by every product page, including future manual and imported products.
// Keep the contact number unset until the merchant supplies their own number.
export const descriptionAssets = [
  { name: 'partners.png', width: 644, height: 409, alt: '全球配送及合作伙伴示意图' },
  { name: 'delivery.webp', width: 720, height: 175, alt: '美国运营、快速配送与满意保证' },
  { name: 'guarantees.webp', width: 474, height: 102, alt: '安全交易、30 天退款、满意保证与便捷退货' },
  { name: 'warehouse.png', width: 626, height: 497, alt: '我们的团队与仓库' }
];

function illustration(index) {
  const asset = descriptionAssets[index];
  return `<p class="description-illustration"><img src="/assets/product-description/${asset.name}" width="${asset.width}" height="${asset.height}" alt="${asset.alt}" loading="lazy"></p>`;
}

export function productDescription(description = '', locale = 'zh-CN') {
  return `<section class="product-description" id="product-description" aria-labelledby="product-description-title">
    <details class="description-disclosure">
    <summary><h2 id="product-description-title">商品描述</h2><svg class="description-chevron" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m3 6 5 5 5-5"/></svg></summary>
    <div class="description-body">
    ${description ? `<div class="plain-content product-specific-description" translate="no">${e(description)}</div>` : ''}
    <div class="description-template" lang="${e(locale)}">
      <p><strong class="description-accent">库存有限，欲购从速！</strong></p>
      <p><strong class="description-accent">全球配送 ✈ &gt;&gt;</strong>请注意，所有包裹均已投保。不过，您可能会提前收到商品。我们会始终发送追踪号码，方便您随时追踪包裹状态！好东西值得等待！</p>
      ${illustration(0)}
      <p><strong class="description-accent">⏰处理时间&gt;&gt;</strong> <em>付款后 24-48 小时内发货。</em></p>
      <p><strong class="description-accent">配送&gt;&gt;</strong><em>我们会为您安排最快的配送方式。</em></p>
      ${illustration(1)}
      <p><strong class="description-accent">100% 无风险购买 &gt;&gt;</strong> <em>30 天内如有任何不满意，可快速退款，100% 退款保证。</em></p>
      <p>如果您购买后觉得不合适，请不要担心。添加我们的 <span class="description-accent">WhatsApp</span> 并发送消息，我们将为您提供换货或退款服务，确保您满意。流程简单便捷，100% 无风险。</p>
      ${illustration(2)}
      <p><strong class="description-accent">我们的仓库&gt;&gt;</strong> 请考虑可能影响交货时间的节假日。请考虑可能影响交货时间的运输方式和意外情况。</p>
      ${illustration(3)}
      <p><strong class="description-accent">非常感谢您光临本店。祝您购物愉快！</strong></p>
    </div>
    </div>
    </details>
  </section>`;
}
