import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {accountPage} from './account-page.mjs';

const signin='/signin-with-chatgpt';
const signout='/signout-with-chatgpt';
const modes=new Map([
  [signin,'login'],['/account/register','register'],['/account/reset','reset'],
  ['/account/password','password'],['/account/access','access']
]);
const sessionSeconds=28800;
const ttl={invite:86400000,reset:1800000};
const success={registered:'账号已注册，请使用新密码登录。',reset:'密码已重置，请使用新密码登录。',changed:'密码已更新，所有旧会话已退出。请重新登录。'};
const normalize=value=>value.trim().toLowerCase();
export const validEmail=email=>email.length<=254&&/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email);
const digest=value=>createHash('sha256').update(value).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
const redirect=(location,cookie)=>new Response(null,{status:303,headers:{Location:location,'Cache-Control':'no-store',...(cookie?{'Set-Cookie':cookie}:{})}});

function transaction(db,action){
  db.exec('BEGIN IMMEDIATE');
  try{const result=action();db.exec('COMMIT');return result}
  catch(error){db.exec('ROLLBACK');throw error}
}
function passwordHash(pass){
  const salt=randomBytes(16).toString('hex');
  return {salt,hash:scryptSync(pass,salt,64).toString('hex')};
}
function verify(row,pass){
  const key=scryptSync(pass.slice(0,250),row?.salt||'invalid-account',64);
  return !!row&&pass.length<=250&&timingSafeEqual(key,Buffer.from(row.hash,'hex'));
}
function newPasswordError(pass,confirm){
  if(pass.length<12||pass.length>128)return '新密码须为 12–128 个字符。';
  if(pass!==confirm)return '两次输入的新密码不一致。';
  return '';
}

export function initializeAccounts(db){
  db.exec(`PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS credential(email TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS session(token TEXT PRIMARY KEY,email TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS member(email TEXT PRIMARY KEY,role TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS account_code(email TEXT NOT NULL,purpose TEXT NOT NULL,digest TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(email,purpose));`);
}

export function setTerminalPassword(db,email){
  const pass=randomBytes(24).toString('base64url');
  const {salt,hash}=passwordHash(pass);
  transaction(db,()=>{
    const initial=!db.prepare('SELECT 1 FROM credential LIMIT 1').get();
    db.prepare('INSERT INTO credential VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET salt=excluded.salt,hash=excluded.hash').run(email,salt,hash);
    db.prepare('DELETE FROM session WHERE email=?').run(email);
    db.prepare('DELETE FROM account_code WHERE email=?').run(email);
    if(initial)db.prepare("INSERT INTO member SELECT ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM member)").run(email);
  });
  return pass;
}

export function localAccounts(db,origin){
  const sessionCookie=(value,age)=>'finance_session='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(origin.startsWith('https:')?'; Secure':'');
  const clearCookie=()=>sessionCookie('',0);
  const credential=db.prepare('SELECT salt,hash FROM credential WHERE email=?');
  const member=db.prepare('SELECT role FROM member WHERE email=?');
  const session=db.prepare('SELECT email FROM session WHERE token=? AND expires>?');
  const code=db.prepare('SELECT digest FROM account_code WHERE email=? AND purpose=? AND expires>?');
  const clearCodes=db.prepare('DELETE FROM account_code WHERE email=?');
  const clearSessions=db.prepare('DELETE FROM session WHERE email=?');
  const windows=new Map();
  function limited(mode){
    const now=Date.now();
    let entry=windows.get(mode);
    if(!entry||now>=entry.end){entry={count:0,end:now+60000};windows.set(mode,entry)}
    return ++entry.count>20?Math.max(1,Math.ceil((entry.end-now)/1000)):0;
  }
  function page(mode,values={},status=200,headers={}){
    const nonce=randomBytes(18).toString('base64');
    const bootstrap=mode==='login'&&!db.prepare('SELECT 1 FROM credential LIMIT 1').get();
    return new Response(accountPage(mode,{...values,nonce,bootstrap,error:status>=400}),{status,headers:{
      'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; style-src 'nonce-"+nonce+"'; script-src 'nonce-"+nonce+"'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",...headers
    }});
  }
  return {
    recognizes:path=>modes.has(path)||path===signout,
    identity(headers){
      const value=headers.get('cookie')?.match(/(?:^|;\s*)finance_session=([\w-]{43})(?:;|$)/)?.[1];
      if(!value)return undefined;
      const token=digest(value),account=session.get(token,Date.now());
      return account&&{email:account.email,token};
    },
    handle(url,method,headers,data,account){
      const path=url.pathname,mode=modes.get(path);
      if(method!=='GET'&&method!=='POST'||path===signout&&method!=='POST'){
        return new Response('请求方法无效',{status:405,headers:{Allow:path===signout?'POST':'GET, POST'}});
      }
      if(method==='POST'&&(headers.get('origin')!==origin||headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded')){
        return new Response('无效请求来源或格式',{status:403});
      }
      if(path===signout){
        if(account)db.prepare('DELETE FROM session WHERE token=?').run(account.token);
        return redirect(signin,clearCookie());
      }
      if((mode==='password'||mode==='access')&&!account)return redirect(signin);
      if(mode==='access'&&member.get(account.email)?.role!=='admin'){
        return page(mode,{message:'只有管理员可以生成邀请码和重置码。',blocked:true},403);
      }
      if(method==='GET'){
        const result=url.searchParams.get('result');
        const message=mode==='login'&&Object.hasOwn(success,result)?success[result]:'';
        if(mode==='login'&&account&&!message)return redirect('/');
        return page(mode,{message});
      }
      const form=new URLSearchParams(data.toString('utf8'));
      const field=name=>form.get(name)||'';
      const email=normalize(field('email')).slice(0,255);
      const purpose=field('purpose');
      const fail=(message,status=400,headers)=>page(mode,{email:email.slice(0,254),purpose,message},status,headers);
      const retry=limited(mode);
      if(retry)return fail('操作过于频繁，请稍后再试。',429,{'Retry-After':String(retry)});
      if(mode==='login'){
        const pass=field('password');
        const value=secret(),now=Date.now();
        const valid=transaction(db,()=>{
          if(!verify(credential.get(email),pass))return false;
          db.prepare('DELETE FROM session WHERE expires<=? OR token=?').run(now,account?.token||'');
          db.prepare('INSERT INTO session VALUES (?,?,?)').run(digest(value),email,now+sessionSeconds*1000);
          return true;
        });
        if(!valid)return fail('邮箱或密码不正确。',401);
        return redirect('/',sessionCookie(value,sessionSeconds));
      }
      if(mode!=='password'&&!validEmail(email))return fail('请输入有效的邮箱地址。');
      if(mode==='access'){
        if(!Object.hasOwn(ttl,purpose))return fail('请选择邀请码或重置码。');
        const value=secret(),now=Date.now();
        const error=transaction(db,()=>{
          if(member.get(account.email)?.role!=='admin')return '只有管理员可以生成邀请码和重置码。';
          if(!member.get(email))return '请先在「人员权限」为这个邮箱分配角色。';
          const exists=!!credential.get(email);
          if(purpose==='invite'&&exists)return '该邮箱已有账号。忘记密码时请选择「重置密码」。';
          if(purpose==='reset'&&!exists)return '该邮箱尚未注册。请先发送邀请码。';
          db.prepare('DELETE FROM account_code WHERE expires<=?').run(now);
          db.prepare('INSERT INTO account_code VALUES (?,?,?,?) ON CONFLICT(email,purpose) DO UPDATE SET digest=excluded.digest,expires=excluded.expires').run(email,purpose,digest(value),now+ttl[purpose]);
          return '';
        });
        return error?fail(error,409):page(mode,{email,purpose,code:value});
      }
      const pass=field('newPassword');
      const policyError=newPasswordError(pass,field('confirmPassword'));
      if(policyError)return fail(policyError);
      if(mode==='password'){
        const current=field('currentPassword');
        const error=transaction(db,()=>{
          if(!session.get(account.token,Date.now())||!verify(credential.get(account.email),current))return '当前密码不正确，或登录已过期。';
          if(current===pass)return '新密码不能与当前密码相同。';
          const {salt,hash}=passwordHash(pass);
          db.prepare('UPDATE credential SET salt=?,hash=? WHERE email=?').run(salt,hash,account.email);
          clearSessions.run(account.email);
          clearCodes.run(account.email);
          return '';
        });
        return error?fail(error):redirect(signin+'?result=changed',clearCookie());
      }
      const value=field('code').trim();
      const kind=mode==='register'?'invite':'reset';
      const used=/^[\w-]{43}$/.test(value)&&transaction(db,()=>{
        const issued=code.get(email,kind,Date.now());
        if(!issued||!timingSafeEqual(Buffer.from(issued.digest,'hex'),Buffer.from(digest(value),'hex'))||
          !member.get(email)||!!credential.get(email)!==(kind==='reset'))return false;
        const {salt,hash}=passwordHash(pass);
        db.prepare('INSERT INTO credential VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET salt=excluded.salt,hash=excluded.hash').run(email,salt,hash);
        clearCodes.run(email);
        clearSessions.run(email);
        return true;
      });
      if(!used)return fail('邮箱与验证码不匹配，或验证码已使用或过期。');
      // A reset performed while signed into a different account leaves that session alone.
      return redirect(signin+'?result='+(kind==='invite'?'registered':'reset'),account?.email===email?clearCookie():undefined);
    }
  };
}
