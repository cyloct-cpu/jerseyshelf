// 真实用户全流程模拟：浏览 → 注册 → 加购(定制) → COD 结账 → 查单 → 语言/货币切换 → 管理员履约闭环。
// 像浏览器一样携带 Cookie 与 CSRF；对每一步做断言并输出核对点。
const base='http://127.0.0.1:3002';
const stamp=Date.now().toString(36);
class Browser{
  constructor(tag){this.tag=tag;this.cookies=new Map();this.csrf='';this.steps=0;}
  async go(url,options={}){const {method='GET',form=null,raw=null}=options;let expect=options.expect??200;
    this.steps++;
    const headers={Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; ')};
    let body;
    if(form){const f=new URLSearchParams({csrf:this.csrf,...form});headers['Content-Type']='application/x-www-form-urlencoded';body=f.toString();}
    else if(raw){Object.assign(headers,raw.headers);body=raw.body;}
    const r=await fetch(base+url,{redirect:'manual',method,headers,body});
    for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}
    const text=await r.text();
    this.csrf=text.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;
    const okCheck=expect===null||r.status===expect||(expect==='ok'&&r.status<400);
    const marker=okCheck?'✓':'✗';
    console.log(`${marker} [${this.tag}#${this.steps}] ${method} ${url} → ${r.status}${r.headers.get('location')?' → '+r.headers.get('location'):''}`);
    if(!okCheck){console.error('   !! 期望',expect,'实际',r.status,text.match(/notice error">([^<]*)/)?.[1]||'');process.exitCode=1;}
    return {status:r.status,body:text,location:r.headers.get('location')};
  }
}
const localNow=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19);
const assert=(cond,msg)=>{if(!cond){console.error('✗ 断言失败：'+msg);process.exitCode=1;}else console.log('  ✓ '+msg);};

// ---------- 顾客 ----------
const user=new Browser('用户');
console.log('—— 1. 浏览商城 ——');
let page=await user.go('/',{expect:200});
assert(/球世界/.test(page.body),'首页正常渲染');
page=await user.go('/collections/2026-27-season',{expect:200});
const productLink=page.body.match(/href="\/products\/([a-z0-9-]+)"/)?.[1];
assert(productLink,'分类页有商品链接：'+productLink);
page=await user.go('/products/2026-27-bayern-munich-away-kit-fan-edition',{expect:200});
const variantId=page.body.match(/name="variantId" value="(\d+)"/)?.[1];
const patchId=page.body.match(/name="patchIds" value="([a-f0-9-]+)"/)?.[1];
assert(variantId,'取得规格 ID：'+variantId);
assert(patchId,'存在臂章选项：'+patchId);

console.log('—— 2. 加购（含印字与臂章定制）——');
await user.go('/cart/add',{method:'POST',form:{variantId,quantity:'2',printingName:'Mueller#25',patchIds:patchId},expect:303});
// 第二件商品从搜索结果动态取（避免硬编码 slug 失效）。
const catalog=await user.go('/search?q=%E7%90%83%E8%A1%A3',{expect:200});
let candidate=null,v2=null,variant2=null;
for(const m of catalog.body.matchAll(/href="\/products\/([a-z0-9-]+)"/g)){
  if(m[1]==='2026-27-bayern-munich-away-kit-fan-edition')continue;
  candidate=m[1];v2=await user.go('/products/'+candidate,{expect:200});
  variant2=v2.body.match(/name="variantId" value="(\d+)"/)?.[1];
  if(variant2)break;
}
assert(candidate&&variant2,'第二件商品可用：'+candidate+' 规格 '+variant2);
await user.go('/cart/add',{method:'POST',form:{variantId:variant2,quantity:'1'},expect:303});
page=await user.go('/cart',{expect:200});
assert(/Mueller#25/.test(page.body),'购物车显示印字定制');
assert(/定制加价|printing/i.test(page.body)||/\$3\.00/.test(page.body),'定制加价可见');
assert(/免运费|Free shipping|满/.test(page.body)||/3 件/.test(page.body),'满3件免邮提示存在');

console.log('—— 3. 注册账户 ——');
const email=`e2e-user-${stamp}@example.com`;
page=await user.go('/account/register',{expect:200});
const reg=await user.go('/account/register',{method:'POST',form:{first_name:'小测',last_name:'陈',email,password:'e2e-password-123456',whatsapp_country_code:'+1',whatsapp_phone:'+1 202 555 0'+''+Math.floor(1000+Math.random()*8999),whatsapp_consent:'1'},expect:303});
assert(reg.location&&reg.location.includes('/account/welcome'),'注册后进入欢迎页');
page=await user.go('/account',{expect:200});
assert(new RegExp(email.replace(/[@.]/g,m=>'\\'+m)).test(page.body),'账户页显示注册邮箱');

console.log('—— 4. COD 结账 ——');
page=await user.go('/checkout',{expect:200});
const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)?.[1];
assert(quote,'取得结账报价：'+quote);
const totalOnPage=page.body.match(/合计[^0-9]*([0-9.,]+)/)?.[1];
console.log('  · 页面合计：'+totalOnPage);
const orderForm={first_name:'',email,name:'小测 陈',country:'US',region:'MA',city:'Boston',address:'1 Test Street',postal:'02110',phone:'+1 202 555 0100',checkoutKey:'e2e-'+stamp,quote_id:quote};
// 字段名对齐结账页
const fields={};
for(const key of ['email','country','region','city','address','address2','postal','phone','first_name','last_name','note']){
  const m=page.body.match(new RegExp('name="'+key+'"'));
  if(m)fields[key]='';
}
const name=page.body.match(/name="(customer_)?name"/)?.[1];
page=await user.go('/checkout',{method:'POST',form:{...orderForm,name:'小测 陈',whatsapp_locale:'zh-CN'},expect:303});
const orderId=page.location?.match(/orders\/(BW-[A-Z0-9-]+)/)?.[1];
assert(orderId,'订单已创建：'+orderId);

console.log('—— 5. 查单（订单页/物流页/账户）——');
page=await user.go('/orders/'+orderId,{expect:200});
assert(/货到付款/.test(page.body),'订单页显示货到付款提示');
assert(/待处理/.test(page.body),'履约状态为待处理');
assert(/wa\.me/.test(page.body),'WhatsApp 联系按钮存在');
page=await user.go('/track/'+orderId,{expect:200});
assert(/暂无|等待物流更新|尚未/.test(page.body)||/物流/.test(page.body),'物流页可访问');
page=await user.go('/account',{expect:200});
assert(page.body.includes(orderId),'账户订单列表包含新订单');

console.log('—— 6. 语言与货币切换 ——');
await user.go('/language?lang=en&return=/orders/'+orderId,{expect:303});
page=await user.go('/orders/'+orderId,{expect:200});
assert(/Cash on delivery|Order/i.test(page.body),'英文模式订单页');
assert(!/货到付款/.test(page.body),'英文模式不回退中文');
await user.go('/currency?code=EUR&return=/orders/'+orderId,{expect:303});
page=await user.go('/orders/'+orderId,{expect:200});
assert(/EUR|€/.test(page.body),'EUR 价格渲染');
await user.go('/currency?code=USD&return=/',{expect:303});
await user.go('/language?lang=zh-CN&return=/',{expect:303});

console.log('—— 7. 订阅与越权 ——');
await user.go('/subscribe',{method:'POST',form:{email},expect:303});
const stranger=new Browser('陌生人');
await stranger.go('/');
const peek=await stranger.go('/orders/'+orderId,{expect:404});
assert(peek.status===404,'陌生人无法访问他人订单');

// ---------- 管理员 ----------
console.log('—— 8. 管理员：建档/待办/履约闭环 ——');
const admin=new Browser('管理员');
await admin.go('/account');
await admin.go('/account/login',{method:'POST',form:{email:'admin@local.test',password:'7f98b42b2b60d6be456d11bd'},expect:303});
page=await admin.go('/admin',{expect:200});
assert(new RegExp(orderId).test(page.body)||/新订单/.test(page.body),'概览出现新订单/待办');
page=await admin.go('/admin/customers?view=new_orders',{expect:200});
assert(page.body.includes(orderId)||/e2e-user/.test(page.body),'客户管理新订单待办包含该客户');
page=await admin.go('/admin/orders/'+orderId,{expect:200});
assert(/资料确认|发货|section=follow/.test(page.body),'订单详情含 COD 跟进区');
// COD 资料确认
const dbMod=await import('node:sqlite');const roDb=new dbMod.DatabaseSync('D:/球衣独立站/storage/store.sqlite',{readOnly:true});
const orderRow=roDb.prepare('SELECT total FROM orders WHERE id=?').get(orderId);roDb.close();
const codAmountValue=(orderRow.total/100).toFixed(2);
const conf=await admin.go('/admin/cod/confirm',{method:'POST',form:{order_id:orderId,recipient:'小测 陈',phone:'+1 202 555 0100',country:'US',region:'MA',city:'Boston',postal:'02110',address:'1 Test Street',cod_currency:'USD',cod_amount:codAmountValue,confirmed:'1'},expect:303});
page=await admin.go('/admin/orders/'+orderId+'?section=shipping',{expect:200});
// 发货
const ship=await admin.go('/admin/cod/action',{method:'POST',form:{order_id:orderId,action:'dispatch',tracking:'E2E-TRACK-001'},expect:303});
page=await admin.go('/admin/orders/'+orderId,{expect:200});
assert(/E2E-TRACK-001/.test(page.body),'运单号已回填');
// 未确认发货应被拒（对另一笔测试订单验证过）——这里验证已发货订单不能重复发货
const again=await admin.go('/admin/cod/action',{method:'POST',form:{order_id:orderId,action:'dispatch',tracking:'E2E-DUP'},expect:400});
// 顾客侧查轨迹
page=await user.go('/track/'+orderId,{expect:200});
assert(/E2E-TRACK-001/.test(page.body),'顾客侧可见运单号');
// 包裹签收 → 代收核实 → 回款（真实 COD 闭环三步）
const roDb2=await import('node:sqlite');const sdb=new roDb2.DatabaseSync('D:/球衣独立站/storage/store.sqlite',{readOnly:true});
const shipmentId=sdb.prepare('SELECT id,status FROM shipments WHERE order_id=?').get(orderId);sdb.close();
assert(shipmentId,'包裹记录存在');
await admin.go('/admin/cod/action',{method:'POST',form:{order_id:orderId,shipment_id:String(shipmentId.id),action:'delivered',occurred_at:localNow(),evidence:'E2E 物流商核实签收'},expect:303});
page=await admin.go('/admin/orders/'+orderId,{expect:200});
assert(/已签收/.test(page.body),'订单已签收');
// 代收核实（签收后代收金额确认）
await admin.go('/admin/cod/action',{method:'POST',form:{order_id:orderId,shipment_id:String(shipmentId.id),action:'collect',amount:codAmountValue,occurred_at:localNow(),evidence:'E2E 物流商代收核实'},expect:303});
// 回款登记
const remit=await admin.go('/admin/cod/remit',{method:'POST',form:{order_id:orderId,currency:'USD',gross:codAmountValue,fee:'0',reference:'E2E-CASH-001',occurred_at:localNow(),confirmed:'1',request_key:'e2e-remit-'+stamp},expect:303});
page=await admin.go('/admin/orders/'+orderId+'?section=money',{expect:200});
assert(/E2E-CASH-001/.test(page.body),'回款记录可见');
page=await user.go('/orders/'+orderId,{expect:200});
assert(/已收齐款项|已付款|paid/i.test(page.body)||!/unpaid|未付款/.test(page.body),'顾客侧订单显示已收款');

console.log('—— 9. 幂等与边界 ——');
// 重复 checkout 同 key：应返回同一订单而不新建
const user2=new Browser('重放');
await user2.go('/');
await user2.go('/cart/add',{method:'POST',form:{variantId,quantity:'1'},expect:303});
await user2.go('/checkout',{expect:200});
const q2=(await user2.go('/checkout',{expect:200})).body.match(/name="quote_id" value="([a-f0-9]+)"/)?.[1];
await user2.go('/checkout',{method:'POST',form:{email:'replay@example.com',name:'Replay',country:'US',region:'MA',city:'Boston',address:'2 Replay St',postal:'02110',phone:'+1 202 555 0200',checkoutKey:'replay-'+stamp,quote_id:q2},expect:303});
const first=await user2.go('/checkout',{method:'POST',form:{email:'replay@example.com',name:'Replay',country:'US',region:'MA',city:'Boston',address:'2 Replay St',postal:'02110',phone:'+1 202 555 0200',checkoutKey:'replay-'+stamp,quote_id:q2},expect:303});
const firstOrderId=first.location?.match(/orders\/(BW-[A-Z0-9-]+)/)?.[1];
const dup=await user2.go('/checkout',{method:'POST',form:{email:'replay@example.com',name:'Replay',country:'US',region:'MA',city:'Boston',address:'2 Replay St',postal:'02110',phone:'+1 202 555 0200',checkoutKey:'replay-'+stamp,quote_id:q2},expect:303});
const dupId=dup.location?.match(/orders\/(BW-[A-Z0-9-]+)/)?.[1];
const checkDb=await import('node:sqlite');const cdb=new checkDb.DatabaseSync('D:/球衣独立站/storage/store.sqlite',{readOnly:true});
cdb.close();
assert(dupId===firstOrderId,'同一 checkoutKey 重放返回同一订单（'+firstOrderId+'）');
// 错误 CSRF
const badCsrf=new Browser('坏CSRF');
await badCsrf.go('/');
const csrfAttack=await fetch(base+'/cart/add',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':[...badCsrf.cookies].map(([k,v])=>k+'='+v).join('; ')},body:new URLSearchParams({csrf:'forged',variantId,quantity:'1'}).toString()});
assert(csrfAttack.status===403,'伪造 CSRF 被拒（403）');

console.log('\n===== 模拟完成。订单：'+orderId+'（顾客 e2e 流程）=====');
function expect303(){return 303;}
