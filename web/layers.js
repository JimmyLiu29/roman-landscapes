const circle = (id,color,radius,priority) => ({id,type:'circle',priority,
  paint:{'circle-color':color,'circle-radius':radius,'circle-stroke-width':0.6,'circle-stroke-color':'#faf7ef'}});
const ferry=['==',['get','ferry'],true];
const tentative=['any',ferry,['==',['get','certainty'],'Hypothetical']];
const ranked = (one,two,three,other) => ['match',['get','rank'],'1',one,'2',two,'3',three,other];
const scale = (...stops) => ['interpolate',['linear'],['zoom'],...stops];
const roadClass = (certain,conjectured) => ['match',['get','certainty'],'Certain',certain,conjectured];
const coastal = ['==',['get','t'],'coastal'];
const crossing = (overseas,slowover,ferryValue) =>
  ['match',['get','t'],'overseas',overseas,'slowover',slowover,ferryValue];
const auto = {id:'auto',label:'Auto by zoom'};
const town = circle('settlements','#883d39',scale(
  3,ranked(4.2,2.5,1.9,1.4),5,ranked(5.4,3.8,2.8,2.1),7,ranked(6.8,5,3.8,2.8)),0);
town.paint['circle-stroke-width']=scale(
  3,ranked(0.75,0.5,0.35,0.25),5,ranked(1.1,0.8,0.55,0.35),7,ranked(1.6,1.1,0.75,0.5));
town.layout={'circle-sort-key':ranked(3,2,1,0)};
const groups = [
  {id:'settlements',scope:'hanson-cities',title:'Settlements',
    tier:{field:'rank',initial:'auto',options:[
      auto, {id:'all',label:'All settlements'},
      {id:'medium',label:'Major & medium cities · Ranks 1–3',values:['1','2','3']},
      {id:'major',label:'Major centers only · Ranks 1–2',values:['1','2']},
      {id:'metropoleis',label:'Barrington Atlas Rank 1 only',values:['1']}],
      atZoom:z=>z<4.5?'major':z<5.6?'medium':'all'},
    sources:[{id:'settlements',styles:[town]}],
    legend:[['rank1','Rank 1',['1']],['rank2','Rank 2',['2']],['rank3','Rank 3',['3']],
      ['rank4','Rank 4–5 / unranked',['4 or 5','-']]]},
  {id:'roads',scope:'itinere',title:'Terrestrial roads',
    tier:{field:'certainty',initial:'auto',atZoom:z=>z<5?'probable':'all',options:[auto,{id:'all',label:'All roads & connectors'},
      {id:'probable',label:'Certain & conjectured roads',values:['Certain','Conjectured']},
      {id:'certain',label:'Certain backbone roads only',values:['Certain']}]},

    sources:[{id:'roads',styles:[
      {id:'roads',type:'line',priority:2,filter:['!',tentative],paint:{
        'line-width':scale(3,roadClass(1.25,0.42),5,roadClass(1.8,0.85),7,roadClass(2.4,1.45)),
        'line-opacity':scale(3,roadClass(0.88,0.32),5,roadClass(0.94,0.62),7,roadClass(1,0.85)),
        'line-color':['match',['get','certainty'],'Certain','#794321','#ac794e']}},
      {id:'roads-tentative',type:'line',priority:2,filter:tentative,paint:{
        'line-width':scale(3,['case',ferry,0.8,0.55],7,['case',ferry,1.5,1.15]),
        'line-opacity':scale(3,0.5,7,0.85),'line-color':['case',ferry,'#806d63','#b99275'],'line-dasharray':[2,2]}}
    ]}],legend:[['certain','Certain road',['Certain']],['conjectured','Conjectured road',['Conjectured']],
      ['tentative','Hypothetical road',['Hypothetical']],['ferry','Temporary ferry connector',['Conjectured']]]},
  {id:'maritime',scope:'orbis-maritime',title:'Maritime routes',
    tier:{field:'t',initial:'auto',atZoom:z=>z<5.2?'primary-network':'all',options:[auto,{id:'all',label:'All maritime routes'},
      {id:'primary-network',label:'Primary network · overseas + coastal + ferry',values:['overseas','coastal','ferry']},
      {id:'open',label:'Open-sea & ferry crossings · overseas + slowover + ferry',values:['overseas','slowover','ferry']},
      {id:'overseas-ferry',label:'Direct open-sea & ferry only · overseas + ferry',values:['overseas','ferry']}]},

    sources:[{id:'maritime',unit:'routes',styles:[
      {id:'maritime-coastal',type:'line',priority:3,filter:coastal,paint:{
        'line-color':'#6796b6','line-width':scale(3,0.55,7,1.25),'line-opacity':scale(3,0.38,7,0.75)}},
      {id:'maritime',type:'line',priority:3,filter:['!',coastal],paint:{
        'line-color':'#24548d','line-width':scale(3,crossing(1.2,0.9,1),7,crossing(2.2,1.55,1.7)),
        'line-opacity':scale(3,crossing(0.72,0.5,0.64),7,crossing(0.9,0.7,0.88)),'line-dasharray':[4,2]}}]},
      {id:'ports',unit:'ports',switchLabel:'Maritime ports',styles:[circle('ports','#296f79',3.1,1)]}],
    legend:[['shipping','Open-sea / ferry',['overseas','ferry']],['slowover','Slow open sea',['slowover']],
      ['coastal','Coastal',['coastal']],['port','Ports',null,'ports']]},
  ...[
    ['economy','Economic evidence','#9d4c24'],
    ['people-biography','People: birth, death & burial','#7b4193'],
    ['people','People: activity & events','#007c82'],
    ['events','Historical events','#c43544']
  ].map(([id,title,color])=>({
    id,title,sources:[{id,styles:[circle(id,color,4,0)]}],legend:[[id,title]]
  }))
];

export const economyColors = {
  'Mining and metals':'#805023', 'Shipwrecks and cargo':'#1266a2',
  'Amphorae and commodities':'#b34155', 'Fiscal records':'#5b4392',
  'Oil and wine production':'#497528'
};
const economy = groups.find(group=>group.id==='economy');
economy.sources[0].styles[0].paint['circle-color'] =
  ['match',['get','category'],...Object.entries(economyColors).flat(),'#626262'];
economy.legend = Object.keys(economyColors).map((name,i)=>['economic-'+i,name]);
const drawOrder = ['maritime','roads','ports','settlements','economy','people-biography','people','events'];
const pickOrder = ['settlements','ports','events','people','people-biography','economy','roads','maritime'];
const credits = {maritime:'Stanford ORBIS v2',roads:'Itiner-e v1.3',settlements:'Oxford Hanson Cities',economy:'OxREP · RAAD'};

export function registry(release) {
  const {datasets, archives, files} = release;
  const names = new Set(files.map(f=>f.path.split('/').at(-1)));
  const active = groups.filter(group=>{
    const dataset = group.scope ? datasets.some(d=>d.id===group.scope) :
      group.id==='economy' ? datasets.some(d=>d.group==='economy' && !d.archive_only) :
      datasets.some(d=>d.id==='wikidata-history');
    return dataset && group.sources.every(s=>names.has(s.id+'.geojson.gz'));
  }).map(group=>({...group,defaultVisible:Boolean(group.scope),attribution:credits[group.id] || 'Wikidata',
    sources:group.sources.map(file=>({...file,drawOrder:drawOrder.indexOf(file.id),pickPriority:pickOrder.indexOf(file.id)}))}));
  return {datasets,archives,groups:active};
}
