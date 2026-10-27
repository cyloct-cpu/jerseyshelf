const state = document.querySelector('#translation-state');
if (state) setInterval(async () => {
  if (document.hidden) return;
  try {
    const response = await fetch('/admin/translations/status.json',{headers:{Accept:'application/json'}});
    if (!response.ok) return;
    const data = await response.json(), count = status => data.counts.find(c => c.status === status)?.count || 0;
    const time = data.resumeAt > Date.now() ? `；预计继续时间：${new Date(data.resumeAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}（北京时间）` : '';
    state.textContent = (data.lastError || (data.enabled ? '自动翻译已启用，等待或处理任务' : '自动翻译已暂停')) + time;
    document.querySelector('#translation-counts').textContent = `已完成 ${count('ready')} · 待处理 ${count('pending') + count('running')} · 失败 ${count('failed')} · 不支持 ${count('unsupported')}`;
    document.querySelector('#translation-usage').textContent = `今日已请求 ${data.usage.characters} / ${data.dailyLimit} 字符，${data.usage.requests} 次请求（按 UTC 日统计，失败请求也计入）。`;
    for (const provider of data.providers || []) {
      const status = document.querySelector(`[data-provider-status="${provider.id}"]`), usage = document.querySelector(`[data-provider-usage="${provider.id}"]`), error = document.querySelector(`[data-provider-error="${provider.id}"]`);
      if (status) status.textContent = provider.status;
      if (usage) usage.textContent = `本站本期请求 ${provider.usage.characters} 字符；其他渠道已用 ${provider.usage.external}；本站设置上限 ${provider.limit}（${provider.period==='day'?'每日':'每月'}）。`;
      if (error) error.textContent = (provider.lastError || '') + (provider.resumeAt > Date.now() ? `；预计再试：${new Date(provider.resumeAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}` : '');
    }
  } catch {}
},15000);
