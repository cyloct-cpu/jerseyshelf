import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { db } from '../api/db.mjs';
import { PERMISSION_KEYS, parsePermissions } from '../api/permissions.mjs';

function admins() {
  return db.prepare("SELECT id,email,name,permissions,created_at FROM users WHERE role='admin' ORDER BY id").all();
}
const isOwner = row => parsePermissions(row.permissions).includes('owner');
const ownerCount = () => admins().filter(isOwner).length;

export function staffPanel(ctx, editing = null) {
  const rows = admins();
  const editId = editing ? editing.id : Number(ctx.url.searchParams.get('id') || 0);
  const target = editing || rows.find(r => r.id === editId) || null;
  const targetPerms = target ? parsePermissions(target.permissions) : ['dashboard.view'];
  const targetIsOwner = target ? isOwner(target) : false;
  const selfEdit = target && target.id === ctx.user.id;
  return `<section class="panel"><h2>员工账号</h2><p>负责人拥有全部权限；其他账号按权限键授权。连续 5 次登录失败的账号将锁定 15 分钟。</p>
<table><thead><tr><th>邮箱</th><th>姓名</th><th>权限</th><th>操作</th></tr></thead><tbody>
${rows.map(r => `<tr><td>${e(r.email)}${r.id === ctx.user.id ? '（当前登录）' : ''}</td><td>${e(r.name)}</td><td>${isOwner(r) ? '负责人（全部权限）' : e(parsePermissions(r.permissions).map(k => PERMISSION_KEYS.find(d => d.key === k)?.label || k).join('、')) || '无权限'}</td><td><a href="/admin/staff?id=${r.id}">编辑</a></td></tr>`).join('')}
</tbody></table></section>
<section class="panel"><h2>${target ? '编辑账号' : '新增账号'}</h2>
<form method="post" action="/admin/staff/save" class="stack">${csrf(ctx.session)}
${target ? `<input type="hidden" name="id" value="${target.id}">` : ''}
<label>邮箱<input name="email" type="email" required maxlength="200" value="${e(target?.email || '')}" ${target ? 'readonly' : ''}></label>
<label>姓名<input name="name" required maxlength="100" value="${e(target?.name || '')}"></label>
<label>密码${target ? '（留空保持不变）' : ''}<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" ${target ? '' : 'required'} placeholder="至少 12 位"></label>
${selfEdit ? '<p class="error-text">不能在此修改自己的权限；如需调整请由其他负责人操作。</p>' : `<fieldset><legend>权限</legend><label class="inline"><input type="checkbox" name="permissions" value="owner" ${targetIsOwner ? 'checked' : ''}>负责人（全部权限，最后一个负责人不可降级或删除）</label>${PERMISSION_KEYS.map(k => `<label class="inline"><input type="checkbox" name="permissions" value="${k.key}" ${targetPerms.includes(k.key) ? 'checked' : ''}>${e(k.label)}</label>`).join('')}</fieldset>`}
<div class="actions"><button class="button">${target ? '保存修改' : '创建账号'}</button>${target ? `<a class="button secondary" href="/admin/staff">取消编辑</a>` : ''}</div>
</form></section>
${target && !selfEdit ? `<section class="panel"><h2>删除账号</h2><form method="post" action="/admin/staff/delete">${csrf(ctx.session)}<input type="hidden" name="id" value="${target.id}"><button class="danger">删除 ${e(target.email)}</button></form></section>` : ''}`;
}
