import assert from 'node:assert/strict';
import test from 'node:test';
import {biGenerate,biModelInfo,configureBiModels} from '../bi-ai.mjs';

const config=configureBiModels({
  FINANCE_BI_MODELS:JSON.stringify([
    {id:'private',name:'内网服务',provider:'测试服务',model:'test-chat',url:'https://example.invalid/v1/chat/completions',keyEnv:'FINANCE_BI_KEY_TEST'},
    {id:'ollama',provider:'Ollama',model:'test-local',url:'http://127.0.0.1:11434/v1/chat/completions'}
  ]),
  FINANCE_BI_DEFAULT_MODEL:'private',FINANCE_BI_KEY_TEST:'mock-secret'
});
const data={
  report:[{id:'2026-08',revenue:120000,cost:54000,cash:-8000},{id:'2026-09',revenue:253000,cost:61000,cumulative:true}],
  ar:[{issued:'2026-10-01',due:'2026-11-14',amount:100000,paid:20000},{issued:'2026-10-02',due:'2026-11-15',amount:30000,paid:0}],
  erp:{months:[{id:'2026-08',net:20000},{id:'2026-10',net:-50000}],snapshot:{as_of:'2026-09-30'},exposure:[
    {customer:'示例甲',residual:400,verified:0},{customer:'示例乙',residual:0,verified:300},{customer:'示例丙',residual:1000,verified:500}
  ]}
};
const ask=(prompt,options={},body={})=>biGenerate(new Request('http://localhost/api/bi/generate',{
  method:'POST',body:JSON.stringify({model:'local',period:'2026-10',prompt,...body})
}),{config,asOf:'2026-11-15',load:async()=>data,...options});

test('relative and explicit ranges return actual monthly data and preserve missing values',async()=>{
  const result=await (await ask('帮我看看最近三个月的 ERP 收入和经营现金流趋势')).json();
  assert.equal(result.display,'trend');
  assert.deepEqual(result.results[0].points.map(p=>p.period),['2026-09','2026-10','2026-11']);
  assert.deepEqual(result.results[0].points.map(p=>p.value),[null,-50000,null]);
  assert.deepEqual(result.results[1].points.map(p=>p.value),[null,null,null]);
  const explicit=await (await ask('2026年8月到10月营业收入趋势')).json();
  assert.deepEqual(explicit.results[0].points.map(p=>p.value),[120000,null,null]);
  const cumulative=await (await ask('今年九月的营业收入是多少？')).json();
  assert.equal(cumulative.results[0].points[0].scope,'本年累计');
});

test('receivables apply the current cutoff and ranking uses verified amounts at the snapshot date',async()=>{
  const cards=await (await ask('请显示应收余额、逾期余额和回款率')).json();
  assert.deepEqual(cards.results.map(r=>r.points[0].value),[110000,80000,20000/130000]);
  const rank=await (await ask('逾期客户前两名')).json();
  assert.equal(rank.results[0].asOf,'2026-09-30');
  assert.deepEqual(rank.results[0].rows.map(r=>r.value),[500,300]);
  for(const prompt of ['市场部营业收入','收入同比','2026年收入合计','10月逾期客户排行','逾期客户前 30 名']){
    assert.equal((await ask(prompt,{load(){assert.fail('unsupported requests must not query data')}})).status,422,prompt);
  }
});

test('selected external model only receives text and planning data; responses cannot supply values or arbitrary queries',async()=>{
  assert.equal(biModelInfo(config).defaultModel,'private');
  assert.deepEqual(Object.keys(biModelInfo(config).models[1]),['id','name','provider','model']);
  const mock=(answer)=>async(url,init)=>{
    assert.equal(url,'https://example.invalid/v1/chat/completions');
    assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer mock-secret');
    const body=JSON.parse(init.body);
    assert.equal(body.model,'test-chat');
    assert.deepEqual(JSON.parse(body.messages[1].content),{request:'请看8月收入',selectedMonth:'2026-10',currentMonth:'2026-11'});
    assert.doesNotMatch(init.body,/120000|示例甲/);
    return Response.json({choices:[{message:{content:JSON.stringify(answer)}}]});
  };
  const plan={metrics:['revenue'],display:'cards',from:'2026-08',to:'2026-08'};
  const result=await (await ask('请看8月收入',{fetchModel:mock({...plan,value:999})},{model:'private'})).json();
  assert.equal(result.model,'private');
  assert.equal(result.results[0].points[0].value,120000);
  const rejected=await ask('请看8月收入',{
    fetchModel:mock({...plan,metrics:['constructor'],query:'not an approved metric'}),
    load(){assert.fail('invalid model plan must not query data')}
  },{model:'private'});
  assert.equal(rejected.status,422);
  assert.equal((await ask('营业收入',{fetchModel:async()=>new Response(null,{status:503})},{model:'private'})).status,502);
});
