import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,rmdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

const login='/signin-with-chatgpt';
const access='/account/access';
const register='/account/register';
const reset='/account/reset';
const change='/account/password';
const admin='admin@example.com',user='member@example.com';
const original='a long first password',updated='a longer second password',recovered='a long recovered password';

test('local account lifecycle, permissions and session revocation',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'finance-account-test-'));
  const file=join(folder,'test.sqlite');
  t.after(async()=>{
    for(const suffix of ['','-journal','-shm','-wal'])await rm(file+suffix,{force:true});
    await rmdir(folder);
  });
  const reservation=createServer().listen(0,'127.0.0.1');
  await once(reservation,'listening');
  const {port}=reservation.address();
  await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
  const env={...process.env,FINANCE_DB:file,FINANCE_PORT:String(port),FINANCE_STORAGE:'sqlite',FINANCE_ERP_DB:process.env.FINANCE_TEST_ERP_DB||join(folder,'no-erp.sqlite')};
  delete env.FINANCE_PUBLIC_ORIGIN;
  delete env.FINANCE_BI_MODELS;
  delete env.FINANCE_BI_DEFAULT_MODEL;
  const adminPassword=execFileSync(process.execPath,['local.mjs','account',admin],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim().split('：').at(-1);
  const service=spawn(process.execPath,['local.mjs'],{env,stdio:['ignore','pipe','pipe']});
  let stderr='';
  service.stderr.on('data',chunk=>{stderr+=chunk});
  try{
    const origin='http://127.0.0.1:'+port;
    const [ready]=await Promise.race([
      once(service.stdout,'data',{signal:AbortSignal.timeout(15000)}),
      once(service,'exit').then(()=>{throw Error(stderr||'Server stopped before startup')})
    ]);
    assert.match(ready.toString(),new RegExp(String(port)));
    const request=(path,{form,cookie,json,source=origin}={})=>fetch(origin+path,{
      method:form||json?'POST':'GET',redirect:'manual',
      headers:{...(cookie?{Cookie:cookie}:{}),...(form||json?{Origin:source,'Content-Type':form?'application/x-www-form-urlencoded':'application/json'}:{})},
      body:form?new URLSearchParams(form):json?JSON.stringify(json):undefined
    });
    async function signIn(email,password){
      const result=await request(login,{form:{email,password}});
      assert.equal(result.status,303);
      const cookie=result.headers.get('set-cookie');
      assert.match(cookie,/HttpOnly; SameSite=Strict/);
      return cookie.split(';')[0];
    }
    const authApi=cookie=>request('/api/state',{cookie});
    const setRole=(cookie,email,role)=>request('/api/members',{cookie,json:{email,role}});
    async function issue(cookie,email,purpose){
      const result=await request(access,{cookie,form:{email,purpose}});
      assert.equal(result.status,200);
      assert.equal(result.headers.get('cache-control'),'no-store');
      return (await result.text()).match(/id="generated"[^>]*value="([\w-]{43})"/)?.[1];
    }
    const redeem=(path,email,code,newPassword=original,confirmPassword=newPassword)=>request(path,{form:{email,code,newPassword,confirmPassword}});
    assert.equal((await request('/')).headers.get('location'),login);
    const page=await request(login);
    assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'),'same-origin');
    const markup=await page.text();
    assert.match(markup,/注册账号/);
    assert.match(markup,/忘记密码/);
    assert.equal((await request(change)).headers.get('location'),login);
    assert.equal((await request(login,{source:'http://elsewhere.invalid',form:{email:admin,password:adminPassword}})).status,403);

    const adminCookie=await signIn(admin,adminPassword);
    assert.equal((await authApi(adminCookie)).status,200);
    assert.equal((await request('/api/erp/customers')).status,401);
    if(process.env.FINANCE_TEST_ERP_DB){
      const {erp}=await (await authApi(adminCookie)).json();
      assert.ok(erp?.months.length>0);
      const {rows}=await (await request('/api/erp/customers',{cookie:adminCookie})).json();
      assert.ok(rows.length>0&&rows.length<=50);
      assert.ok(rows.every(r=>r.days_181_plus===(r.book===null?null:r.book-r.current-r.days_1_90-r.days_91_180)));
      const customer=rows.find(r=>r.order_count>0).customer;
      const orders=await (await request('/api/erp/orders?'+new URLSearchParams({customer}),{cookie:adminCookie})).json();
      assert.equal(orders.customer.customer,customer);
      assert.equal(orders.customer.days_181_plus,rows.find(r=>r.customer===customer).days_181_plus);
      assert.ok(orders.rows.length>0&&orders.rows.every(r=>r.customer===customer&&r.paid+r.estimated===r.ar_basis));
      const month=erp.months[0].id;
      const revenue=await (await request('/api/erp/revenue?'+new URLSearchParams({month}),{cookie:adminCookie})).json();
      assert.ok(revenue.rows.length>0&&revenue.rows.every(r=>r.date.startsWith(month)&&r.order_no));
    }
    const desktop=await request('/',{cookie:adminCookie});
    assert.match(await desktop.text(),/data-account-mode="local"/);
    assert.equal((await request(access,{cookie:adminCookie,form:{email:user,purpose:'invite'}})).status,409);
    assert.equal((await setRole(adminCookie,user,'viewer')).status,200);
    const superseded=await issue(adminCookie,user,'invite');
    const invite=await issue(adminCookie,user,'invite');
    assert.ok(invite&&superseded&&invite!==superseded);
    assert.equal((await redeem(register,user,superseded)).status,400);
    assert.equal((await redeem(register,'other@example.com',invite)).status,400);
    assert.equal((await redeem(register,user,invite,'short')).status,400);
    assert.equal((await redeem(register,user,invite,original,updated)).status,400);
    assert.equal((await redeem(register,user,invite)).headers.get('location'),login+'?result=registered');
    assert.equal((await redeem(register,user,invite)).status,400);

    const firstSession=await signIn(user,original),secondSession=await signIn(user,original);
    assert.equal((await (await authApi(firstSession)).json()).role,'viewer');
    await t.test('skill publishing, download and visibility follow workplace roles',async()=>{
      const catalog='/api/skills';
      const markdown='---\nname: month-end\n---\n# 月结核对\n';
      const skill={name:'月结核对',category:'月结',version:'1.0.0',summary:'核对月结余额',instructions:'导出测试台账后运行。',markdown};
      const list=async cookie=>(await (await request(catalog,{cookie})).json()).skills;
      const changeSkill=(path,cookie,json)=>request(path,{cookie,json});
      assert.equal((await request(catalog)).status,401);
      assert.match(await (await request('/#skills',{cookie:firstSession})).text(),/技能中心/);
      assert.deepEqual(await list(firstSession),[]);
      assert.equal((await changeSkill(catalog,firstSession,skill)).status,403);
      assert.equal((await request(catalog,{cookie:adminCookie,json:skill,source:'https://elsewhere.invalid'})).status,403);
      assert.equal((await changeSkill(catalog,adminCookie,{...skill,markdown:''})).status,400);
      assert.equal((await changeSkill(catalog,adminCookie,{...skill,launch_url:'javascript:alert(1)'})).status,400);
      const linked=await changeSkill(catalog,adminCookie,{...skill,name:'对账工具',markdown:'',launch_url:'https://tools.example.com/reconcile'});
      assert.equal(linked.status,201);
      const adminUrl=catalog+'/'+(await linked.json()).id;
      assert.equal((await setRole(adminCookie,user,'finance')).status,200);
      assert.equal((await changeSkill(adminUrl,firstSession,{action:'unpublish'})).status,403);
      const created=await changeSkill(catalog,firstSession,skill);
      assert.equal(created.status,201);
      const skillUrl=catalog+'/'+(await created.json()).id;
      assert.equal((await changeSkill(skillUrl,firstSession,{...skill,version:'1.1.0'})).status,200);
      assert.equal((await setRole(adminCookie,user,'viewer')).status,200);
      const entry=(await list(firstSession)).find(s=>s.owner===user);
      assert.equal(entry?.version,'1.1.0');
      assert.equal(entry.markdown,undefined);
      const detail=(await (await request(skillUrl,{cookie:firstSession})).json()).skill;
      assert.equal(detail.instructions,skill.instructions);
      assert.equal(detail.has_file,true);
      assert.equal(detail.markdown,undefined);
      assert.equal((await request(skillUrl+'/edit',{cookie:firstSession})).status,403);
      assert.equal((await changeSkill(skillUrl,firstSession,{action:'unpublish'})).status,403);
      const downloaded=await request(skillUrl+'/download',{cookie:firstSession});
      assert.equal(downloaded.headers.get('content-disposition'),'attachment; filename="SKILL.md"');
      assert.equal(await downloaded.text(),markdown);
      assert.equal((await request(skillUrl+'/download')).status,401);
      assert.equal((await request(adminUrl+'/download',{cookie:firstSession})).status,404);
      assert.equal((await (await request(adminUrl,{cookie:firstSession})).json()).skill.launch_url,'https://tools.example.com/reconcile');
      assert.equal((await changeSkill(skillUrl,adminCookie,{action:'unpublish'})).status,200);
      assert.ok(!(await list(firstSession)).some(s=>s.id===entry.id));
      assert.equal((await request(skillUrl,{cookie:firstSession})).status,404);
      assert.equal((await request(skillUrl+'/download',{cookie:firstSession})).status,404);
      assert.equal((await list(adminCookie)).find(s=>s.id===entry.id).published,0);
      assert.equal((await setRole(adminCookie,user,'finance')).status,200);
      assert.equal((await list(firstSession)).find(s=>s.id===entry.id).published,0);
      assert.equal((await (await request(skillUrl+'/edit',{cookie:firstSession})).json()).skill.markdown,markdown);
      assert.equal((await changeSkill(skillUrl,firstSession,{action:'publish'})).status,200);
      assert.equal((await setRole(adminCookie,user,'viewer')).status,200);
      assert.equal((await list(firstSession)).find(s=>s.id===entry.id).published,1);
      assert.equal((await request(skillUrl+'/download',{cookie:firstSession})).status,200);
    });
    assert.equal((await request(access,{cookie:firstSession,form:{email:admin,purpose:'reset'}})).status,403);
    const modify=currentPassword=>request(change,{cookie:firstSession,form:{currentPassword,newPassword:updated,confirmPassword:updated}});
    assert.equal((await modify('incorrect')).status,400);
    assert.equal((await modify(original)).headers.get('location'),login+'?result=changed');
    assert.equal((await authApi(firstSession)).status,401);
    assert.equal((await authApi(secondSession)).status,401);
    assert.equal((await request(login,{form:{email:user,password:original}})).status,401);
    const thirdSession=await signIn(user,updated);

    const expired=await issue(adminCookie,user,'reset');
    const db=new DatabaseSync(file);
    try{db.prepare("UPDATE account_code SET expires=0 WHERE email=? AND purpose='reset'").run(user)}finally{db.close()}
    assert.equal((await redeem(reset,user,expired,recovered)).status,400);
    const revoked=await issue(adminCookie,user,'reset');
    assert.equal((await setRole(adminCookie,user,'remove')).status,200);
    assert.equal((await authApi(thirdSession)).status,403);
    assert.equal((await setRole(adminCookie,user,'viewer')).status,200);
    assert.equal((await redeem(reset,user,revoked,recovered)).status,400);
    const resetCode=await issue(adminCookie,user,'reset');
    assert.equal((await redeem(reset,user,resetCode,recovered)).headers.get('location'),login+'?result=reset');
    assert.equal((await redeem(reset,user,resetCode,recovered)).status,400);
    assert.equal((await authApi(thirdSession)).status,401);
    assert.equal((await authApi(adminCookie)).status,200);
    const finalSession=await signIn(user,recovered);
    await t.test('BI generation follows workbench roles and calculates report figures',async()=>{
      const input={model:'local',period:'2026-10',prompt:'看 10 月营业收入和毛利率'};
      const generate=(cookie,source)=>request('/api/bi/generate',{cookie,json:input,source});
      assert.equal((await generate()).status,401);
      assert.equal((await generate(finalSession,'https://unrelated.invalid')).status,403);
      assert.equal((await request('/api/import',{cookie:adminCookie,json:{type:'report',rows:[
        {id:'2026-10',revenue:100000,cost:62000,expense:1000,cash:1500}
      ]}})).status,200);
      const state=await (await authApi(finalSession)).json();
      assert.deepEqual(state.bi,{defaultModel:'local',models:[{id:'local',name:'本地规则',provider:'工作台',model:null}]});
      const result=await generate(finalSession);
      assert.equal(result.status,200);
      assert.deepEqual((await result.json()).results.map(r=>r.points[0].value),[100000,.38]);
    });
    await t.test('annual department budget is private and can be returned, resubmitted and approved',async()=>{
      const department='市场部',other='研发部',year=2027;
      const finance='finance@example.com',engineer='engineer@example.com';
      const path='/api/budgets/detail';
      const assign=(email,role,department)=>request('/api/members',{cookie:adminCookie,json:{email,role,department}});
      const list=cookie=>request('/api/budgets?'+new URLSearchParams({year}),{cookie});
      const detail=(cookie,department)=>request(path+'?'+new URLSearchParams({year,department}),{cookie});
      const write=(cookie,action,version,fields={})=>request(path,{cookie,json:{department,year,action,version,...fields}});
      const items=[{subject:'市场推广',month:1,amount:300005,note:'展会预付款'},{subject:'市场推广',month:2,amount:499995}];
      async function createMember(email,role,department){
        assert.equal((await assign(email,role,department)).status,200);
        assert.equal((await redeem(register,email,await issue(adminCookie,email,'invite'))).status,303);
        return signIn(email,original);
      }
      assert.equal((await list()).status,401);
      assert.equal((await assign(user,'budget','')).status,400);
      assert.equal((await assign(user,'budget',department)).status,200);
      const financialCookie=await createMember(finance,'finance','');
      const engineerCookie=await createMember(engineer,'budget',other);
      assert.deepEqual(await (await authApi(finalSession)).json(),{email:user,role:'budget',members:[],ar:[],report:[],erp:null});
      assert.equal((await request('/api/skills',{cookie:finalSession})).status,403);
      assert.equal((await request('/api/bi/generate',{cookie:finalSession,json:{model:'local',period:'2026-10',prompt:'营业收入'}})).status,403);
      assert.equal((await request('/monthly-template.xlsx',{cookie:finalSession})).status,403);
      assert.equal((await detail(finalSession,department)).status,404);
      assert.equal((await write(finalSession,'save',0,{department:other,items})).status,403);
      assert.equal((await write(finalSession,'submit',0,{items:[]})).status,400);
      assert.equal((await write(finalSession,'save',0,{items:[{subject:'错误月份',month:13,amount:1}]})).status,400);
      assert.equal((await write(finalSession,'save',0,{items:[{subject:'错误金额',month:1,amount:0.5}]})).status,400);
      assert.equal((await write(finalSession,'save',0,{items})).status,200);
      const saved=(await (await detail(finalSession,department)).json()).budget;
      assert.equal(saved.status,'draft');
      assert.equal(saved.total,800000);
      assert.equal(saved.items[0].note,'展会预付款');
      assert.equal((await detail(engineerCookie,department)).status,403);
      assert.deepEqual((await (await list(engineerCookie)).json()).rows,[]);
      assert.equal((await write(finalSession,'approve',saved.version)).status,403);
      assert.equal((await write(finalSession,'submit',saved.version,{items})).status,200);
      assert.equal((await write(finalSession,'save',saved.version,{items:[]})).status,409);
      assert.equal((await write(finalSession,'save',saved.version+1,{items})).status,409);
      assert.equal((await write(financialCookie,'return',saved.version+1)).status,400);
      const summary=await (await list(financialCookie)).json();
      assert.deepEqual(new Set(summary.departments),new Set([department,other]));
      assert.equal(summary.rows[0].status,'submitted');
      assert.equal(summary.rows[0].items,undefined);
      assert.equal((await write(financialCookie,'return',saved.version+1,{note:'请更新二月金额。'})).status,200);
      const returned=(await (await detail(finalSession,department)).json()).budget;
      assert.equal(returned.status,'returned');
      assert.equal(returned.events.at(-1).note,'请更新二月金额。');
      items[1].amount=600000;
      assert.equal((await write(finalSession,'save',returned.version,{items})).status,200);
      const revised=(await (await detail(finalSession,department)).json()).budget;
      assert.equal(revised.status,'returned');
      assert.equal((await write(finalSession,'submit',revised.version,{items})).status,200);
      assert.equal((await write(financialCookie,'approve',revised.version+1)).status,200);
      const approved=(await (await detail(adminCookie,department)).json()).budget;
      assert.equal(approved.status,'approved');
      assert.equal(approved.total,900005);
      assert.deepEqual(approved.events.map(event=>event.action),['save','submit','return','submit','approve']);
      assert.equal((await write(finalSession,'submit',approved.version,{items})).status,409);
      assert.equal((await assign(user,'budget',other)).status,200);
      assert.equal((await detail(finalSession,department)).status,403);
      assert.equal((await assign(user,'viewer',other)).status,200);
      assert.equal((await write(finalSession,'save',0,{department:other,items})).status,403);
    });
    const logout=await request('/signout-with-chatgpt',{cookie:finalSession,form:{}});
    assert.equal(logout.headers.get('location'),login);
    assert.equal((await authApi(finalSession)).status,401);
  }finally{
    if(service.exitCode===null&&service.signalCode===null){
      const stopped=once(service,'exit');
      service.kill();
      await stopped;
    }
  }
});
