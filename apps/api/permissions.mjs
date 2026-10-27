import { db, audit, now } from './db.mjs';
import { InputError, email as validEmail, text } from '../../packages/contracts/validation.mjs';
import { passwordHash } from './security.mjs';

export const PERMISSION_KEYS = [
  { key: 'dashboard.view', label: '后台访问（概览、商品、媒体等只读页面）' },
  { key: 'products.edit', label: '商品、分类、定制、推荐与批量导入' },
  { key: 'orders.view', label: '订单与售后查看' },
  { key: 'orders.edit', label: '订单操作、物流与货到付款' },
  { key: 'customers.view', label: '客户管理与联系' },
  { key: 'settings.edit', label: '站点设置、翻译、汇率与接口配置' },
  { key: 'data.export', label: '导出客户与订单数据' },
  { key: 'staff.manage', label: '员工账号与权限管理' }
];
const KEY_LABELS = { owner: '负责人（全部权限）', ...Object.fromEntries(PERMISSION_KEYS.map(k => [k.key, k.label])) };
const VALID = new Set(Object.keys(KEY_LABELS));

export function parsePermissions(raw) {
  let list;
  try { list = JSON.parse(raw || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(k => VALID.has(k)))];
}

export function effectivePermissions(user) {
  if (!user || user.role !== 'admin') return new Set();
  const list = parsePermissions(user.permissions);
  if (list.includes('owner')) return new Set([...VALID]);
  return new Set(list);
}

export function hasPerm(user, key) { return effectivePermissions(user).has(key); }

export function requirePerm(user, key) {
  if (!hasPerm(user, key)) {
    audit(user?.id ?? null, 'permission.denied', key);
    throw new InputError('没有执行此操作的权限（' + (KEY_LABELS[key] || key) + '）', 403);
  }
}

// 后台路径 → 所需权限键。返回 null 表示仅需管理员角色（不额外限制）。
// GET 页面按最小可见性控制，POST 写操作按业务域控制。
const POST_RULES = [
  ['/admin/staff/', 'staff.manage'],
  ['/admin/settings/', 'settings.edit'],
  ['/admin/home/', 'settings.edit'],
  ['/admin/pages/', 'settings.edit'],
  ['/admin/currencies/', 'settings.edit'],
  ['/admin/promotions/', 'settings.edit'],
  ['/admin/translations/', 'settings.edit'],
  ['/admin/payments/', 'settings.edit'],
  ['/admin/email/', 'settings.edit'],
  ['/admin/sync/', 'settings.edit'],
  ['/admin/oauth/', 'settings.edit'],
  ['/admin/image-search/', 'settings.edit'],
  ['/admin/whatsapp/config', 'settings.edit'],
  ['/admin/whatsapp/check', 'settings.edit'],
  ['/admin/whatsapp/messages', 'customers.view'],
  ['/admin/whatsapp/revoke', 'customers.view'],
  ['/admin/cod/export', 'data.export'],
  ['/admin/cod/', 'orders.edit'],
  ['/admin/oms/', 'orders.edit'],
  ['/admin/tracking17/', 'orders.edit'],
  ['/admin/shipments/', 'orders.edit'],
  ['/admin/orders/', 'orders.edit'],
  ['/admin/service/attachment', 'orders.edit'],
  ['/admin/service/rules', 'orders.edit'],
  ['/admin/service/', 'orders.edit'],
  ['/admin/customers/config', 'settings.edit'],
  ['/admin/customers/export', 'data.export'],
  ['/admin/customers/', 'customers.view'],
  ['/admin/media/upload', 'products.edit'],
  ['/admin/import', 'products.edit'],
  ['/admin/import/', 'products.edit'],
  ['/admin/products/', 'products.edit'],
  ['/admin/collections/', 'products.edit'],
  ['/admin/customization/', 'products.edit'],
  ['/admin/recommendations/', 'products.edit']
];
const GET_RULES = [
  ['/admin/staff', 'staff.manage'],
  ['/admin/audit', 'staff.manage'],
  ['/admin/settings', 'settings.edit'],
  ['/admin/translations', 'settings.edit'],
  ['/admin/image-search', 'settings.edit'],
  ['/admin/whatsapp', 'settings.edit'],
  ['/admin/customers/export.csv', 'data.export'],
  ['/admin/subscribers.csv', 'data.export'],
  ['/admin/customers/status.json', 'customers.view'],
  ['/admin/customers/', 'customers.view'],
  ['/admin/orders/', 'orders.view'],
  ['/admin/service/stats.json', 'orders.view'],
  ['/admin/service/attachment/', 'orders.edit'],
  ['/admin/cod/stats.json', 'orders.view'],
  ['/admin/cod/template.csv', 'orders.edit'],
  ['/admin/cod/', 'orders.view'],
  ['/admin/oms', 'orders.edit'],
  ['/admin/translations/status.json', 'settings.edit']
];

function matchRules(rules, pathname) {
  for (const [prefix, key] of rules) {
    if (prefix.endsWith('/')) { if (pathname.startsWith(prefix) || pathname === prefix.slice(0, -1)) return key; }
    else if (pathname === prefix) return key;
  }
  return null;
}

export function adminPermission(pathname, method) {
  if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return null;
  if (method === 'POST') return matchRules(POST_RULES, pathname);
  if (method === 'GET') {
    // 订单详情等只读订单页需要 orders.view；其余未列出的后台页面仅需 dashboard.view。
    return matchRules(GET_RULES, pathname) ?? (pathname === '/admin' || pathname.startsWith('/admin/') ? 'dashboard.view' : null);
  }
  return null;
}

const adminRows = () => db.prepare("SELECT id,email,name,permissions FROM users WHERE role='admin'").all();
const isOwner = row => parsePermissions(row.permissions).includes('owner');

export function saveStaff(input, actorId) {
  const id = input.id ? Number(input.id) : 0;
  const raw = [].concat(input.permissions || []);
  let perms = [...new Set(raw.filter(p => typeof p === 'string' && VALID.has(p)))];
  if (perms.includes('owner')) perms = ['owner'];
  if (!perms.length) throw new InputError('请至少勾选一项权限');
  const name = text(input.name, '姓名', 100);
  const password = typeof input.password === 'string' ? input.password : '';
  if (id) {
    const existing = db.prepare("SELECT * FROM users WHERE id=? AND role='admin'").get(id);
    if (!existing) throw new InputError('账号不存在', 404);
    if (password && password.length < 12) throw new InputError('密码至少 12 位');
    if (id === actorId && JSON.stringify(parsePermissions(existing.permissions)) !== JSON.stringify(perms))
      throw new InputError('不能修改自己的权限，请由其他负责人操作');
    if (isOwner(existing) && !perms.includes('owner') && adminRows().filter(isOwner).length <= 1)
      throw new InputError('最后一个负责人不能降级，请先新增另一位负责人');
    db.prepare('UPDATE users SET name=?,permissions=?,password=? WHERE id=?').run(name, JSON.stringify(perms), password ? passwordHash(password) : existing.password, id);
    audit(actorId, 'staff.save', existing.email);
    return id;
  }
  const login = validEmail(input.email);
  if (password.length < 12) throw new InputError('密码至少 12 位');
  if (db.prepare('SELECT id FROM users WHERE email=?').get(login)) throw new InputError('该邮箱已是账号', 409);
  const newId = Number(db.prepare("INSERT INTO users(email,password,name,role,permissions,created_at) VALUES(?,?,?,'admin',?,?)").run(login, passwordHash(password), name, JSON.stringify(perms), now()).lastInsertRowid);
  audit(actorId, 'staff.create', login);
  return newId;
}

export function deleteStaff(input, actorId) {
  const id = Number(input.id || 0);
  const existing = db.prepare("SELECT * FROM users WHERE id=? AND role='admin'").get(id);
  if (!existing) throw new InputError('账号不存在', 404);
  if (id === actorId) throw new InputError('不能删除自己的账号');
  if (isOwner(existing) && adminRows().filter(isOwner).length <= 1) throw new InputError('最后一个负责人账号不能删除');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  audit(actorId, 'staff.delete', existing.email);
  return id;
}
