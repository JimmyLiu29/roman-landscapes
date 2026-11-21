// Source IDs govern catalog membership. Scope keys govern visible groups and their files.
const foundation = [
  ['hanson-cities', 'Hanson Cities'], ['itinere', 'Itiner-e'],
  ['orbis-maritime', 'ORBIS Maritime'], ['pleiades', 'Pleiades']
].map(([id,label])=>({id,label,scope:id}));

const circle = (id,color,radius,priority) => ({id,type:'circle',priority,
  paint:{'circle-color':color,'circle-radius':radius,'circle-stroke-width':0.6,'circle-stroke-color':'#faf7ef'}});
const ferry=['==',['get','ferry'],true];
const tentative=['any',ferry,['==',['get','certainty'],'Hypothetical']];
const groups = [
  {id:'settlements',scope:'hanson-cities',title:'Settlements',
    sources:[{id:'settlements',styles:[circle('settlements','#883d39',3.4,0)]}],
    legend:[['settlement','Settlements']]},
  {id:'roads',scope:'itinere',title:'Terrestrial roads',
    sources:[{id:'roads',styles:[
      {id:'roads',type:'line',priority:2,filter:['!',tentative],paint:{
        'line-width':['match',['get','certainty'],'Certain',2.3,1.35],
        'line-color':['match',['get','certainty'],'Certain','#794321','#ac794e']}},
      {id:'roads-tentative',type:'line',priority:2,filter:tentative,paint:{
        'line-width':['case',ferry,1.5,1.15],'line-color':['case',ferry,'#806d63','#b99275'],'line-dasharray':[2,2]}}
    ]}],legend:[['certain','Certain road'],['conjectured','Conjectured road'],['tentative','Hypothetical / ferry connector']]},
  {id:'maritime',scope:'orbis-maritime',title:'Maritime routes',
    sources:[{id:'maritime',unit:'routes',styles:[{id:'maritime',type:'line',priority:3,
      paint:{'line-color':'#24548d','line-width':1.8,'line-dasharray':[4,2]}}]},
      {id:'ports',unit:'ports',styles:[circle('ports','#296f79',3.1,1)]}],
    legend:[['shipping','Maritime routes'],['port','Ports']]},
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
