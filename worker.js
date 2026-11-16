import {budgets,departmentName,initializeBudget} from './budget.mjs';
import {dispatchRoute,dispatches,finishDispatch,initializeDispatches,recordDispatch} from './wecom-feedback.mjs';
import {biGenerate,biModelInfo} from './bi-ai.mjs';

const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const roles=['admin','finance','viewer','budget'];
const money=v=>Number.isSafeInteger(v)&&v>=0&&v<=100000000000000;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const label=v=>typeof v==='string'&&v.trim().length>0&&v.length<=120;
const skillFields='id,name,category,version,summary,owner,published,updated_at';
const skillRoute=/^\/api\/skills\/([0-9a-f-]{36})(?:\/(download|edit))?$/;
const skillPermissions=(role,owner,email)=>role==='admin'||(role==='finance'&&owner===email);
async function overdueWecom(req,env,role,email){
  if(!['admin','finance'].includes(role))return json({error:'只有财务人员和管理员可以发送客户逾期明细。'},403);
  if(!env.WECOM||!env.ERP)return json({error:'当前工作台未启用企业微信发送。'},404);
  if(!['GET','POST'].includes(req.method))return json({error:'接口不存在'},404);
  const report=env.ERP.overdue180();
  if(!report)return json({error:'没有可用于发送的 ERP 应收账龄快照。'},404);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(report)));
  const version=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(req.method==='GET')return json({report,version,groups:await env.WECOM.groups()});

  const raw=await req.text();
  if(raw.length>65536)return json({error:'请求超出大小限制'},413);
  const body=JSON.parse(raw);
  if(typeof body?.groupId!=='string'||!/^[a-z0-9-]{1,40}$/.test(body.groupId))return json({error:'请选择企业微信群。'},400);
  if(body.version!==version)return json({error:'账龄数据已更新，请关闭此窗口并重新预览。'},409);
  if(!report.rows.length)return json({error:'没有逾期超过 180 天的未收款。'},400);
  const selected=body.customerIndexes;
  if(!Array.isArray(selected)||!selected.length)return json({error:'请至少勾选一位客户。'},400);
  if(selected.length>report.rows.length||selected.some(i=>!Number.isInteger(i)||i<0||i>=report.rows.length)||new Set(selected).size!==selected.length){
    return json({error:'客户选择无效，请重新勾选。'},400);
  }
  const indexes=[...selected].sort((a,b)=>a-b);
  const rows=indexes.map(i=>report.rows[i]);
  const selection={asOf:report.asOf,total:rows.reduce((sum,row)=>sum+row.cents,0),rows};
  const db=env.DB;
  await initializeDispatches(db);
  const {status,batchId,unconfirmed,...result}=await env.WECOM.send(body.groupId,body.groupRevision,selection,version+':'+indexes.join(','),
    groupName=>recordDispatch(db,groupName,email,selection));
  if(batchId){
    try{await finishDispatch(db,batchId,status===200?'sent':unconfirmed?'unconfirmed':'failed')}
    catch(error){
      console.error('Unable to update WeCom dispatch status:',error.message);
      if(status===200)return json({error:'企业微信已确认发送，但平台暂未保存发送状态。请检查推送记录。'},503);
    }
  }
  return json({...result,batchId},status);
}
function skillInput(body){
  const limits={name:80,category:40,version:32,summary:240,instructions:4000,launch_url:2048,markdown:100000};
  const input={};
  for(const [name,max] of Object.entries(limits)){
    const value=body?.[name]??'';
    if(typeof value!=='string'||value.length>max)return null;
    input[name]=name==='markdown'?value:value.trim();
  }
  if(!input.name||!input.category||!input.version||!input.summary||!input.instructions)return null;
  if(!input.markdown.trim())input.markdown='';
  if(!input.launch_url&&!input.markdown)return null;
  if(input.launch_url){
    try{
      const link=new URL(input.launch_url);
      if(link.protocol!=='https:'||link.username||link.password||!/^https:\/\//i.test(input.launch_url))return null;
      input.launch_url=link.href;
      if(input.launch_url.length>limits.launch_url)return null;
    }catch{return null}
  }
  return input;
}
async function skills(req,db,role,email,match){
  if(req.method!=='GET'&&req.method!=='POST')return json({error:'接口不存在'},404);
  const [,id,mode]=match??[];
  if(req.method==='POST'&&(mode||!['admin','finance'].includes(role)))return json({error:'当前账号无权管理技能'},403);
  const row=id?await db.prepare('SELECT '+skillFields+',instructions,launch_url,markdown FROM team_skill WHERE id=?').bind(id).first():null;
  const manage=row&&skillPermissions(role,row.owner,email);
  if(id&&(!row||(!row.published&&!manage)))return json({error:'技能不存在或已下架'},404);
  if(req.method==='GET'){
    if(!id){
      const list=await db.prepare('SELECT '+skillFields+' FROM team_skill WHERE published=1 OR ?=1 OR owner=? ORDER BY updated_at DESC,id DESC')
        .bind(role==='admin'?1:0,role==='finance'?email:'').all();
      return json({skills:list.results});
    }
    if(mode==='download'){
      if(!row.published||!row.markdown)return json({error:'技能文件不可下载'},404);
      return new Response(row.markdown,{headers:{
        'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="SKILL.md"',
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'
      }});
    }
    if(mode==='edit')return manage?json({skill:row}):json({error:'无权编辑此技能'},403);
    const {markdown,...detail}=row;
    return json({skill:{...detail,has_file:Boolean(markdown)}});
  }
  if(id&&!manage)return json({error:'只能管理自己发布的技能'},403);
  const raw=await req.text();
  if(raw.length>1000000)return json({error:'请求超出大小限制'},413);
  const body=JSON.parse(raw),now=new Date().toISOString();
  if(id&&['publish','unpublish'].includes(body?.action)){
    await db.prepare('UPDATE team_skill SET published=?,updated_at=? WHERE id=?')
      .bind(body.action==='publish'?1:0,now,id).run();
    return json({id});
  }
  const values=skillInput(body);
  if(!values)return json({error:'请填写技能名称、分类、版本、简介和使用说明，并提供 HTTPS 使用链接或有效的 SKILL.md 文件内容。'},400);
  const fields=[values.name,values.category,values.version,values.summary,values.instructions,values.launch_url,values.markdown,now];
  if(id){
    await db.prepare('UPDATE team_skill SET name=?,category=?,version=?,summary=?,instructions=?,launch_url=?,markdown=?,updated_at=? WHERE id=?')
      .bind(...fields,id).run();
    return json({id});
  }
  const newId=crypto.randomUUID();
  await db.prepare('INSERT INTO team_skill(name,category,version,summary,instructions,launch_url,markdown,updated_at,id,owner,published) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
    .bind(...fields,newId,email).run();
  return json({id:newId},201);
}
export function valid(type,r){
  if(!r||typeof r!=='object')return false;
  if(type==='ar')return label(r.id)&&label(r.customer)&&date(r.issued)&&date(r.due)&&r.due>=r.issued&&money(r.amount)&&r.amount>0&&money(r.paid)&&r.paid<=r.amount;
  const signed=v=>Number.isSafeInteger(v)&&Math.abs(v)<=100000000000000;
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(r.id)||!['revenue','cost','expense','cash'].every(k=>signed(r[k])))return false;
  if(r.cumulative!==undefined&&typeof r.cumulative!=='boolean')return false;
  if(r.company===undefined)return !r.cumulative;
  return signed(r.operating)&&r.company&&['balance','income','cashflow'].every(key=>{
    const lines=r.company[key];
    return Array.isArray(lines)&&lines.length<=200&&lines.every(line=>Array.isArray(line)&&line.length===3&&label(line[0])&&line.slice(1).every(v=>v===null||signed(v)));
  });
}
export default {async fetch(req,env){
  const url=new URL(req.url);
  const id=req.headers.get('oai-authenticated-user-id');
  const email=req.headers.get('oai-authenticated-user-email')?.toLowerCase();
  if(!url.pathname.startsWith('/api/'))return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(!id||!email)return json({error:env.LOCAL_ACCOUNTS?'请先登录工作台':'请先登录 ChatGPT'},401);
  if(req.method==='POST'&&(req.headers.get('Origin')!==url.origin||!req.headers.get('Content-Type')?.startsWith('application/json')))return json({error:'无效请求来源'},403);
  try{
    const db=env.DB;
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS member (email TEXT PRIMARY KEY, role TEXT NOT NULL)'),
      ...(!env.DATA?[db.prepare('CREATE TABLE IF NOT EXISTS record (type TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(type,id))')]:[])
    ]);
    if(!env.LOCAL_ACCOUNTS)await db.prepare("INSERT INTO member SELECT ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM member)").bind(email).run();
    const member=await db.prepare('SELECT role FROM member WHERE email=?').bind(email).first();
    if(!member)return json({error:'此账号尚未分配财务工作台角色，请联系管理员。'},403);
    const {role}=member;
    if(['/api/budgets','/api/budgets/detail'].includes(url.pathname)){
      await initializeBudget(db);
      return await budgets(req,db,role,email);
    }
    if(role==='budget'){
      if(req.method==='GET'&&url.pathname==='/api/state')return json({email,role,members:[],ar:[],report:[],erp:null});
      return json({error:'预算填报员只能访问预算管理。'},403);
    }
    if(url.pathname==='/api/erp/overdue-wecom')return await overdueWecom(req,env,role,email);
    const dispatchMatch=url.pathname.match(dispatchRoute);
    if(dispatchMatch)return await dispatches(req,db,role,email,url,dispatchMatch);
    const listRecords=async()=>env.DATA?await env.DATA.list():(await db.prepare('SELECT type,data FROM record ORDER BY id').all()).results;
    if(req.method==='POST'&&url.pathname==='/api/bi/generate'){
      const asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      return await biGenerate(req,{config:env.BI_MODELS,asOf,load:async sources=>{
        const records=sources.ar||sources.report?await listRecords():[];
        const read=type=>records.filter(r=>r.type===type).map(r=>JSON.parse(r.data));
        return {ar:sources.ar?read('ar'):[],report:sources.report?read('report'):[],erp:sources.erp?env.ERP?.summary():null};
      }});
    }
    const skillMatch=url.pathname.match(skillRoute);
    if(url.pathname==='/api/skills'||skillMatch){
      await db.prepare("CREATE TABLE IF NOT EXISTS team_skill (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, version TEXT NOT NULL, summary TEXT NOT NULL, instructions TEXT NOT NULL, launch_url TEXT NOT NULL, markdown TEXT NOT NULL, owner TEXT NOT NULL, published INTEGER NOT NULL CHECK(published IN (0,1)), updated_at TEXT NOT NULL)").run();
      return await skills(req,db,role,email,skillMatch);
    }
    if(req.method==='GET'&&env.ERP&&['/api/erp/customers','/api/erp/orders','/api/erp/revenue'].includes(url.pathname)){
      const data=env.ERP.details(url.pathname.split('/').at(-1),url.searchParams);
      return data?json(data):json({error:'尚未导入 ERP 数据'},404);
    }
    if(req.method==='GET'&&url.pathname==='/api/state'){
      const results=await listRecords();
      if(role==='admin')await initializeBudget(db);
      const members=role==='admin'?(await db.prepare('SELECT m.email,m.role,b.department FROM member m LEFT JOIN budget_member b ON m.email=b.email ORDER BY m.email').all()).results:[];
      return json({email,role,members,ar:results.filter(r=>r.type==='ar').map(r=>JSON.parse(r.data)),report:results.filter(r=>r.type==='report').map(r=>JSON.parse(r.data)),erp:env.ERP?.summary()??null,bi:biModelInfo(env.BI_MODELS),wecom:Boolean(env.WECOM)});
    }
    if(req.method!=='POST')return json({error:'接口不存在'},404);
    if(role==='viewer')return json({error:'当前账号只有查看权限'},403);
    const raw=await req.text();
    if(raw.length>1000000)return json({error:'请求超出大小限制'},413);
    const body=JSON.parse(raw);
    if(url.pathname==='/api/members'){
      if(role!=='admin')return json({error:'仅管理员可分配权限'},403);
      const target=String(body.email||'').trim().toLowerCase();
      const department=body.department===undefined?undefined:departmentName(body.department);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)||target.length>254||![...roles,'remove'].includes(body.role)||(target===email&&body.role!=='admin'))return json({error:'请输入有效邮箱和角色；管理员不能撤销或变更自己的角色。'},400);
      await initializeBudget(db);
      if(department===null||(body.role==='budget'&&!(department??(await db.prepare('SELECT department FROM budget_member WHERE email=?').bind(target).first())?.department)))return json({error:'请为预算填报员填写所属部门，部门名称最多 60 字。'},400);
      if(body.role==='remove')await db.batch([
        db.prepare('DELETE FROM member WHERE email=?').bind(target),
        db.prepare('DELETE FROM budget_member WHERE email=?').bind(target),
        ...(env.LOCAL_ACCOUNTS?[db.prepare('DELETE FROM account_code WHERE email=?').bind(target)]:[])
      ]);
      else await db.batch([
        db.prepare('INSERT INTO member VALUES (?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role').bind(target,body.role),
        ...(department===undefined?[]:department?[db.prepare('INSERT INTO budget_member VALUES (?,?) ON CONFLICT(email) DO UPDATE SET department=excluded.department').bind(target,department)]:
          [db.prepare('DELETE FROM budget_member WHERE email=?').bind(target)])
      ]);
      return json({ok:true});
    }
    if(url.pathname==='/api/import'){
      const {type,rows}=body;
      if(!['ar','report'].includes(type)||!Array.isArray(rows)||rows.length<1||rows.length>500||!rows.every(r=>valid(type,r))||new Set(rows.map(r=>r.id)).size!==rows.length)return json({error:'导入数据无效，或包含重复编号、重复月份。每批最多 500 行。'},400);
      if(env.DATA)await env.DATA.write(rows.map(r=>({type,id:r.id,data:JSON.stringify(r)})));
      else await db.batch(rows.map(r=>db.prepare('INSERT INTO record VALUES (?,?,?) ON CONFLICT(type,id) DO UPDATE SET data=excluded.data').bind(type,r.id,JSON.stringify(r))));
      return json({ok:true,count:rows.length});
    }
    if(url.pathname==='/api/payment'){
      if(!label(body.id)||!money(body.amount)||body.amount===0)return json({error:'回款金额无效'},400);
      const changed=env.DATA?await env.DATA.payment(body.id,body.amount):(await db.prepare("UPDATE record SET data=json_set(data,'$.paid',json_extract(data,'$.paid')+?) WHERE type='ar' AND id=? AND json_extract(data,'$.amount')-json_extract(data,'$.paid')>=?").bind(body.amount,body.id,body.amount).run()).meta.changes;
      return changed?json({ok:true}):json({error:'应收单不存在，或回款金额超过当前余额'},409);
    }
    return json({error:'接口不存在'},404);
  }catch(error){
    console.error(error.message);
    return json({error:error instanceof SyntaxError?'请求格式无效':'服务暂时不可用，请稍后重试'},error instanceof SyntaxError?400:503);
  }
}};
