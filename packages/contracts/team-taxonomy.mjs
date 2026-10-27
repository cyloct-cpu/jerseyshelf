// Menu groups and ordering follow the supplied reference screenshots.
export const teamGroups={
  national:[['europe','欧洲'],['america','美洲'],['africa','非洲'],['asia','亚洲']],
  club:[['serie-a','意甲'],['premier-league','英超联赛'],['ligue-1','法甲联赛'],['bundesliga','德甲'],['la-liga','西甲']]
};
export const referenceTeams={
  europe:[['germany','德国'],['france','法国'],['portugal','葡萄牙'],['belgium','比利时'],['denmark','丹麦'],['england','英格兰'],['spain','西班牙'],['wales','威尔士'],['turkiye','土耳其'],['switzerland','瑞士'],['italy','意大利'],['netherlands','荷兰'],['croatia','克罗地亚'],['sweden','瑞典'],['finland','芬兰'],['ireland','爱尔兰'],['poland','波兰']],
  america:[['argentina','阿根廷'],['jamaica','牙买加'],['uruguay','乌拉圭'],['brazil','巴西'],['paraguay','巴拉圭'],['chile','智利'],['mexico','墨西哥'],['canada','加拿大'],['panama','巴拿马'],['guatemala','危地马拉']],
  africa:[['morocco','摩洛哥'],['senegal','塞内加尔'],['tunisia','突尼斯'],['algeria','阿尔及利亚'],['ivory-coast','科特迪瓦'],['cameroon','喀麦隆'],['ghana','加纳'],['egypt','埃及'],['nigeria','尼日利亚']],
  asia:[['south-korea','韩国'],['japan','日本'],['iraq','伊拉克'],['qatar','卡塔尔'],['iran','伊朗'],['australia','澳大利亚'],['saudi-arabian','沙特阿拉伯'],['jordan','约旦']],
  'serie-a':[['ac-milan','AC米兰'],['inter-milan','国际米兰'],['juventus','尤文图斯'],['naples','那不勒斯'],['rome','罗马'],['florentine','佛罗伦萨'],['venice','威尼斯'],['lazio','拉齐奥'],['parma','帕尔马']],
  'premier-league':[['arsenal','兵工厂'],['manchester-city','曼城'],['manchester-united','曼联'],['chelsea','切尔西'],['liverpool','利物浦'],['tottenham','托特纳姆热刺'],['newcastle-united','纽卡斯尔联队'],['aston-villa','阿斯顿维拉'],['leeds-united','利兹联队'],['west-ham-united','西汉姆联'],['wolverhampton','伍尔弗汉普顿'],['wanderers','流浪者队'],['crystal-palace','水晶宫'],['nottingham','诺丁汉'],['forest','森林'],['brighton','布莱顿'],['rangers','游骑兵队']],
  'ligue-1':[['paris','巴黎'],['marseille','马赛'],['lyon','里昂']],
  bundesliga:[['bayern','拜仁慕尼黑'],['dortmund','多特蒙德'],['leipzig','莱比锡'],['leverkusen','勒沃库森']],
  'la-liga':[['barcelona','巴塞罗那'],['real-madrid','皇家马德里'],['atletico-madrid','马德里竞技'],['athletic-bilbao','毕尔巴鄂竞技'],['real-betis','皇家贝蒂斯'],['seville','塞维利亚'],['celtic','凯尔特人']]
};
export function validTeamGroup(kind,key){return !key || teamGroups[kind]?.some(([value])=>value===key) || (kind==='club' && key==='other-clubs');}
export function teamGroupLabel(kind,key){return teamGroups[kind]?.find(([value])=>value===key)?.[1]||(key==='other-clubs'?'其他俱乐部':'未分组');}
export function defaultTeamGroup(slug,kind){return Object.entries(referenceTeams).find(([key,teams])=>teams.some(([value])=>value===slug) && teamGroups[kind]?.some(([value])=>value===key))?.[0]||'';}
