const LOCAL={id:'local',name:'本地规则',provider:'工作台',model:null};
const monthId=/^20\d{2}-(0[1-9]|1[0-2])$/;
const amount=(label,source,aliases,read,unit='money')=>({label,source,aliases,read,unit});
const erp='ERP 收入（本位币）', report='月度财务报表', snapshot='ERP 应收快照';
const ledger='应收台账（按开单月）';
const sum=(rows,read)=>rows.reduce((total,row)=>total+read(row),0);
const ratio=(n,d)=>d?n/d:null;
const metrics={
  erpNet:amount('ERP 不含税收入',erp,/ERP(?:不含税)?收入|不含税收入|ERP营收/gi,({erpMonth})=>erpMonth?.net),
  revenue:amount('营业收入',report,/营业收入|(?<![A-Z])收入|营收/gi,({monthReport})=>monthReport?.revenue),
  cost:amount('营业成本',report,/营业成本|成本/g,({monthReport})=>monthReport?.cost),
  margin:amount('毛利率',report,/毛利率/g,({monthReport:r})=>r?ratio(r.revenue-r.cost,r.revenue):null,'percent'),
  grossProfit:amount('毛利',report,/毛利/g,({monthReport:r})=>r?r.revenue-r.cost:null),
  operating:amount('营业利润',report,/营业利润|经营利润/g,({monthReport:r})=>r?(r.operating??r.revenue-r.cost-r.expense):null),
  cash:amount('经营现金流净额',report,/经营(?:活动产生的)?现金流(?:量)?净额|经营现金流|现金流/g,({monthReport})=>monthReport?.cash),
  arBalance:amount('应收余额',ledger,/应收(?:账款)?余额|应收账款|应收/g,({ar})=>ar.length?sum(ar,r=>r.amount-r.paid):null),
  arOverdue:amount('逾期余额',ledger,/逾期余额|逾期金额/g,({ar,asOf})=>ar.length?sum(ar,r=>r.due<asOf?r.amount-r.paid:0):null),
  arOverdueRate:amount('逾期率',ledger,/逾期率/g,({ar,asOf})=>ratio(sum(ar,r=>r.due<asOf?r.amount-r.paid:0),sum(ar,r=>r.amount-r.paid)),'percent'),
  collection:amount('回款金额',ledger,/回款金额|已收金额|回款/g,({ar})=>ar.length?sum(ar,r=>r.paid):null),
  collectionRate:amount('回款率',ledger,/累计回款率|回款率/g,({ar})=>ratio(sum(ar,r=>r.paid),sum(ar,r=>r.amount)),'percent'),
  book:amount('账面期末应收',snapshot,/账面(?:期末)?应收(?:余额)?|账面余额/g,({erp})=>erp?.snapshot?.book),
  allocated:amount('已分配回款',snapshot,/已分配回款/g,({erp})=>erp?.snapshot?.paid),
  oldest:amount('181 天及以上逾期（订单核实）',snapshot,/(?:订单核实的?)?(?:181天(?:及)?以上|180天以上)(?:逾期)?(?:余额|金额)?|订单核实逾期/g,({erp})=>erp?.aging?.long),
  customerRisk:{label:'逾期客户排行（181 天及以上，订单核实）',source:snapshot,unit:'rank'}
};
const instructions='可试试「营业收入和毛利率」「本年每月 ERP 收入趋势」或「逾期客户前 5 名」。';
class BiError extends Error{constructor(message,status=422){super(message);this.status=status}}
const validId=id=>typeof id==='string'&&/^[a-z\d][a-z\d_-]{0,39}$/i.test(id);

export function configureBiModels(env={}){
  const models=[LOCAL];
  if(env.FINANCE_BI_MODELS){
    let values;
    try{values=JSON.parse(env.FINANCE_BI_MODELS)}catch{throw Error('FINANCE_BI_MODELS 必须是 JSON 数组。')}
    if(!Array.isArray(values)||values.length>8)throw Error('FINANCE_BI_MODELS 最多可配置 8 个模型。');
    for(const [index,v] of values.entries()){
      const fail=()=>{throw Error('FINANCE_BI_MODELS 第 '+(index+1)+' 个模型配置无效。')};
      if(!v||![v.provider,v.model,v.url].every(s=>typeof s==='string'&&s.trim())||
        !validId(v.id)||models.some(m=>m.id===v.id)||v.provider.length>60||v.model.length>120||
        (v.name!==undefined&&(typeof v.name!=='string'||!v.name.trim()||v.name.length>80)))fail();
      let url;
      try{url=new URL(v.url)}catch{fail()}
      if(url.username||url.password||url.hash||url.search||
        (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))fail();
      if(v.keyEnv!==undefined&&(typeof v.keyEnv!=='string'||!/^FINANCE_BI_KEY_[A-Z0-9_]+$/.test(v.keyEnv)||!env[v.keyEnv]?.trim()))fail();
      models.push({id:v.id,provider:v.provider.trim(),name:v.name?.trim()||v.model.trim(),model:v.model.trim(),url:url.href,key:v.keyEnv?env[v.keyEnv]:''});
    }
  }
  const defaultModel=env.FINANCE_BI_DEFAULT_MODEL||LOCAL.id;
  if(!models.some(m=>m.id===defaultModel))throw Error('FINANCE_BI_DEFAULT_MODEL 必须指向已启用的模型。');
  return {models,defaultModel};
}

const localConfig=configureBiModels();
export function biModelInfo(config=localConfig){
  return {defaultModel:config.defaultModel,models:config.models.map(({id,name,provider,model})=>({id,name,provider,model}))};
}
const cnNumber={'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十一':11,'十二':12};
const parsedNumber=s=>cnNumber[s]??Number(s);
const padMonth=(year,month)=>year+'-'+String(month).padStart(2,'0');
const monthIndex=id=>Number(id.slice(0,4))*12+Number(id.slice(5))-1;
const idAt=index=>padMonth(Math.floor(index/12),index%12+1);
const thisYear=id=>id.slice(0,4);

function localPlan(prompt,period,today){
  let text=prompt.normalize('NFKC').replace(/\s+/g,'');
  const rank=/(?:181天(?:及)?以上|180天以上)?逾期客户(?:风险)?(?:排行(?:榜)?|排名)?(?:前(\d+|十一|十二|[一二两三四五六七八九十])(?:名|家)?)?/;
  const ranking=text.match(rank);
  if(ranking){
    text=text.replace(rank,'');
    if(text.replace(/^(请|帮我|给我|请帮我)?(看|列出|显示|查看|看看|生成)?(一下)?[。.!！?？]*$/,''))
      throw new BiError('逾期客户排行使用 ERP 快照。可输入「逾期客户前 5 名」。');
    return {metrics:['customerRisk'],display:'rank',from:null,to:null,limit:ranking[1]?parsedNumber(ranking[1]):5};
  }
  let from=period,to=period,range=false;
  const setRange=(start,end)=>{if(range)throw new BiError('请一次指定一个期间。');from=start;to=end;range=true;return ''};
  const m='(1[0-2]|0?[1-9]|十一|十二|[一二两三四五六七八九十])';
  text=text.replace(new RegExp('(20\\d{2})年'+m+'月?(?:到|至|~|—|-)'+m+'月','g'),(_,y,a,b)=>setRange(padMonth(y,parsedNumber(a)),padMonth(y,parsedNumber(b))));
  text=text.replace(/(20\d{2}-(?:0[1-9]|1[0-2]))(?:到|至|~|—)(20\d{2}-(?:0[1-9]|1[0-2]))/g,(_,a,b)=>setRange(a,b));
  text=text.replace(new RegExp('(20\\d{2})年'+m+'月','g'),(_,y,n)=>setRange(padMonth(y,parsedNumber(n)),padMonth(y,parsedNumber(n))));
  text=text.replace(/20\d{2}-(?:0[1-9]|1[0-2])(?!\d)/g,id=>setRange(id,id));
  text=text.replace(/(20\d{2})年/g,(_,y)=>setRange(y+'-01',y+'-12'));
  text=text.replace(new RegExp('(今年|本年|去年)'+m+'月','g'),(_,y,n)=>{
    const id=padMonth(Number(thisYear(today))-(y==='去年'?1:0),parsedNumber(n));return setRange(id,id);
  });
  text=text.replace(/最近(1[0-2]|[1-9]|十一|十二|[一二两三四五六七八九十])个?月/g,(_,n)=>
    setRange(idAt(monthIndex(today)-parsedNumber(n)+1),today));
  text=text.replace(new RegExp(m+'月','g'),(_,n)=>{const id=padMonth(thisYear(period),parsedNumber(n));return setRange(id,id)});
  text=text.replace(/今年|本年/g,()=>setRange(thisYear(today)+'-01',today));
  text=text.replace(/去年/g,()=>{const y=Number(thisYear(today))-1;return setRange(y+'-01',y+'-12')});
  text=text.replace(/上月|上个月/g,()=>{const id=idAt(monthIndex(today)-1);return setRange(id,id)});
  text=text.replace(/本月|这个月/g,()=>setRange(today,today));
  const trend=/趋势|按月|逐月|每月|走势图|折线图|柱状图|柱形图/.test(text);
  if(trend&&!range){from=thisYear(period)+'-01';to=period}
  text=text.replace(/走势图|折线图|柱状图|柱形图|趋势|按月|逐月|每月|指标卡|看板|指标/g,'');
  const wanted=[];
  // Select matches by their position in the request; favor the longer financial term at the same offset.
  const matches=Object.entries(metrics).flatMap(([key,spec])=>spec.aliases?
    [...text.matchAll(spec.aliases)].map(match=>({key,index:match.index,length:match[0].length})):[])
    .sort((a,b)=>a.index-b.index||b.length-a.length);
  let end=0,remaining='';
  for(const item of matches){
    if(item.index<end)continue;
    remaining+=text.slice(end,item.index);
    end=item.index+item.length;
    if(!wanted.includes(item.key))wanted.push(item.key);
  }
  remaining+=text.slice(end);
  if(!wanted.length||remaining.replace(/请帮我|麻烦|给我|帮我|我想|需要|想看|看看|查看|展示|显示|列出|生成|画出|画个|做个|一下|分别|以及|对应|是多少|有多少|多少|请|看|和|与|及|还有|的|一张|一份|按|[、,，。.!！?？；;：:+]/g,''))
    throw new BiError('本地规则未能识别完整需求。'+instructions);
  if(range&&wanted.some(key=>metrics[key].source===snapshot))
    throw new BiError('ERP 应收快照按自身截止日展示，请移除快照指标的月份筛选。');
  return {metrics:wanted,display:trend||from!==to?'trend':'cards',from,to};
}

function checkedPlan(plan){
  if(plan?.unsupported===true)throw new BiError('当前数据口径暂不支持该需求。'+instructions);
  if(!plan||!Array.isArray(plan.metrics)||!plan.metrics.length||plan.metrics.length>6||
    !plan.metrics.every(id=>typeof id==='string'&&Object.hasOwn(metrics,id))||
    !['cards','trend','rank'].includes(plan.display))throw new BiError('未能生成有效的指标方案。'+instructions);
  const keys=[...new Set(plan.metrics)];
  if(plan.display==='rank'){
    if(keys.length!==1||keys[0]!=='customerRisk'||!Number.isInteger(plan.limit)||plan.limit<1||plan.limit>20||
      plan.from!=null||plan.to!=null)throw new BiError('逾期客户排行仅支持按快照展示前 1–20 名。');
    return {metrics:keys,display:'rank',limit:plan.limit};
  }
  if(keys.includes('customerRisk')||![plan.from,plan.to].every(id=>typeof id==='string'&&monthId.test(id))||
    plan.from>plan.to||monthIndex(plan.to)-monthIndex(plan.from)>=24||
    (plan.display==='cards'&&plan.from!==plan.to))throw new BiError('请选择有效的期间；月度趋势最多支持连续 24 个月。');
  if(plan.display==='trend'&&keys.some(key=>metrics[key].source===snapshot))
    throw new BiError('ERP 应收快照只有一个截止日，暂不支持月度趋势。');
  return {metrics:keys,display:plan.display,from:plan.from,to:plan.to};
}

async function modelPlan(model,prompt,period,today,callModel){
  const catalog=Object.entries(metrics).map(([id,m])=>id+': '+m.label+'（'+m.source+'）').join('\n');
  const policy=[
    '你只把中文财务 BI 需求转换成 JSON 查询方案，禁止生成金额、公式、SQL 或任何查询代码。',
    '只支持目录中的指标、单月卡片、按月趋势（最多 24 个月）、快照逾期客户排行。',
    '不支持自定义过滤、客户或部门筛选、自定义公式、同比环比、全年合计。遇到这些或无法完整满足的要求，返回 {"unsupported":true}，不得换成近似方案。',
    '未明示期间时，卡片用所选月，趋势用所选月当年 1 月至所选月。相对日期基于当前月。快照卡片使用所选月作为方案的占位，实际按快照截止日。',
    '输出 {"metrics":["revenue"],"display":"cards","from":"2026-01","to":"2026-01"}；多个月份 display 用 trend。',
    '排行输出 {"metrics":["customerRisk"],"display":"rank","limit":5,"from":null,"to":null}；只支持 ERP 快照订单核实的 181 天及以上逾期客户。',
    '最多六个指标。只返回 JSON。以下是指标目录：\n'+catalog
  ].join('\n');
  try{
    const response=await callModel(model.url,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{'Content-Type':'application/json',...(model.key?{Authorization:'Bearer '+model.key}:{})},
      body:JSON.stringify({model:model.model,stream:false,max_tokens:750,messages:[
        {role:'system',content:policy},
        {role:'user',content:JSON.stringify({request:prompt,selectedMonth:period,currentMonth:today})}
      ]})
    });
    if(!response.ok)throw Error();
    const reply=(await response.json()).choices?.[0]?.message?.content;
    if(typeof reply!=='string'||reply.length>4000)throw Error();
    return JSON.parse(reply.trim().replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/i,'$1'));
  }catch{
    throw new BiError('所选模型暂不可用或未返回有效方案，请重试或切换到本地规则。',502);
  }
}

export function calculateBi(plan,{ar=[],report:reports=[],erp=null,asOf}){
  if(plan.display==='rank'){
    const ranking=(erp?.exposure??[]).filter(r=>r.verified>0)
      .sort((a,b)=>b.verified-a.verified||a.customer.localeCompare(b.customer,'zh-CN')).slice(0,plan.limit);
    return {display:'rank',results:[{label:metrics.customerRisk.label,source:snapshot,asOf:erp?.snapshot?.as_of??null,
      rows:ranking.map(r=>({label:r.customer,value:r.verified}))}]};
  }
  const months=Array.from({length:monthIndex(plan.to)-monthIndex(plan.from)+1},(_,i)=>idAt(monthIndex(plan.from)+i));
  const data=months.map(id=>({id,asOf,erp,erpMonth:erp?.months?.find(r=>r.id===id),monthReport:reports.find(r=>r.id===id),ar:ar.filter(r=>r.issued.startsWith(id+'-'))}));
  const results=plan.metrics.map(key=>{
    const m=metrics[key],isSnapshot=m.source===snapshot;
    const points=data.map(row=>{
      const r=row.monthReport,monthlyOnly=plan.display==='trend'&&m.source===report;
      const value=monthlyOnly&&r?.cumulative?null:m.read(row);
      const label=key==='operating'&&r&&!r.company?'经营利润（简化口径）':m.label;
      return {period:isSnapshot?erp?.snapshot?.as_of??null:row.id,label,
        scope:isSnapshot?'快照截止日':m.source===ledger?'截至 '+asOf:m.source===report&&r?.cumulative?'本年累计':'当月',
        value:typeof value==='number'&&Number.isFinite(value)?value:null};
    });
    const note=plan.display!=='trend'?'':m.source===report?
      '累计报表不参与月度趋势。'+(key==='operating'?'简版报表采用收入减成本和期间费用。':''):
      m.source===ledger?'余额、逾期与回款按 '+asOf+' 的台账状态计算。':'';
    return {label:plan.display==='cards'?points[0].label:m.label,source:m.source,unit:m.unit,points,...(note?{note}:{})};
  });
  return {display:plan.display,from:plan.from,to:plan.to,results};
}

export async function biGenerate(req,{config=localConfig,load,fetchModel=fetch,asOf}){
  const reply=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  try{
    const raw=await req.text();
    if(raw.length>4096)throw new BiError('需求过长。',413);
    let body;
    try{body=JSON.parse(raw)}catch{throw new BiError('无法读取指标需求。',400)}
    const prompt=typeof body?.prompt==='string'?body.prompt.trim():'';
    if(!prompt||prompt.length>300||typeof body?.period!=='string'||!monthId.test(body.period))
      throw new BiError('请输入不超过 300 字的指标需求，并选择有效期间。',400);
    const model=config.models.find(m=>m.id===body.model);
    if(!model)throw new BiError('所选模型未启用，请重新选择。',400);
    const current=asOf.slice(0,7);
    const plan=checkedPlan(model.id===LOCAL.id?localPlan(prompt,body.period,current):
      await modelPlan(model,prompt,body.period,current,fetchModel));
    const sources=new Set(plan.metrics.map(key=>metrics[key].source));
    const data=await load({ar:sources.has(ledger),report:sources.has(report),erp:sources.has(erp)||sources.has(snapshot)});
    return reply({model:model.id,...calculateBi(plan,{...data,asOf})});
  }catch(error){
    if(error instanceof BiError)return reply({error:error.message},error.status);
    throw error;
  }
}
