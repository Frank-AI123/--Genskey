const signin='/signin-with-chatgpt';
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const emailField=email=>`<label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" placeholder="name@company.com" value="${esc(email)}" required>`;
const passwordField=(name,label,newPassword=false)=>`<label for="${name}">${label}</label>
<div class="password"><input id="${name}" name="${name}" type="password" autocomplete="${newPassword?'new-password':'current-password'}" ${newPassword?'minlength="12" maxlength="128"':'maxlength="250"'} required><button type="button" class="reveal" data-reveal="${name}" aria-label="显示${label}" data-label="${label}">显示</button></div>`;
const newFields=passwordField('newPassword','新密码',true)+'<p class="hint">使用 12–128 个字符，可用易记的长词组。</p>'+passwordField('confirmPassword','确认新密码',true);
const codeField=label=>`<label for="code">${label}</label><input id="code" name="code" type="text" autocomplete="one-time-code" spellcheck="false" autocapitalize="none" maxlength="64" required>`;
const pages={
  login:{title:'登录工作台',description:'使用你的工作邮箱和密码继续。',action:signin,button:'登录',fields:email=>emailField(email)+passwordField('password','密码')+'<div class="form-link"><a href="/account/reset">忘记密码？</a></div>',footer:'还没有账号？ <a href="/account/register">注册账号</a>'},
  register:{title:'注册账号',description:'填写管理员提供邀请码时使用的邮箱，并设置自己的密码。',action:'/account/register',button:'注册账号',fields:email=>emailField(email)+codeField('邀请码')+newFields,footer:`已有账号？ <a href="${signin}">返回登录</a>`},
  reset:{title:'重置密码',description:'请联系管理员获取一次性重置码，再在下方设置新密码。',action:'/account/reset',button:'重置密码',fields:email=>emailField(email)+codeField('重置码')+newFields,footer:`记得密码？ <a href="${signin}">返回登录</a>`},
  password:{title:'修改密码',description:'验证当前密码后即可设置新密码。保存后，所有设备都需要重新登录。',action:'/account/password',button:'保存新密码',fields:()=>passwordField('currentPassword','当前密码')+newFields,footer:'<a href="/">返回工作台</a>'},
  access:{title:'邀请与重置',description:'邀请新成员前，请先在「人员权限」保存该邮箱的业务角色。验证码生成后，请私下交给对应成员。',action:'/account/access',button:'生成一次性码',fields:(email,purpose)=>emailField(email)+`<label for="purpose">用途</label><select id="purpose" name="purpose"><option value="invite">邀请注册 · 24 小时有效</option><option value="reset"${purpose==='reset'?' selected':''}>重置密码 · 30 分钟有效</option></select>`,footer:'<a href="/#members">返回人员权限</a>'}
};

export function accountPage(mode,{email='',message='',error=false,bootstrap=false,code='',purpose='',blocked=false,nonce}) {
  const page=pages[mode];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${page.title} · 财务管理工作台</title>
<style nonce="${nonce}">
*{box-sizing:border-box}
:root{color-scheme:light;--ink:#162838;--muted:#506271;--accent:#086b59;--line:#d5e0e7;--paper:#f4f7f9;font:15px/1.55 "Microsoft YaHei",system-ui,sans-serif}
body{margin:0;color:var(--ink);background:var(--paper);min-height:100vh;min-height:100dvh;display:grid;grid-template-columns:minmax(285px,38fr) minmax(0,62fr)}
.side{background:#142939;color:#eafbfa;display:flex;flex-direction:column;justify-content:space-between;gap:40px;padding:clamp(28px,5vw,76px);position:relative;overflow:hidden}
.side::after{content:"";position:absolute;inset:auto -94px -145px auto;width:390px;height:390px;border:1px solid #83d1be48;border-radius:50%;box-shadow:0 0 0 45px #83d1be12,0 0 0 90px #83d1be10;pointer-events:none}
.brand{display:flex;align-items:center;gap:12px;font-weight:700}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;color:#e8fffa;background:#126d64}
.eyebrow{color:#a4e1d2;font-size:.8rem;font-weight:700;letter-spacing:.13em}.side-title{font-size:clamp(25px,3vw,42px);line-height:1.24;font-weight:700;margin:12px 0}.side-note{color:#c6d9df;max-width:19em;margin:0}.side-footer{font-size:.85rem;color:#bed4da}
main{display:grid;place-items:center;padding:32px 24px}.card{width:min(100%,464px);background:white;border:1px solid #e1e8eb;border-radius:22px;box-shadow:0 18px 52px #193b4910;padding:clamp(24px,4vw,42px)}
h1{font-size:clamp(25px,3vw,32px);line-height:1.25;margin:0 0 10px}.intro{color:var(--muted);margin:0 0 24px}
label{font-weight:650;display:block;margin:16px 0 6px}input,select,button{font:inherit}input,select{width:100%;min-height:44px;border:1px solid #afc0cc;border-radius:9px;padding:9px 12px;background:#fff;color:var(--ink)}input::placeholder{color:#687987}.password{position:relative}.password input{padding-right:62px}
.reveal{position:absolute;right:3px;top:3px;bottom:3px;padding:0 11px;color:var(--accent);background:transparent;border:0;border-radius:6px;cursor:pointer}
a{color:var(--accent);font-weight:650;text-underline-offset:3px}a:hover,.reveal:hover{text-decoration:underline}a:focus-visible,input:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid #4a93b0;outline-offset:2px}
.form-link{text-align:right;margin-top:10px}.hint{color:var(--muted);font-size:.87rem;margin:5px 0}.primary{display:block;width:100%;border:0;border-radius:9px;padding:12px;margin-top:24px;background:var(--accent);color:white;font-weight:700;cursor:pointer}.primary:hover{background:#065545}
.footer{text-align:center;border-top:1px solid var(--line);padding-top:19px;margin:23px 0 0;color:var(--muted)}
.message,.generated{padding:11px 13px;border:1px solid #b6d9cd;border-radius:9px;background:#edf8f3;color:#235b4b;margin:0 0 16px;overflow-wrap:anywhere}.error{color:#842d27;background:#fff1ef;border-color:#edccc8}.generated input{font:14px ui-monospace,monospace}.generated label{margin:0 0 6px}
@media(max-width:700px){body{display:block}.side{padding:17px 22px}.side-copy,.side-footer{display:none}main{padding:24px 14px}.card{border-radius:16px}}
</style></head><body>
<aside class="side" aria-label="平台信息"><div class="brand"><span class="mark" aria-hidden="true">财</span>财务管理工作台</div><div class="side-copy"><span class="eyebrow">财务运营</span><p class="side-title">财务数据，集中管理</p><p class="side-note">从经营看板到财务报表与应收台账，在同一个工作台处理日常财务。</p></div><div class="side-footer">组织成员专用 · 按角色访问</div></aside>
<main><section class="card" aria-labelledby="page-title"><h1 id="page-title">${page.title}</h1><p class="intro">${page.description}</p>
${message?`<p class="message${error?' error':''}" role="${error?'alert':'status'}">${esc(message)}</p>`:''}
${bootstrap?'<p class="message">首次使用：在网站目录打开 PowerShell，运行 <code>node local.mjs account 你的邮箱</code>，用终端生成的密码登录管理员账号。</p>':''}
${code?`<div class="generated"><label for="generated">一次性${purpose==='reset'?'重置码':'邀请码'}（仅此处显示）</label><input id="generated" type="text" value="${esc(code)}" readonly><p class="hint">请复制并私下分享。再次生成时，旧码立即失效。</p></div>`:''}
${blocked?'':`<form method="post" action="${page.action}">${page.fields(email,purpose)}<button class="primary">${page.button}</button></form>`}<p class="footer">${blocked?'<a href="/">返回工作台</a>':page.footer}</p>
</section></main>
<script nonce="${nonce}">
document.querySelectorAll('[data-reveal]').forEach(button=>button.addEventListener('click',()=>{
 const input=document.getElementById(button.dataset.reveal),show=input.type==='password';
 input.type=show?'text':'password';
 button.textContent=show?'隐藏':'显示';
 button.setAttribute('aria-label',button.textContent+button.dataset.label);
}));
document.getElementById('generated')?.addEventListener('focus',e=>e.target.select());
</script></body></html>`;
}
