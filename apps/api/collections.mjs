import { db, now, audit, transaction, settings, putSetting } from './db.mjs';
import { text, int, slug, localImage, InputError } from '../../packages/contracts/validation.mjs';
import { validTeamGroup } from '../../packages/contracts/team-taxonomy.mjs';
import { recordCollectionChange } from './catalog-sync.mjs';
export function listCollections(query={}) {
  const deleted=query.status==='deleted';const filters=[deleted?'c.deleted_at IS NOT NULL':'c.deleted_at IS NULL'];const args=[];
  if(query.q){filters.push('(c.name LIKE ? OR c.slug LIKE ?)');args.push('%'+String(query.q).slice(0,100)+'%','%'+String(query.q).slice(0,100)+'%');}
  if(['national','club','other'].includes(query.kind)){filters.push('c.kind=?');args.push(query.kind);}
  if(query.team_group){filters.push('c.team_group=?');args.push(String(query.team_group));}
  return db.prepare('SELECT c.*,(SELECT COUNT(*) FROM product_collections pc WHERE pc.collection_id=c.id) product_count FROM collections c WHERE '+filters.join(' AND ')+' ORDER BY c.position,c.id').all(...args);
}
export function saveCollection(input,user) {
  const id=input.id?int(input.id,'分类 ID',1):null;
  const name=text(input.name,'分类名称',100),identifier=slug(input.slug),kind=text(input.kind,'分组',20),position=int(input.position||0,'排序',0,100000),image=localImage(input.image||''),featured=input.home_featured==='1'?1:0;
  if(!['national','club','other'].includes(kind))throw new InputError('分类分组错误');
  const oldGroup=id?db.prepare('SELECT kind,team_group FROM collections WHERE id=?').get(id):null;
  const group=input.team_group===undefined?(oldGroup?.kind===kind?oldGroup.team_group:''):text(input.team_group,'洲/联赛',40,false);
  if(!validTeamGroup(kind,group))throw new InputError('洲/联赛与分类类型不匹配');
  if(image&&!db.prepare('SELECT id FROM media WHERE path=?').get(image))throw new InputError('图片未导入媒体库');
  return transaction(()=>{
    let cid=id;
    if(id){const old=db.prepare('SELECT * FROM collections WHERE id=? AND deleted_at IS NULL').get(id);if(!old)throw new InputError('分类不存在或已删除',404);
      db.prepare('UPDATE collections SET slug=?,name=?,kind=?,position=?,image=?,home_featured=? WHERE id=?').run(identifier,name,kind,position,image,featured,id);
      if(old.slug!==identifier){const home=settings().home;for(const s of home.sections)if(s.slug===old.slug)s.slug=identifier;for(const s of [...home.slides,...(home.extraImages||[])])if(s.href==='/collections/'+old.slug)s.href='/collections/'+identifier;putSetting('home',home);}
    }else cid=Number(db.prepare('INSERT INTO collections(slug,name,kind,position,image,home_featured) VALUES(?,?,?,?,?,?)').run(identifier,name,kind,position,image,featured).lastInsertRowid);
    db.prepare('UPDATE collections SET team_group=? WHERE id=?').run(group,cid);
    audit(user,id?'collection.update':'collection.create',cid);recordCollectionChange(cid);return cid;
  });
}
export function changeCollectionState(id,restore,user) {
  id=int(id,'分类 ID',1);
  return transaction(()=>{
    const c=db.prepare('SELECT * FROM collections WHERE id=?').get(id);if(!c)throw new InputError('分类不存在',404);
    if(restore?!c.deleted_at:!!c.deleted_at)throw new InputError(restore?'分类已经恢复':'分类已经删除');
    db.prepare('UPDATE collections SET deleted_at=? WHERE id=?').run(restore?null:now(),id);
    audit(user,restore?'collection.restore':'collection.delete',id);recordCollectionChange(id);
  });
}
