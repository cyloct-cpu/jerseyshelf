import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

// 测试专用服务器启动助手：PORT=0 由内核分配空闲端口，避免并发跑测试时固定基数互相冲突。
// 返回 {child, base, getLog}；调用方负责 after() 里 kill 子进程并关闭自己打开的数据库连接。
export async function spawnTestServer({ root, dir, extraEnv = {} } = {}) {
  const child = spawn(process.execPath, ['apps/api/server.mjs'], {
    cwd: root,
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0',
      DATABASE_PATH: path.join(dir, 'store.sqlite'), MEDIA_PATH: path.join(dir, 'media'),
      FX_AUTO_UPDATE: 'false', TRANSLATION_AUTO_UPDATE: 'false',
      OMS_AUTO_UPDATE: 'false', EMAIL_AUTO_UPDATE: 'false',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', b => log += b);
  child.stderr.on('data', b => log += b);
  let base = '';
  for (let i = 0; i < 200 && !base; i++) {
    const m = log.match(/商城: http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) base = 'http://127.0.0.1:' + m[1];
    else await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(base, '服务器未输出监听地址：' + log);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(ready, '服务器健康检查未通过：' + log);
  return { child, base, getLog: () => log };
}
