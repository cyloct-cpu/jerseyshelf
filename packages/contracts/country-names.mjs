import { languages } from './locales.mjs';
// Country names come from the runtime's Unicode locale data, without a translation API.
export const countryRegions={germany:'DE',france:'FR',portugal:'PT',belgium:'BE',denmark:'DK',spain:'ES',turkiye:'TR',switzerland:'CH',italy:'IT',netherlands:'NL',croatia:'HR',sweden:'SE',finland:'FI',ireland:'IE',poland:'PL',argentina:'AR',jamaica:'JM',uruguay:'UY',brazil:'BR',paraguay:'PY',chile:'CL',mexico:'MX',canada:'CA',panama:'PA',guatemala:'GT',morocco:'MA',senegal:'SN',tunisia:'TN',algeria:'DZ','ivory-coast':'CI',cameroon:'CM',ghana:'GH',egypt:'EG',nigeria:'NG','south-korea':'KR',japan:'JP',iraq:'IQ',qatar:'QA',iran:'IR',australia:'AU','saudi-arabian':'SA',jordan:'JO',norway:'NO'};
export const localizedCountryAliases=Object.fromEntries(Object.keys(countryRegions).map(slug=>[slug,new Set()]));
for(const [locale]of languages){
  const names=new Intl.DisplayNames([locale],{type:'region'});
  for(const [slug,region]of Object.entries(countryRegions))localizedCountryAliases[slug].add(names.of(region));
}
// England and Wales are national-team categories rather than ISO country regions.
localizedCountryAliases.england=new Set(['England','英格兰','英格蘭','Angleterre','Inglaterra','Inghilterra','Engeland','Англия','Англія','イングランド','잉글랜드','إنجلترا']);
localizedCountryAliases.wales=new Set(['Wales','威尔士','威爾斯','Cymru','Pays de Galles','Gales','Galles','Уэльс','Уельс','ウェールズ','웨일스','ويلز']);
