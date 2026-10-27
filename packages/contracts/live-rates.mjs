export function parseLiveRates(payload,now=Date.now()){
  if(payload?.success!==true||payload.source!=='USD'||!payload.quotes||Array.isArray(payload.quotes))throw new Error('实时汇率响应无效，请检查服务密钥和套餐');
  const timestamp=Number(payload.timestamp)*1000;
  if(!Number.isFinite(timestamp)||now-timestamp>120000||timestamp-now>30000)throw new Error('服务报价超过2分钟，无法作为实时汇率使用');
  const rows=[];
  for(const [pair,rate]of Object.entries(payload.quotes)){
    if(!/^USD[A-Z]{3}$/.test(pair)||typeof rate!=='number'||!Number.isFinite(rate)||rate<=0)throw new Error('实时汇率包含无效报价');
    rows.push({base:'USD',quote:pair.slice(3),rate,date:new Date(timestamp).toISOString().slice(0,10),timestamp:Math.floor(timestamp/1000)});
  }
  if(!rows.length)throw new Error('实时汇率缺少报价');
  return {rows,timestamp:Math.floor(timestamp/1000),fetchedAt:now,source:'currencylayer'};
}
