const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const batchColumns='id,group_name,as_of,customer_count,total,author,created_at,sent_at,status';
const uuid='[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
export const dispatchRoute=new RegExp('^/api/erp/wecom-dispatches(?:/('+uuid+')(/feedback)?)?$');
const pageSize=25;

export async function initializeDispatches(db){
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS wecom_dispatch (
      id TEXT PRIMARY KEY, group_name TEXT NOT NULL, as_of TEXT NOT NULL, rows_json TEXT NOT NULL,
      customer_count INTEGER NOT NULL, total INTEGER NOT NULL, author TEXT NOT NULL,
      created_at TEXT NOT NULL, sent_at TEXT, status TEXT NOT NULL
      CHECK(status IN ('sending','sent','failed','unconfirmed')))`),
    db.prepare('CREATE INDEX IF NOT EXISTS wecom_dispatch_created ON wecom_dispatch(created_at DESC,id DESC)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS wecom_feedback (
      id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL, customer_index INTEGER NOT NULL,
      result TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(dispatch_id) REFERENCES wecom_dispatch(id))`),
    db.prepare('CREATE INDEX IF NOT EXISTS wecom_feedback_customer ON wecom_feedback(dispatch_id,customer_index,created_at)')
  ]);
}

export async function recordDispatch(db,groupName,email,report){
  const id=crypto.randomUUID();
  await db.prepare(`INSERT INTO wecom_dispatch
    (id,group_name,as_of,rows_json,customer_count,total,author,created_at,status) VALUES (?,?,?,?,?,?,?,?,'sending')`)
    .bind(id,groupName,report.asOf,JSON.stringify(report.rows),report.rows.length,report.total,email,new Date().toISOString()).run();
  return id;
}

export async function finishDispatch(db,id,status){
  await db.prepare("UPDATE wecom_dispatch SET status=?,sent_at=? WHERE id=? AND status='sending'")
    .bind(status,status==='sent'?new Date().toISOString():null,id).run();
}

function displayDispatch(batch){
  if(batch.status==='sending'&&Date.now()-Date.parse(batch.created_at)>60000)return {...batch,status:'unconfirmed'};
  return batch;
}

export async function dispatches(req,db,role,email,url,[,id,feedback]){
  if(!['admin','finance'].includes(role))return response({error:'只有财务人员和管理员可以查看及登记催收跟进。'},403);
  if(req.method!=='GET'&&!(req.method==='POST'&&feedback))return response({error:'接口不存在'},404);
  await initializeDispatches(db);

  if(!id){
    const page=Math.min(10000,Math.max(1,Number.parseInt(url.searchParams.get('page'),10)||1));
    const {results}=await db.prepare(`SELECT ${batchColumns},
      (SELECT count(DISTINCT f.customer_index) FROM wecom_feedback f WHERE f.dispatch_id=wecom_dispatch.id) AS feedback_count
      FROM wecom_dispatch ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .bind(pageSize+1,(page-1)*pageSize).all();
    return response({batches:results.slice(0,pageSize).map(displayDispatch),page,next:results.length>pageSize});
  }

  const batch=await db.prepare('SELECT '+batchColumns+(feedback?'':',rows_json')+' FROM wecom_dispatch WHERE id=?')
    .bind(id).first();
  if(!batch)return response({error:'找不到此推送记录。'},404);
  if(!feedback){
    const {rows_json,...metadata}=batch;
    const {results}=await db.prepare('SELECT customer_index,count(*) AS count FROM wecom_feedback WHERE dispatch_id=? GROUP BY customer_index').bind(id).all();
    const counts=new Map(results.map(row=>[row.customer_index,row.count]));
    const rows=JSON.parse(rows_json).map((row,index)=>({...row,index,feedbackCount:counts.get(index)??0}));
    return response({batch:displayDispatch(metadata),rows});
  }

  if(batch.status!=='sent')return response({error:'企业微信确认发送后才能登记跟进。'},409);
  const key=url.searchParams.get('customer');
  const index=key!==null&&/^\d{1,9}$/.test(key)?Number(key):-1;
  if(index<0||index>=batch.customer_count)return response({error:'该客户不在这次推送中。'},404);

  if(req.method==='POST'){
    const raw=await req.text();
    if(raw.length>6000)return response({error:'反馈内容过长。'},413);
    const body=JSON.parse(raw);
    const result=typeof body?.result==='string'?body.result.trim():'';
    if(!result||result.length>1000)return response({error:'请填写跟进结果（1–1000 字符）。'},400);
    if(typeof body.id!=='string'||!(new RegExp('^'+uuid+'$')).test(body.id))return response({error:'请重新打开反馈窗口后保存。'},400);
    await db.prepare(`INSERT INTO wecom_feedback(id,dispatch_id,customer_index,result,author,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(body.id,id,index,result,email,new Date().toISOString()).run();
    const saved=await db.prepare('SELECT dispatch_id,customer_index,result,author FROM wecom_feedback WHERE id=?').bind(body.id).first();
    if(saved.dispatch_id!==id||saved.customer_index!==index||saved.author!==email||saved.result!==result){
      return response({error:'这条反馈的保存请求已被使用，请重新填写。'},409);
    }
  }

  const {results}=await db.prepare(`SELECT result,author,created_at FROM wecom_feedback
    WHERE dispatch_id=? AND customer_index=? ORDER BY created_at DESC,rowid DESC`).bind(id,index).all();
  return response({feedback:results});
}
