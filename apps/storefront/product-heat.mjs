export function productHeat(product){
  return `<p class="product-heat" data-product-heat data-product-id="${product.id}" hidden><svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg><span>商品热度（展示值）：<strong data-product-heat-value translate="no">—</strong></span></p><script type="module" src="/assets/product-heat.js"></script>`;
}
