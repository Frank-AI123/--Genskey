const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const roles=['admin','finance','viewer'];
const money=v=>Number.isSafeInteger(v)&&v>=0&&v<=100000000000000;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const label=v=>typeof v==='string'&&v.trim().length>0&&v.length<=120;
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
  if(!id||!email)return json({error:'请先登录 ChatGPT'},401);
  if(req.method==='POST'&&(req.headers.get('Origin')!==url.origin||!req.headers.get('Content-Type')?.startsWith('application/json')))return json({error:'无效请求来源'},403);
  try{
    const db=env.DB;
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS member (email TEXT PRIMARY KEY, role TEXT NOT NULL)'),
      ...(!env.DATA?[db.prepare('CREATE TABLE IF NOT EXISTS record (type TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(type,id))')]:[])
    ]);
    await db.prepare("INSERT INTO member SELECT ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM member)").bind(email).run();
    const member=await db.prepare('SELECT role FROM member WHERE email=?').bind(email).first();
    if(!member)return json({error:'此账号尚未分配财务工作台角色，请联系管理员。'},403);
    const {role}=member;
    if(req.method==='GET'&&url.pathname==='/api/state'){
      const results=env.DATA?await env.DATA.list():(await db.prepare('SELECT type,data FROM record ORDER BY id').all()).results;
      const members=role==='admin'?(await db.prepare('SELECT email,role FROM member ORDER BY email').all()).results:[];
      return json({email,role,members,ar:results.filter(r=>r.type==='ar').map(r=>JSON.parse(r.data)),report:results.filter(r=>r.type==='report').map(r=>JSON.parse(r.data))});
    }
    if(req.method!=='POST')return json({error:'接口不存在'},404);
    if(role==='viewer')return json({error:'当前账号只有查看权限'},403);
    const raw=await req.text();
    if(raw.length>1000000)return json({error:'请求超出大小限制'},413);
    const body=JSON.parse(raw);
    if(url.pathname==='/api/members'){
      if(role!=='admin')return json({error:'仅管理员可分配权限'},403);
      const target=String(body.email||'').trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)||target.length>254||target===email||![...roles,'remove'].includes(body.role))return json({error:'请输入其他成员的有效邮箱和角色'},400);
      if(body.role==='remove')await db.prepare('DELETE FROM member WHERE email=?').bind(target).run();
      else await db.prepare('INSERT INTO member VALUES (?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role').bind(target,body.role).run();
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
