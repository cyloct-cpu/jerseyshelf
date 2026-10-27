export const checkoutTranslations={
  '省':'State / province','选择省/州':'Choose a state or province','选择城市':'Choose a city',
  '未找到匹配项，可直接填写':'No matches. You can enter your own.',
  '正在加载…':'Loading…','请输入您的联系电话':'Please enter your contact phone number',

  '姓名':'Name','街道地址和门牌号':'Street address and house number','大楼、公寓等':'Apartment, suite, etc.',
  '联系电话':'Contact phone','（选填）':' (optional)','保存收货信息以供下次使用':'Save shipping information for next time',
  '省和城市可选择建议项，也可直接填写':'Choose a region or city suggestion, or enter your own',
  '勾选后保存到您的账户':'If selected, save to your account','勾选后保存在当前浏览器':'If selected, save in this browser',
  '清除已保存的收货信息':'Clear saved shipping information','收货信息已清除':'Saved shipping information cleared',
  '无法保存到此浏览器，您仍可继续下单':'This browser could not save your information. You can still place your order.',
  '清除失败，请稍后重试':'Could not clear saved information. Please try again.',
  '请填写此项':'Please complete this field',
  '立即购买':'Buy now','现在购买':'Buy now','正在处理…':'Processing…','正在创建订单…':'Creating order…',
  '订单摘要':'Order summary','联系方式':'Contact information','已有账户？登录':'Already have an account? Log in',
  '收货地址':'Shipping address','您的地址信息仅用于订单配送':'Your address is used only to deliver your order',
  '请选择国家/地区':'Select a country or region','请选择有效的国家/地区':'Select a valid country or region',
  '选择国家/地区':'Choose a country or region','搜索国家/地区':'Search countries or regions',
  '搜索国家名称或代码':'Search country name or code','未找到匹配的国家/地区':'No matching countries or regions',
  '联系电话（选填）':'Phone (optional)','配送方案':'Delivery','标准配送':'Standard shipping',
  '免邮件数':'Free shipping from','件商品':'items',
  '印字':'Printing',
  '订单备注（选填）':'Order note (optional)','订单备注':'Order note','支付方式':'Payment method',
  '本地测试订单':'Local test order','不会扣款，可在后台模拟付款和发货':'No charge. Payment and fulfillment can be simulated in the admin panel.',
  '定制费用已计入商品金额':'Customization fees are included in the item prices',
  '返回修改商品':'Edit your selection','返回购物车':'Return to cart',
  '请检查标记的收货信息':'Please check the highlighted shipping information',
  '部分商品已下架或库存不足，请更新购物车':'Some items are unavailable or out of stock. Please update your selection.',
  '请打开结账页确认所选货币金额':'Open checkout to confirm the amount in your selected currency',
  '结账报价已过期或商品发生变化，请重新打开结账页':'Your quote expired or the items changed. Review the updated order and submit again.',
  '货币已更改，请重新打开结账页确认金额':'The currency changed. Review the updated amount and submit again.',
  '购买记录已过期，请返回商品页重新选择':'This purchase expired. Return to the product and select your options again.',
  '购买记录不存在':'Purchase not found','购买记录与商品不符':'This purchase belongs to a different product',
  '库存不足':'Insufficient stock','定制选项已更改，请移除后重新选择':'Customization options changed. Please choose your options again.',
};
for(const [label,name,max]of [['收件人','Name',100],['国家/地区','Country or region',2],['城市','City',150],['详细地址','Address',500],['邮编','Postal code',30],['电话','Phone',50],['订单备注','Order note',1000]]){
  checkoutTranslations[`${label}不能为空且最多 ${max} 字符`]=`${name} is required and must be at most ${max} characters.`;
  checkoutTranslations[`${label}格式错误`]=`Enter a valid ${name.toLowerCase()}.`;
}
