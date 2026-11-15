import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {mysqlStore} from './mysql.mjs';
import {valid} from './worker.js';

const db=new DatabaseSync(process.env.FINANCE_DB||'finance.sqlite');
db.exec(`CREATE TABLE IF NOT EXISTS credential(email TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session(token TEXT PRIMARY KEY,email TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS member(email TEXT PRIMARY KEY,role TEXT NOT NULL);`);
const email=(process.argv[3]||'').trim().toLowerCase();
if(process.argv[2]==='account'){
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw Error('用法：node local.mjs account user@example.com');
  const pass=randomBytes(24).toString('base64url');
  const salt=randomBytes(16).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO credential VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET salt=excluded.salt,hash=excluded.hash').run(email,salt,scryptSync(pass,salt,64).toString('hex'));
    db.prepare('DELETE FROM session WHERE email=?').run(email);
    db.prepare("INSERT INTO member SELECT ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM member)").run(email);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  console.log(email+' 的登录密码（仅显示一次）：'+pass);
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
const port=Number(process.env.FINANCE_PORT||8787);
const origin='http://127.0.0.1:'+port;
const digest=v=>createHash('sha256').update(v).digest('hex');
const cookie=(v,age)=>'finance_session='+v+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age;
const loginPage='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>财务管理工作台 · 登录</title><style>body{margin:12vh auto;padding:24px;max-width:390px;background:#f3f6fa;color:#17263b;font:16px system-ui}form{background:white;padding:24px;border-radius:14px}label{display:grid;gap:6px;margin:14px 0}input,button{padding:10px;font:inherit}button{background:#076c67;color:white;border:0;border-radius:6px}</style><h1>财务管理工作台</h1><form method="post" action="/signin-with-chatgpt"><label>邮箱<input type="email" name="email" autocomplete="username" required></label><label>登录密码<input type="password" name="password" autocomplete="current-password" required></label><button>登录</button></form></html>';
createServer(async (incoming,outgoing)=>{
  try{
    if(incoming.headers.host!=='127.0.0.1:'+port){outgoing.writeHead(400).end();return}
    const url=new URL(incoming.url,origin);
    const headers=new Headers(incoming.headers);
    for(const key of ['oai-authenticated-user-id','oai-authenticated-user-email'])headers.delete(key);
    const session=headers.get('cookie')?.match(/(?:^|; )finance_session=([\w-]{43})(?:;|$)/)?.[1];
    const token=session&&digest(session);
    const account=token&&db.prepare('SELECT email FROM session WHERE token=? AND expires>?').get(token,Date.now());
    if(account){headers.set('oai-authenticated-user-id',account.email);headers.set('oai-authenticated-user-email',account.email)}
    const chunks=[];let length=0;
    if(incoming.method==='POST'){
      for await(const chunk of incoming){
        length+=chunk.length;
        if(length>1000000){outgoing.writeHead(413).end();return}
        chunks.push(chunk);
      }
    }
    const data=Buffer.concat(chunks);
    let response;
    if(url.pathname==='/signin-with-chatgpt'){
      const hasAccount=db.prepare('SELECT 1 FROM credential LIMIT 1').get();
      const page=hasAccount?loginPage:loginPage.replace('<form','<p>首次使用，请在网站目录的 PowerShell 中运行 <code>node local.mjs account 你的邮箱</code>，然后刷新此页并使用终端生成的密码登录。</p><form');
      response=new Response(page,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
      if(incoming.method==='POST'){
        if(headers.get('origin')!==origin){outgoing.writeHead(403).end();return}
        const form=new URLSearchParams(data.toString());
        const user=(form.get('email')||'').trim().toLowerCase();
        const pass=form.get('password')||'';
        const row=db.prepare('SELECT salt,hash FROM credential WHERE email=?').get(user);
        const key=scryptSync(pass.slice(0,250),row?.salt||'invalid-account',64);
        if(row&&pass.length===32&&timingSafeEqual(key,Buffer.from(row.hash,'hex'))){
          const value=randomBytes(32).toString('base64url');
          db.prepare('DELETE FROM session WHERE expires<=?').run(Date.now());
          db.prepare('INSERT INTO session VALUES (?,?,?)').run(digest(value),user,Date.now()+28800000);
          response=new Response(null,{status:303,headers:{Location:'/', 'Set-Cookie':cookie(value,28800)}});
        }else response=new Response(loginPage.replace('<form','<p role="alert">邮箱或密码无效。</p><form'),{status:401,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
      }
    }else if(url.pathname==='/signout-with-chatgpt'){
      if(token)db.prepare('DELETE FROM session WHERE token=?').run(token);
      response=new Response(null,{status:303,headers:{Location:'/signin-with-chatgpt', 'Set-Cookie':cookie('',0)}});
    }else if(incoming.method==='GET'&&url.pathname==='/monthly-template.xlsx'){
      const member=account&&db.prepare('SELECT role FROM member WHERE email=?').get(account.email);
      if(!member||!['admin','finance'].includes(member.role))response=new Response('Forbidden',{status:403});
      else{
        const template=await readFile(new URL('./monthly-template.xlsx',import.meta.url)).catch(error=>{
          if(error.code!=='ENOENT')throw error;
          return null;
        });
        response=template?new Response(template,{headers:{
        'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':'attachment; filename="monthly-template.xlsx"; filename*=UTF-8\'\''+encodeURIComponent('月度财务报表模版.xlsx'),
        'Cache-Control':'no-store'
        }}):new Response('请将公司模板保存为网站目录中的 monthly-template.xlsx。',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
      }
    }else if(!account&&!url.pathname.startsWith('/api/')){
      response=new Response(null,{status:303,headers:{Location:'/signin-with-chatgpt'}});
    }else{
      const req=new Request(url,{method:incoming.method,headers,body:incoming.method==='POST'?data:undefined});
      response=await app.fetch(req,{DB:adapter,DATA:dataStore});
      if(response.headers.get('content-type')?.startsWith('text/html')){
        response=new Response((await response.text()).replaceAll('ChatGPT','工作台'),{status:response.status,headers:response.headers});
      }
    }
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error(error.message);outgoing.writeHead(500).end('服务内部错误')}
}).listen(port,'127.0.0.1',()=>console.log(origin));
