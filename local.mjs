import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {mysqlStore} from './mysql.mjs';
import {erpStore} from './erp-store.mjs';
import {wecomSender} from './wecom.mjs';
import {valid} from './worker.js';
import {configureBiModels} from './bi-ai.mjs';
import {initializeAccounts,localAccounts,setTerminalPassword,validEmail} from './accounts.mjs';

const db=new DatabaseSync(process.env.FINANCE_DB||'finance.sqlite');
initializeAccounts(db);
const email=(process.argv[3]||'').trim().toLowerCase();
if(process.argv[2]==='account'){
  if(!validEmail(email))throw Error('用法：node local.mjs account user@example.com');
  console.log(email+' 的登录密码（仅显示一次）：'+setTerminalPassword(db,email));
  process.exit();
}
const mode=process.argv[2]||'serve';
if(!['serve','mysql-check','mysql-migrate','erp-import'].includes(mode))throw Error('用法：node local.mjs [serve|mysql-check|mysql-migrate|erp-import 文件]');
const dataStore=mode!=='serve'||process.env.FINANCE_STORAGE==='mysql'?mysqlStore():undefined;
if(dataStore)await dataStore.check();
if(mode==='mysql-check'){console.log('MySQL 连接及数据表正常。');process.exit()}
if(mode==='mysql-migrate'){
  const rows=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record'").get()?db.prepare('SELECT type,id,data FROM record ORDER BY type,id').all():[];
  for(let i=0;i<rows.length;i+=500)await dataStore.write(rows.slice(i,i+500),true);
  console.log('已扫描 '+rows.length+' 条 SQLite 记录。MySQL 中已有的记录保留。');
  process.exit();
}
if(mode==='erp-import'){
  const file=process.argv[3];
  if(!file)throw Error('用法：node local.mjs erp-import 文件.json');
  const {type,rows}=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
  if(!['ar','report'].includes(type)||!Array.isArray(rows)||!rows.length||rows.length>500||!rows.every(r=>valid(type,r))||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('ERP 文件类型或行数据无效，或有重复编号。每批最多 500 行。');
  await dataStore.write(rows.map(r=>({type,id:r.id,data:JSON.stringify(r)})));
  console.log('已写入 '+rows.length+' 条记录。');
  process.exit();
}
const biModels=configureBiModels(process.env);
execFileSync(process.execPath,['build.mjs']);
const app=(await import(pathToFileURL(resolve('dist/server/index.js')))).default;
const adapter={
  prepare(sql,args=[]){
    return {bind:(...values)=>adapter.prepare(sql,values),
      run:()=>({meta:db.prepare(sql).run(...args)}),
      first:()=>db.prepare(sql).get(...args),
      all:()=>({results:db.prepare(sql).all(...args)})};
  },
  batch(statements){
    db.exec('BEGIN IMMEDIATE');
    try{const results=statements.map(s=>s.run());db.exec('COMMIT');return results}
    catch(error){db.exec('ROLLBACK');throw error}
  }
};
const port=Number(process.env.FINANCE_PORT||8788);
const external=process.env.FINANCE_PUBLIC_ORIGIN;
if(external){
  const url=new URL(external);
  if(url.protocol!=='https:'||url.origin!==external)throw Error('FINANCE_PUBLIC_ORIGIN 须为 HTTPS 源地址（例如 https://finance.example.com，不含路径或末尾斜线）。');
}
const origin=external||'http://127.0.0.1:'+port;
const host=new URL(origin).host;
const accounts=localAccounts(db,origin);
const erp=erpStore(process.env.FINANCE_ERP_DB||resolve('finance-erp.sqlite'));
const wecom=wecomSender(resolve(process.env.FINANCE_WECOM_GROUPS_FILE||'finance-wecom.local.json'));
createServer(async (incoming,outgoing)=>{
  try{
    if(incoming.headers.host!==host||!incoming.url?.startsWith('/')){outgoing.writeHead(400).end();return}
    const url=new URL(incoming.url,origin);
    if(url.origin!==origin){outgoing.writeHead(400).end();return}
    const headers=new Headers(incoming.headers);
    for(const key of ['oai-authenticated-user-id','oai-authenticated-user-email'])headers.delete(key);
    const accountRoute=accounts.recognizes(url.pathname);
    const chunks=[];let length=0;
    if(incoming.method==='POST'){
      for await(const chunk of incoming){
        length+=chunk.length;
        if(length>(accountRoute?16384:1000000)){outgoing.writeHead(413).end();return}
        chunks.push(chunk);
      }
    }
    const data=Buffer.concat(chunks);
    const account=accounts.identity(headers);
    if(account){headers.set('oai-authenticated-user-id',account.email);headers.set('oai-authenticated-user-email',account.email)}
    let response;
    if(accountRoute){
      response=accounts.handle(url,incoming.method,headers,data,account);
    }else if(incoming.method==='GET'&&url.pathname==='/monthly-template.xlsx'){
      const member=account&&db.prepare('SELECT role FROM member WHERE email=?').get(account.email);
      if(!member||!['admin','finance'].includes(member.role))response=new Response('Forbidden',{status:403});
      else response=new Response(await readFile(new URL('./monthly-template.xlsx',import.meta.url)),{headers:{
        'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':'attachment; filename="monthly-template.xlsx"; filename*=UTF-8\'\''+encodeURIComponent('月度财务报表模版.xlsx'),
        'Cache-Control':'no-store'
      }});
    }else if(!account&&!url.pathname.startsWith('/api/')){
      response=new Response(null,{status:303,headers:{Location:'/signin-with-chatgpt'}});
    }else{
      const req=new Request(url,{method:incoming.method,headers,body:incoming.method==='POST'?data:undefined});
      response=await app.fetch(req,{DB:adapter,DATA:dataStore,ERP:erp,BI_MODELS:biModels,WECOM:wecom,LOCAL_ACCOUNTS:true});
      if(response.headers.get('content-type')?.startsWith('text/html')){
        response=new Response((await response.text()).replace('data-account-mode="hosted"','data-account-mode="local"'),{status:response.status,headers:response.headers});
      }
    }
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error(error.message);outgoing.writeHead(500).end('服务内部错误')}
}).listen(port,'127.0.0.1',()=>console.log(external?origin+' → http://127.0.0.1:'+port:origin));
