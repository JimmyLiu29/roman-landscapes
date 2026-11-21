// Source IDs govern catalog membership. Scope keys govern visible groups and their files.
const foundation = [
  ['hanson-cities', 'Hanson Cities'], ['itinere', 'Itiner-e'],
  ['orbis-maritime', 'ORBIS Maritime'], ['pleiades', 'Pleiades']
].map(([id,label])=>({id,label,scope:id}));

const circle = (id,color,radius,priority) => ({id,type:'circle',priority,
  paint:{'circle-color':color,'circle-radius':radius,'circle-stroke-width':0.6,'circle-stroke-color':'#faf7ef'}});
const ferry=['==',['get','ferry'],true];
const tentative=['any',ferry,['==',['get','certainty'],'Hypothetical']];
const ranked = (one,two,three,other) => ['match',['get','rank'],'1',one,'2',two,'3',three,other];
const town = circle('settlements','#883d39',ranked(6,4.6,3.4,2.5),0);
town.paint['circle-stroke-width']=ranked(1.6,1.1,0.7,0.4);
town.layout={'circle-sort-key':ranked(3,2,1,0)};
const seaTypes = ['overseas','slowover','ferry'];
const groups = [
  {id:'settlements',scope:'hanson-cities',title:'Settlements',
    tier:{field:'rank',initial:'auto',options:[
      {id:'auto',label:'Auto by zoom'}, {id:'all',label:'All settlements'},
      {id:'medium',label:'Major & medium cities · Ranks 1–3',values:['1','2','3']},
      {id:'major',label:'Major centers only · Ranks 1–2',values:['1','2']}],
      atZoom:z=>z<4?'major':z<5?'medium':'all'},
    sources:[{id:'settlements',styles:[town]}],
    legend:[['rank1','Rank 1',['1']],['rank2','Rank 2',['2']],['rank3','Rank 3',['3']],
      ['rank4','Rank 4–5 / unranked',['4 or 5','-']]]},
  {id:'roads',scope:'itinere',title:'Terrestrial roads',
    tier:{field:'certainty',initial:'all',options:[{id:'all',label:'All roads & connectors'},
      {id:'probable',label:'Certain & conjectured roads',values:['Certain','Conjectured']},
      {id:'certain',label:'Certain backbone roads only',values:['Certain']}]},

    sources:[{id:'roads',styles:[
      {id:'roads',type:'line',priority:2,filter:['!',tentative],paint:{
        'line-width':['match',['get','certainty'],'Certain',2.3,1.35],
        'line-color':['match',['get','certainty'],'Certain','#794321','#ac794e']}},
      {id:'roads-tentative',type:'line',priority:2,filter:tentative,paint:{
        'line-width':['case',ferry,1.5,1.15],'line-color':['case',ferry,'#806d63','#b99275'],'line-dasharray':[2,2]}}
    ]}],legend:[['certain','Certain road',['Certain']],['conjectured','Conjectured road',['Conjectured']],
      ['tentative','Hypothetical road',['Hypothetical']],['tentative','Ferry connector',['Conjectured']]]},
  {id:'maritime',scope:'orbis-maritime',title:'Maritime routes',
    tier:{field:'t',initial:'open',options:[{id:'all',label:'All maritime routes'},
      {id:'open',label:'Open-sea & ferry routes · overseas + slowover + ferry',values:seaTypes},
      {id:'primary',label:'Primary open-sea & ferry only · overseas + ferry',values:['overseas','ferry']}]},

    sources:[{id:'maritime',unit:'routes',styles:[{id:'maritime',type:'line',priority:3,
      paint:{'line-color':'#24548d','line-width':['match',['get','t'],'overseas',2.4,'coastal',1.1,1.7],
        'line-opacity':['match',['get','t'],'coastal',0.55,'slowover',0.75,0.95],'line-dasharray':[4,2]}}]},
      {id:'ports',unit:'ports',switchLabel:'Maritime ports',styles:[circle('ports','#296f79',3.1,1)]}],
    legend:[['shipping','Open-sea / ferry',['overseas','ferry']],['slowover','Slow open sea',['slowover']],
      ['coastal','Coastal',['coastal']],['port','Ports',null,'ports']]},
  ...[['economy','Economic evidence','#784d84'],['events','Events','#9b563b'],
      ['people','People','#62699a'],['people-biography','Biographical places','#57825f']].map(([id,title,color])=>({
    id,scope:id,title,categoryFilter:true,sources:[{id,styles:[circle(id,color,3,4)]}],legend:[[id,title]]
  }))
];

export function registry(release) {
  const scope=new Set(release.scope || []);
  const datasets=(release.datasets || foundation).filter(d=>scope.has(d.scope ?? d.id));
  const activeGroups=groups.filter(g=>scope.has(g.scope));
  const reports={economy:'economy-report.json',events:'history-report.json',people:'history-report.json',
    'people-biography':'history-report.json'};
  const optionalFiles=new Set(activeGroups.map(group=>reports[group.id]).filter(Boolean));
  return {datasets,groups:activeGroups,optionalFiles};
}
