const budgetStatus={draft:'草稿',submitted:'待审核',returned:'已退回',approved:'已通过',none:'未填报'};
const budgetActions={save:'创建草稿',submit:'提交审核',return:'退回修改',approve:'审核通过'};
const budgetTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'});
let budgetYear=0,budgetDirty=false,budgetInFlight=false;
const budgetPage=()=>title('预算管理','部门在线编制年度预算，按月录入明细并提交财务审核。')+
 '<div id="budget-page"><p role="status" class="muted">正在加载预算…</p></div>';
const budgetParams=(year,department)=>new URLSearchParams(department?{year,department}:{year});
const budgetBadge=status=>'<span class="budget-badge budget-'+status+'">'+budgetStatus[status]+'</span>';
const budgetDate=value=>budgetTime.format(new Date(value));
const canLeaveBudget=()=>!$('#budget-page')||(!budgetInFlight&&(!budgetDirty||confirm('有修改尚未保存。确定离开？')));

async function loadBudgetList(root){
 budgetDirty=false;
 budgetYear||=(demoMode?demoYear:Number(today().slice(0,4)));
 root.innerHTML='<form id="budget-year" class="panel budget-toolbar"><label>预算年度<input type="number" name="year" aria-label="预算年度" min="2000" max="2099" step="1" value="'+budgetYear+'" required></label><button type="submit">查看年度</button></form><div class="budget-list" aria-live="polite"><p class="muted">正在加载预算…</p></div>';
 const mount=root.querySelector('.budget-list');
 try{
  const year=budgetYear,d=await api('budgets?'+budgetParams(year));
  if(!mount.isConnected)return;
  const byDepartment=new Map(d.rows.map(row=>[row.department,row]));
  const departments=[...new Set([...d.departments,...byDepartment.keys()])].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const mine=byDepartment.get(d.department),editable=d.fill&&(!mine||['draft','returned'].includes(mine.status));
  const open=(department,button)=>'<button type="button" data-budget-open="'+esc(department)+'">'+button+'</button>';
  const ownSection=d.department?'<section class="panel budget-section"><div class="budget-section-head"><div><h2>我的部门 · '+esc(d.department)+'</h2><p>'+year+' 年 · 年度预算金额 '+(mine?yuan(mine.total):'—')+'</p></div><div class="tools">'+budgetBadge(mine?.status??'none')+(editable||mine?open(d.department,editable?'填报预算':'查看预算'):'')+'</div></div></section>':
   (!d.review?'<section class="panel budget-section"><h2>尚未分配预算部门</h2><p>请联系管理员在「人员权限」中为你的账号设置所属部门。</p></section>':'');
  const submitted=d.rows.filter(r=>r.status==='submitted'),approved=d.rows.filter(r=>r.status==='approved');
  mount.innerHTML=ownSection+(d.review?'<div class="cards budget-metrics">'+card('部门填报进度',d.rows.length+' / '+departments.length,'已建立预算的部门 / 全部部门')+card('待审核预算',yuan(sum(submitted,r=>r.total)),submitted.length+' 个部门')+card('已通过预算',yuan(sum(approved,r=>r.total)),approved.length+' 个部门')+'</div>'+
   '<section class="panel budget-section"><h2>部门预算汇总</h2>'+(departments.length?grid(['部门','状态','年度预算（人民币）','最近更新','操作'],departments.map(department=>{
    const row=byDepartment.get(department);
    return [esc(department),budgetBadge(row?.status??'none'),row?yuan(row.total):'—',row?budgetDate(row.updated_at):'—',row?open(department,row.status==='submitted'?'审核':'查看'):'—'];
   })): '<p class="empty">暂无预算部门。管理员可在「人员权限」中为同事分配部门。</p>')+'</section>':'');
  root.querySelectorAll('[data-budget-open]').forEach(button=>button.addEventListener('click',()=>openBudget(root,year,button.dataset.budgetOpen,d.fill?d.department:'',d.review,byDepartment.get(button.dataset.budgetOpen))));
 }catch(error){if(mount.isConnected)mount.innerHTML='<p class="error">'+esc(error.message)+'</p>'}
}

async function openBudget(root,year,department,own,review,summary){
 notify('');
 if(!summary){renderBudget(root,{department,year,items:[],events:[],total:0,version:0,status:'none'},own,review);return}
 const controls=[...root.querySelectorAll('button,input')];controls.forEach(control=>control.disabled=true);
 try{
  const {budget}=await api('budgets/detail?'+budgetParams(year,department));
  if(root.isConnected)renderBudget(root,budget,own,review);
 }catch(error){if(root.isConnected)notify(error.message,true)}
 finally{controls.forEach(control=>control.disabled=false)}
}

function budgetEditorRow(row={}){
 return '<tr><td><input name="subject" aria-label="预算科目" maxlength="80" placeholder="例如：办公设备" value="'+esc(row.subject??'')+'"></td>'+
  '<td><select name="month" aria-label="预算月份">'+Array.from({length:12},(_,i)=>'<option value="'+(i+1)+'" '+(row.month===i+1?'selected':'')+'>'+(i+1)+' 月</option>').join('')+'</select></td>'+
  '<td><input name="amount" aria-label="预算金额（元）" inputmode="decimal" maxlength="16" placeholder="0.00" value="'+(row.amount===undefined?'':(row.amount/100).toFixed(2))+'"></td>'+
  '<td><input name="note" aria-label="明细说明" maxlength="300" placeholder="选填" value="'+esc(row.note??'')+'"></td><td><button type="button" data-budget-remove aria-label="删除此行">删除</button></td></tr>';
}

function renderBudget(root,budget,own,review){
 const edit=budget.department===own&&['none','draft','returned'].includes(budget.status);
 const pendingReview=review&&budget.status==='submitted';
 const lastReturn=budget.status==='returned'?budget.events.findLast(event=>event.action==='return'):null;
 root.innerHTML='<p><button type="button" id="budget-back">‹ 返回预算列表</button></p><section class="panel budget-section"><div class="budget-section-head"><div><h2 id="budget-detail-title" tabindex="-1">'+esc(budget.department)+' · '+budget.year+' 年预算</h2><p>人民币元 · 按月填报</p></div>'+budgetBadge(budget.status)+'</div>'+
 (lastReturn?'<p class="budget-return-note"><b>退回原因：</b>'+esc(lastReturn.note)+'</p>':'')+
 (edit?'<form id="budget-editor"><p class="muted">同一科目可按月份填写多行。空白行不会保存，金额最多两位小数。</p><div class="scroll"><table class="budget-editor-table"><thead><tr><th>预算科目</th><th>月份</th><th>金额（元）</th><th>说明</th><th>操作</th></tr></thead><tbody id="budget-lines">'+(budget.items.length?budget.items:[{}]).map(budgetEditorRow).join('')+'</tbody></table></div><div class="budget-section-head"><button type="button" id="budget-add">＋ 添加明细</button><strong>年度合计：<output id="budget-total">'+yuan(budget.total)+'</output></strong></div><div class="tools"><button type="submit" value="save">保存草稿</button><button type="submit" value="submit" class="primary">提交审核</button></div></form>':
  '<p><strong>年度合计：'+yuan(budget.total)+'</strong></p>'+grid(['预算科目','月份','金额（元）','说明'],budget.items.map(row=>[esc(row.subject),row.month+' 月',yuan(row.amount),esc(row.note||'—')])) )+'</section>'+
 (pendingReview?'<section class="panel budget-section"><h2>审核预算</h2><form id="budget-review"><label>审核意见（退回时必填）<textarea name="note" maxlength="500" rows="3"></textarea></label><div class="tools"><button type="submit" value="approve" class="primary">审核通过</button><button type="submit" value="return">退回修改</button></div></form></section>':'')+
 (budget.events.length?'<section class="panel budget-section"><h2>填报与审核记录</h2><ul class="budget-events">'+budget.events.toReversed().map(event=>'<li><strong>'+budgetActions[event.action]+'</strong><small>'+budgetDate(event.at)+' · '+esc(event.email)+'</small>'+(event.note?'<p>'+esc(event.note)+'</p>':'')+'</li>').join('')+'</ul></section>':'');
 root.querySelector('#budget-detail-title').focus();
 root.querySelector('#budget-back').addEventListener('click',()=>{if(canLeaveBudget()){notify('');loadBudgetList(root)}});
 const form=root.querySelector('form');if(!form)return;
 const lines=root.querySelector('#budget-lines');
 if(edit){
  form.addEventListener('input',()=>{budgetDirty=true;updateBudgetTotal(lines)});
  form.addEventListener('change',()=>{budgetDirty=true});
  root.querySelector('#budget-add').addEventListener('click',()=>{
   if(lines.rows.length>=200){notify('每个部门每年度最多填写 200 条明细。',true);return}
   lines.insertAdjacentHTML('beforeend',budgetEditorRow());budgetDirty=true;lines.lastElementChild.querySelector('input').focus();
  });
  lines.addEventListener('click',event=>{
   const button=event.target.closest('[data-budget-remove]');if(!button)return;
   button.closest('tr').remove();budgetDirty=true;updateBudgetTotal(lines);
   lines.lastElementChild?.querySelector('input').focus();if(!lines.rows.length)root.querySelector('#budget-add').focus();
  });
 }else form.addEventListener('input',()=>{budgetDirty=true});
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  const action=event.submitter?.value||(edit?'save':'approve');
  const data={action,year:budget.year,department:budget.department,version:budget.version};
  try{
   if(edit)data.items=collectBudgetItems(lines);
   else{
    data.note=form.elements.note.value.trim();
    if(action==='return'&&!data.note){form.elements.note.focus();throw Error('请填写退回原因。')}
   }
   const prompts={submit:'确认提交审核？提交后暂停编辑，退回后可修改。',approve:'确认通过这份预算？',return:'确认退回这份预算？'};
   if(prompts[action]&&!confirm(prompts[action]))return;
   if(budgetInFlight)return;
   budgetInFlight=true;
   const controls=[...root.querySelectorAll('button,input,select,textarea')];controls.forEach(control=>control.disabled=true);
   try{
    await api('budgets/detail',data);
    if(root.isConnected){await loadBudgetList(root);notify(({save:'预算草稿已保存。',submit:'预算已提交财务审核。',approve:'预算已审核通过。',return:'预算已退回部门修改。'})[action])}
   }finally{budgetInFlight=false;controls.forEach(control=>control.disabled=false)}
  }catch(error){if(root.isConnected)notify(error.message,true)}
 });
}

function collectBudgetItems(lines){
 const items=[];
 for(const [i,row] of [...lines.rows].entries()){
  const get=name=>row.querySelector('[name='+name+']').value.trim();
  const subject=get('subject'),value=get('amount'),note=get('note');
  if(!subject&&!value&&!note)continue;
  if(!subject||!value)throw Error('第 '+(i+1)+' 行：请填写预算科目和金额。');
  let amount;
  try{amount=budgetAmount(value)}catch(error){throw Error('第 '+(i+1)+' 行：'+error.message)}
  items.push({subject,note,amount,month:Number(get('month'))});
 }
 return items;
}
function budgetAmount(value){
 const amount=cents(value);
 if(amount>10000000000)throw Error('单条明细金额不得超过 1 亿元。');
 return amount;
}
function updateBudgetTotal(lines){
 let total=0;
 for(const field of lines.querySelectorAll('[name=amount]')){
  try{if(field.value.trim())total+=budgetAmount(field.value)}catch{ $('#budget-total').textContent='请检查金额';return }
 }
 $('#budget-total').textContent=yuan(total);
}

document.addEventListener('submit',event=>{
 if(event.target.id!=='budget-year')return;
 event.preventDefault();budgetYear=Number(event.target.elements.year.value);notify('');loadBudgetList($('#budget-page'));
});
window.addEventListener('beforeunload',event=>{
 if($('#budget-page')&&(budgetDirty||budgetInFlight)){event.preventDefault();event.returnValue=''}
});
