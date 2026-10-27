import { referenceTeams } from './team-taxonomy.mjs';
import { localizedCountryAliases } from './country-names.mjs';
export const normalizeSearch=value=>String(value||'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
const extra={
 arsenal:['阿森纳','阿仙奴','兵工厂'],paris:['巴黎圣日耳曼','巴黎聖日耳門','PSG','Paris Saint-Germain'],bayern:['拜仁','Bayern Munich','Bayern München'],barcelona:['巴萨','巴薩','Barca','Barcelona'],naples:['Napoli'],rome:['Roma'],florentine:['Fiorentina'],venice:['Venezia'],dortmund:['Borussia Dortmund'],leipzig:['RB Leipzig'],leverkusen:['Bayer Leverkusen'],tottenham:['热刺','熱刺','Tottenham Hotspur'],france:['法国','法國','France'],germany:['德国','德國','Germany'],england:['英格兰','英格蘭','England'],japan:['日本','Japan'],italy:['意大利','義大利','Italy'],netherlands:['荷兰','荷蘭','Holland'],brazil:['巴西','Brazil'],portugal:['葡萄牙','Portugal'],spain:['西班牙','Spain'],turkiye:['Turkey','Türkiye'], 'saudi-arabian':['沙特','Saudi Arabia'],
 '2026-27-season':['2026-27','2026/27','2026-27赛季'], '2025-26-season':['2025-26','2025/26','2025-26赛季'],retro:['复古','復古','retro'], 'kids-size':['儿童','兒童','童装','kids','children'], 'autumn-and-winter-series':['秋冬','autumn','winter'], 'trench-coat':['风衣','風衣','windbreaker','jacket'], 'shorts-f9eg':['短裤','短褲','shorts']
};
const synonyms=[['球衣','球衫','jersey','shirt','kit'],['主场','主場','home'],['客场','客場','away'],['训练','訓練','training'],['球迷版','fan','fans'],['长袖','長袖','long sleeve'],['短袖','short sleeve']];
export const collectionAliases=Object.fromEntries(Object.values(referenceTeams).flat().map(([slug,name])=>[slug,[name,slug.replaceAll('-',' '),...(extra[slug]||[])]]));
for(const [slug,names]of Object.entries(extra))collectionAliases[slug]=[...(collectionAliases[slug]||[]),...names];
const canonicalAliases=Object.fromEntries(Object.entries(collectionAliases).map(([slug,names])=>[slug,[...names]]));
for(const [slug,names]of Object.entries(localizedCountryAliases))collectionAliases[slug]=[...new Set([...(collectionAliases[slug]||[]),...names])];
const aliasNames=new Set(Object.values(collectionAliases).flat().map(normalizeSearch));
export function searchTerms(value){
  const query=normalizeSearch(value).slice(0,100);
  // Preserve multiword country names, including when followed by another search term.
  if(aliasNames.has(query))return [query];
  const tokens=query.split(' ').filter(Boolean),terms=[];
  for(let start=0;start<tokens.length&&terms.length<10;){let end=tokens.length;while(end>start+1&&!aliasNames.has(tokens.slice(start,end).join(' ')))end--;terms.push(tokens.slice(start,end).join(' '));start=end;}
  return terms;
}
export function expandSearchTerm(term,collections){
  const words=new Set([term]),ids=[];
  for(const c of collections){const aliases=[c.name,c.slug,c.slug.replaceAll('-',' '),...(collectionAliases[c.slug]||[])];if(aliases.some(name=>normalizeSearch(name)===term)){ids.push(c.id);for(const alias of [c.name,c.slug,c.slug.replaceAll('-',' '),...(canonicalAliases[c.slug]||[])]){const value=normalizeSearch(alias);if(value.length>=3||/[\u3400-\u9fff]/.test(value))words.add(value);}}}
  for(const group of synonyms)if(group.some(name=>normalizeSearch(name)===term))for(const name of group)words.add(normalizeSearch(name));
  return {words:[...words],ids};
}
export const literalLike=value=>'%'+value.replace(/[\\%_]/g,char=>'\\'+char)+'%';
