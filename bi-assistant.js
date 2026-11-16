const biExamples=['营业收入和毛利率','本年每月 ERP 收入趋势','逾期客户前 5 名'];
let biDraft='',biResult=null,biBusy=false,biStatus='',biStatusError=false,biSpeechStatus='',biSpeech=null;
const biVoiceType=()=>window.SpeechRecognition||window.webkitSpeechRecognition;
const biPreferenceKey=()=> 'finance.bi.model:'+state.email;
function biSelectedModel(){
 let saved;
 try{saved=localStorage.getItem(biPreferenceKey())}catch{}
 return state.bi.models.find(m=>m.id===saved)??state.bi.models.find(m=>m.id===state.bi.defaultModel);
}
let biModelOverride;
let biRequestVersion=0;
function biResetSession(){
 biStopVoice();biRequestVersion++;
 biModelOverride=undefined;biDraft='';biResult=null;biBusy=false;
 biStatus='';biStatusError=false;biSpeechStatus='';
}
function biCurrentModel(){
 return state.bi.models.find(m=>m.id===biModelOverride)??biSelectedModel();
}
function biSetModel(id){
 if(!state.bi.models.some(m=>m.id===id))return;
 biModelOverride=id;
 try{localStorage.setItem(biPreferenceKey(),id)}catch{}
 const description=$('#bi-model-info');
 if(description)description.textContent=biModelDescription(biCurrentModel());
}
function biModelDescription(model){
 return model.model?model.provider+' · '+model.model+'。提交后，需求文字及期间会发送给该模型；财务数据在工作台内计算。':
  '使用工作台本地规则解析，无需连接大模型。';
}
function biModelPicker(id,label){
 const selected=biCurrentModel().id;
 return '<label>'+label+'<select id="'+id+'" aria-describedby="bi-model-info">'+state.bi.models.map(m=>
  '<option value="'+esc(m.id)+'"'+(selected===m.id?' selected':'')+'>'+esc(m.name)+'</option>').join('')+'</select></label>';
}
function aiModelsPage(){
 const model=biCurrentModel(),hasModels=state.bi.models.length>1;
 return title('AI 模型','查看工作台使用的模型，并为自己的 BI 分析选择默认方案。')+
 '<section class="panel bi-model-box"><h2>用于 BI 的模型</h2>'+biModelPicker('bi-preferred-model','我的模型')+
 '<p id="bi-model-info" class="muted" role="status">'+esc(biModelDescription(model))+'</p>'+
 (hasModels?'':'<p class="muted">当前未接入大模型。管理员可在服务端配置已获准使用的模型，启用后会出现在这里。</p>')+
 '<button type="button" class="primary" data-tab="dashboard">进入 BI 看板</button></section>'+
 '<section class="panel bi-model-box"><h2>可选方案</h2>'+grid(['名称','服务商','模型标识'],state.bi.models.map(m=>
  [esc(m.name)+(m.id===state.bi.defaultModel?' <small>（平台默认）</small>':''),esc(m.provider),esc(m.model??'本地规则')]))+
 '<p class="muted">模型用于理解指标需求，数值按工作台的财务口径计算。模型偏好保存在当前浏览器。</p></section>';
}
function biAssistantPanel(){
 return '<section class="panel bi-assistant" aria-labelledby="bi-assistant-title">'+
 '<div class="bi-panel-head"><div><p class="bi-ai-kicker">自定义分析</p><h2 id="bi-assistant-title">智能指标</h2><p>用文字或中文语音提出需求，生成指标卡、月度图表或客户排行。</p></div>'+
 '<button type="button" class="bi-text-button" data-tab="ai-models">查看 AI 模型</button></div>'+
 '<form id="bi-request" class="bi-request"><label for="bi-prompt">想看什么指标？</label>'+
 '<textarea id="bi-prompt" placeholder="例如：查看 10 月营业收入和毛利率" rows="2" maxlength="300" required>'+esc(biDraft)+'</textarea>'+
 '<div class="bi-ai-actions">'+biModelPicker('bi-request-model','分析方式')+
 '<button type="button" id="bi-voice" class="bi-voice" aria-pressed="'+Boolean(biSpeech)+'" aria-describedby="bi-voice-help bi-voice-status" '+(!biVoiceType()||!window.isSecureContext?'disabled':'')+'>'+(biSpeech?'结束语音':'🎙 语音输入')+'</button>'+
 '<button type="submit" class="primary" id="bi-generate" '+(biBusy?'disabled':'')+'>'+(biBusy?'正在生成…':'生成指标')+'</button></div>'+
 '<small id="bi-model-info">'+esc(biModelDescription(biCurrentModel()))+'</small>'+
 '<small id="bi-voice-help">'+(biVoiceType()&&window.isSecureContext?'语音由浏览器识别，可能使用其在线服务。识别后可先编辑，再提交。':'当前浏览器或访问地址不支持语音输入。可继续打字，或使用支持语音识别的浏览器通过 HTTPS 或本机地址访问。')+'</small>'+
 '<small id="bi-voice-status" role="status">'+esc(biSpeechStatus)+'</small></form>'+
 '<div class="bi-ai-examples" aria-label="需求示例"><small>试试</small>'+biExamples.map((example,i)=>
  '<button type="button" data-bi-example="'+i+'">'+esc(example)+'</button>').join('')+'</div>'+
 '<p id="bi-request-status" role="status" class="'+(biStatusError?'error':'muted')+'">'+esc(biStatus)+'</p>'+
 '<div id="bi-results">'+biRenderResults()+'</div></section>';
}
function biValue(value,unit){return value==null?'—':unit==='percent'?pct(value,1):yuan(value)}
function biResultSeries(result){
 const points=result.points;
 const low=Math.min(0,...points.map(p=>p.value??0)),high=Math.max(0,...points.map(p=>p.value??0));
 const span=high-low||1,zero=100*(-low)/span;
 const rows=points.map(p=>{
  const value=biValue(p.value,result.unit),size=100*Math.abs(p.value??0)/span;
  const start=p.value<0?zero-size:zero;
  return '<li><span>'+esc(p.period)+'</span><span class="bi-ai-track" aria-hidden="true" style="--zero:'+zero+'%">'+
   (p.value!=null?'<i class="'+(p.value<0?'negative':'')+'" style="--offset:'+start+'%;--width:'+size+'%"></i>':'')+
   '</span><b>'+value+'</b></li>';
 }).join('');
 return '<article class="bi-series"><h3>'+esc(result.label)+'</h3><small>'+esc(result.source)+'</small>'+
  '<ul class="bi-ai-chart">'+rows+'</ul>'+(result.note?'<small>'+esc(result.note)+'</small>':'')+'</article>';
}
function biRenderResults(){
 if(!biResult)return '';
 const result=biResult,model=state.bi.models.find(m=>m.id===result.model);
 const heading='<div class="bi-results-head"><h3>分析结果</h3><small>'+esc(model?.name??result.model)+
  (result.display==='trend'?' · '+result.from+(result.from===result.to?'':' 至 '+result.to):'')+'</small></div>';
 if(result.display==='rank'){
  const rank=result.results[0];
  return heading+'<p class="muted">'+esc(rank.label)+' · '+esc(rank.source)+(rank.asOf?' · 截至 '+esc(rank.asOf):'（暂无快照）')+'</p>'+
   grid(['排名','客户','逾期金额'],rank.rows.map((r,i)=>[i+1,esc(r.label),yuan(r.value)]));
 }
 if(result.display==='trend')return heading+'<div class="bi-series-grid">'+result.results.map(biResultSeries).join('')+'</div>'+
  '<small>— 表示所选期间暂无可用数据。</small>';
 return heading+'<div class="bi-ai-cards">'+result.results.map(r=>{
  const p=r.points[0];
  return card(esc(r.label),biValue(p.value,r.unit),esc([r.source,p.period,p.scope,p.value==null?'暂无数据':''].filter(Boolean).join(' · ')));
 }).join('')+'</div>';
}
function biUpdateVoice(){
 const button=$('#bi-voice');
 if(!button)return;
 button.textContent=biSpeech?'结束语音':'🎙 语音输入';
 button.setAttribute('aria-pressed',String(Boolean(biSpeech)));
 $('#bi-voice-status').textContent=biSpeechStatus;
}
function biStopVoice(){
 if(!biSpeech)return;
 const recognition=biSpeech;
 biSpeech=null;
 biSpeechStatus='';
 try{recognition.abort()}catch{}
 biUpdateVoice();
}
function biStartVoice(){
 if(biSpeech){try{biSpeech.stop()}catch{biStopVoice()}return}
 const Voice=biVoiceType();
 if(!Voice||!window.isSecureContext)return;
 const field=$('#bi-prompt');
 const prefix=field.value.trimEnd();
 let recognition;
 try{recognition=new Voice()}catch{biSpeechStatus='无法启动语音输入，可直接输入文字。';biUpdateVoice();return}
 recognition.lang='zh-CN';
 recognition.interimResults=true;
 recognition.continuous=false;
 let heard=false;
 recognition.onstart=()=>{if(biSpeech===recognition){biSpeechStatus='正在听，请用普通话说出指标需求。';biUpdateVoice()}};
 recognition.onresult=event=>{
  if(biSpeech!==recognition)return;
  const transcript=Array.from(event.results,r=>r[0].transcript).join('').trim();
  if(!transcript)return;
  heard=true;
  biDraft=(prefix?prefix+' '+transcript:transcript).slice(0,300);
  const input=$('#bi-prompt');
  if(input)input.value=biDraft;
 };
 recognition.onerror=event=>{
  if(biSpeech!==recognition)return;
  biSpeech=null;
  biSpeechStatus=['not-allowed','service-not-allowed'].includes(event.error)?'麦克风权限未开启。请允许访问麦克风，或直接输入文字。':
   event.error==='no-speech'?'没有听到语音。请重试或直接输入文字。':'语音识别暂不可用，请重试或直接输入文字。';
  biUpdateVoice();
 };
 recognition.onend=()=>{
  if(biSpeech!==recognition)return;
  biSpeech=null;
  biSpeechStatus=heard?'已填入识别文字，可编辑后生成。':'没有识别到文字，请重试或直接输入。';
  biUpdateVoice();
 };
 biSpeech=recognition;biSpeechStatus='正在启动麦克风…';biUpdateVoice();
 try{recognition.start()}catch{biSpeech=null;biSpeechStatus='无法启动麦克风，可直接输入文字。';biUpdateVoice()}
}
async function biSubmit(){
 if(biBusy)return;
 biStopVoice();
 biDraft=$('#bi-prompt').value;
 if(!biDraft.trim()){$('#bi-prompt').focus();return}
 biBusy=true;biStatus='正在生成指标…';biStatusError=false;
 const version=++biRequestVersion;
 biUpdateRequest();
 try{
  const result=await api('bi/generate',{prompt:biDraft,model:biCurrentModel().id,period});
  if(version!==biRequestVersion)return;
  biResult=result;
  biStatus='指标已生成。再次提交可更新结果。';
  const output=$('#bi-results');
  if(output)output.innerHTML=biRenderResults();
 }catch(error){
  if(version!==biRequestVersion)return;
  biStatus=error.message+(biResult?' 下方保留上一次生成的结果。':'');
  biStatusError=true;
 }finally{if(version===biRequestVersion){biBusy=false;biUpdateRequest()}}
}
function biUpdateRequest(){
 const button=$('#bi-generate');
 if(!button)return;
 button.disabled=biBusy;button.textContent=biBusy?'正在生成…':'生成指标';
 const status=$('#bi-request-status');
 status.textContent=biStatus;
 status.className=biStatusError?'error':'muted';
}
