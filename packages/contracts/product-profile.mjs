// Imported products do not always have a clothing-type collection. Use both
// original Chinese titles and English source slugs to recognize common types.
export function productProfile(title='',slug=''){
  const value=(title+' '+slug).toLowerCase().replaceAll('-',' ');
  const kind=/windbreaker|trench|jacket|coat|风衣|夹克|外套|羽绒/.test(value)?'jacket':
    /sweatshirt|hoodie|卫衣/.test(value)?'sweatshirt':
    /training|tracksuit|track suit|训练|运动套装/.test(value)?'training':
    /shorts|短裤/.test(value)?'shorts':
    /jersey|kit|球衣/.test(value)?'jersey':'other';
  return {kind,kids:/kids|children|child|junior|儿童|童装/.test(value),retro:/retro|vintage|复古/.test(value)};
}
export function profileSimilarity(a,b){return (a.kind===b.kind?100:0)+(a.kids===b.kids?5:0)+(a.retro===b.retro?3:0);}
