import { escape as e } from '../api/security.mjs';
import { teamGroups, teamGroupLabel } from '../../packages/contracts/team-taxonomy.mjs';
export function groupOptions(selected=''){
  return `<option value="">未分组 / 不适用</option>${Object.entries(teamGroups).map(([kind,groups])=>`<optgroup label="${kind==='national'?'国家队 · 洲':'俱乐部 · 联赛'}">${groups.map(([key,label])=>`<option value="${key}" data-kind="${kind}" ${selected===key?'selected':''}>${label}</option>`).join('')}${kind==='club'?`<option value="other-clubs" data-kind="club" ${selected==='other-clubs'?'selected':''}>其他俱乐部</option>`:''}</optgroup>`).join('')}`;
}
export function productCollectionGroups(cats,selected){
  const sections=[];
  for(const kind of ['national','club','other']){
    const groups=kind==='other'?[['','商品系列']]:[...teamGroups[kind],...(kind==='club'?[['other-clubs','其他俱乐部'],['','未分组']]:[['','其他国家队']])];
    for(const [key,label]of groups){const items=cats.filter(c=>c.kind===kind&&(kind==='other'||(c.team_group||'')===key));if(!items.length)continue;
      sections.push(`<section class="collection-choice-group" data-choice-group><h3>${kind==='national'?'国家队 · ':kind==='club'?'俱乐部 · ':''}${e(label)}</h3><div class="checks">${items.map(c=>`<label data-category="${e(c.name+' '+c.slug+' '+teamGroupLabel(c.kind,c.team_group))}"><input type="checkbox" name="collections" data-collection-kind="${e(c.kind)}" value="${c.id}" ${selected.has(c.id)?'checked':''}>${e(c.name)}</label>`).join('')}</div></section>`);
    }
  }return sections.join('');
}
