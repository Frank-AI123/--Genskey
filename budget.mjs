const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const error=(message,status)=>json({error:message},status);
const reviewRoles=['admin','finance'];
const keyFields='department,year,status,total,version,updated_at';
const validYear=year=>Number.isInteger(year)&&year>=2000&&year<=2099;
const text=(value,max)=>typeof value==='string'&&value.length<=max?value.trim():null;
export const departmentName=value=>{
  const name=text(value,60);
  return name!==null&&!/[\x00-\x1f\x7f]/.test(value)?name:null;
};

export async function initializeBudget(db){
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS budget_member (email TEXT PRIMARY KEY, department TEXT NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS department_budget (
      department TEXT NOT NULL, year INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','submitted','returned','approved')),
      total INTEGER NOT NULL, version INTEGER NOT NULL, items TEXT NOT NULL, events TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(department,year))`),
    db.prepare('CREATE INDEX IF NOT EXISTS department_budget_year ON department_budget(year,department)')
  ]);
}

function budgetItems(value){
  if(!Array.isArray(value)||value.length>200)return null;
  const items=[];
  for(const row of value){
    const subject=text(row?.subject,80),note=text(row?.note??'',300);
    const month=row?.month,amount=row?.amount;
    if(!subject||note===null||!Number.isInteger(month)||month<1||month>12||!Number.isSafeInteger(amount)||amount<0||amount>10000000000)return null;
    items.push({subject,month,amount,note});
  }
  return items;
}

export async function budgets(req,db,role,email){
  const url=new URL(req.url),detail=url.pathname==='/api/budgets/detail';
  const review=reviewRoles.includes(role);
  const fill=role!=='viewer';
  const own=(await db.prepare('SELECT department FROM budget_member WHERE email=?').bind(email).first())?.department??'';
  const allowed_department=department=>Boolean(department&&(review||department===own));
  if(req.method==='GET'){
    const year=Number(url.searchParams.get('year'));
    if(!validYear(year))return error('请选择 2000–2099 年的预算年度。',400);
    if(detail){
      const department=departmentName(url.searchParams.get('department'));
      if(!allowed_department(department))return error('无权查看此部门的预算。',403);
      const row=await db.prepare('SELECT '+keyFields+',items,events FROM department_budget WHERE department=? AND year=?').bind(department,year).first();
      if(!row)return error('此部门在该年度尚未保存预算。',404);
      return json({budget:{...row,items:JSON.parse(row.items),events:JSON.parse(row.events)}});
    }
    const rows=review?await db.prepare('SELECT '+keyFields+' FROM department_budget WHERE year=? ORDER BY department').bind(year).all():
      await db.prepare('SELECT '+keyFields+' FROM department_budget WHERE department=? AND year=?').bind(own,year).all();
    const departments=review?(await db.prepare('SELECT DISTINCT b.department FROM budget_member b JOIN member m ON m.email=b.email ORDER BY b.department').all()).results.map(r=>r.department):own?[own]:[];
    return json({department:own,review,fill,departments,rows:rows.results});
  }
  if(req.method!=='POST'||!detail)return error('接口不存在。',404);
  const raw=await req.text();
  if(raw.length>1000000)return error('请求超出大小限制。',413);
  const body=JSON.parse(raw);
  const {year,version,action}=body??{},department=departmentName(body?.department);
  if(!department||!validYear(year)||!Number.isSafeInteger(version)||version<0||!['save','submit','approve','return'].includes(action))return error('预算部门、年度、版本或操作无效。',400);
  const editing=action==='save'||action==='submit';
  if(editing?(!fill||department!==own):!review)return error(editing?'当前账号无权填报此部门的预算。':'只有财务或管理员可以审核预算。',403);
  const now=new Date().toISOString();
  const event=note=>JSON.stringify({action,email,at:now,note});
  let result;
  if(editing){
    const items=budgetItems(body.items);
    if(!items)return error('请检查明细：最多 200 行，每行须填写科目、月份和有效金额。',400);
    const total=items.reduce((amount,row)=>amount+row.amount,0);
    if(action==='submit'&&!total)return error('提交前请填写明细，且预算总金额必须大于 0。',400);
    const fields=[action==='submit'?'submitted':'draft',total,JSON.stringify(items)];
    // Verify the current department in the write itself, including when an administrator reassigns the account.
    const assignment="EXISTS (SELECT 1 FROM budget_member b JOIN member m ON m.email=b.email WHERE b.email=? AND b.department=? AND m.role IN ('budget','finance','admin'))";
    result=version===0?await db.prepare(`INSERT INTO department_budget (status,total,items,events,updated_at,department,year,version)
      SELECT ?,?,?,?, ?,?,?,1 WHERE ${assignment} ON CONFLICT(department,year) DO NOTHING`)
      .bind(...fields,'['+event('')+']',now,department,year,email,department).run():
      await db.prepare(`UPDATE department_budget SET status=CASE WHEN ?='draft' AND status='returned' THEN status ELSE ? END,
        total=?,items=?,events=CASE WHEN ?='submit' THEN json_insert(events,'$[#]',json(?)) ELSE events END,updated_at=?,version=version+1
        WHERE department=? AND year=? AND version=? AND status IN ('draft','returned') AND ${assignment}`)
        .bind(fields[0],...fields,action,event(''),now,department,year,version,email,department).run();
  }else{
    const note=text(body.note??'',500);
    if(note===null||(action==='return'&&!note))return error('退回时请填写原因，意见最多 500 字。',400);
    result=await db.prepare(`UPDATE department_budget SET status=?,events=json_insert(events,'$[#]',json(?)),updated_at=?,version=version+1
      WHERE department=? AND year=? AND version=? AND status='submitted'
      AND EXISTS (SELECT 1 FROM member WHERE email=? AND role IN ('admin','finance'))`)
      .bind(action==='approve'?'approved':'returned',event(note),now,department,year,version,email).run();
  }
  return result.meta.changes?json({ok:true}):error('预算状态或内容已变化。请返回列表后重新打开预算，再核对改动。',409);
}
