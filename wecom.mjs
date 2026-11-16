import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const testGroup={id:'robot-test',name:'机器人测试群'};
const endpoint='https://qyapi.weixin.qq.com/cgi-bin/webhook/';
const keyPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const money=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const cleanText=value=>value.replace(/[\x00-\x1f\x7f]/g,' ').trim();
const markdownText=value=>cleanText(value).replace(/[<>]/g,c=>c==='<'?'＜':'＞')
  .replace(/[\\`*_~\[\]]/g,'\\$&');
const bytes=value=>Buffer.byteLength(value,'utf8');
const revision=group=>createHash('sha256').update(JSON.stringify(group)).digest('hex');

function webhookKey(value){
  if(typeof value!=='string')return null;
  try{
    const url=new URL(value);
    const entries=[...url.searchParams];
    if(url.origin==='https://qyapi.weixin.qq.com'&&url.pathname==='/cgi-bin/webhook/send'&&
      !url.username&&!url.password&&!url.hash&&entries.length===1&&entries[0][0]==='key'&&keyPattern.test(entries[0][1])){
      return entries[0][1];
    }
  }catch{}
  return null;
}

export function wecomSender(configFile,{fetchEndpoint=fetch}={}){
  async function configuredGroups(){
    let groups;
    try{groups=JSON.parse((await readFile(configFile,'utf8')).replace(/^\uFEFF/,''))}
    catch(error){
      if(error.code==='ENOENT')return [testGroup];
      throw Error('企业微信群配置无法读取，请联系管理员。');
    }
    if(!Array.isArray(groups)||groups.length>50)throw Error('企业微信群配置格式无效，请联系管理员。');
    const ids=new Set(),names=new Set(),keys=new Set();
    const parsed=groups.map(group=>{
      const id=group?.id,name=typeof group?.name==='string'?group.name.trim():'',key=webhookKey(group?.webhook);
      if(typeof id!=='string'||!/^[a-z0-9-]{1,40}$/.test(id)||!name||name.length>60||
        !key||ids.has(id)||names.has(name)||keys.has(key.toLowerCase())||
        (id===testGroup.id)!==(name===testGroup.name)){
        throw Error('企业微信群配置包含无效或重复的群组，请联系管理员。');
      }
      ids.add(id);names.add(name);keys.add(key.toLowerCase());
      return {id,name,key};
    });
    return ids.has(testGroup.id)?parsed:[testGroup,...parsed];
  }

  async function call(action,key,body){
    const url=new URL(action,endpoint);
    url.searchParams.set('key',key);
    if(action==='upload_media')url.searchParams.set('type','file');
    const isFile=body instanceof FormData;
    const response=await fetchEndpoint(url,{
      method:'POST',body:isFile?body:JSON.stringify(body),
      headers:isFile?{}:{'Content-Type':'application/json'},
      redirect:'error',signal:AbortSignal.timeout(10000)
    });
    if(!response.ok)throw Error('企业微信服务暂未确认结果。');
    const result=await response.json();
    if(result.errcode!==0)return null;
    return result;
  }

  const recent=new Map();
  const inFlight=new Set();
  return {
    async groups(){
      return (await configuredGroups()).map(group=>({
        id:group.id,name:group.name,configured:Boolean(group.key),revision:revision(group)
      }));
    },
    async send(groupId,groupRevision,report,version,recordDispatch){
      const group=(await configuredGroups()).find(g=>g.id===groupId);
      if(!group?.key)return {status:400,error:'该企业微信群尚未配置机器人，或群组已停用。'};
      if(groupRevision!==revision(group))return {status:409,error:'群机器人配置已更新，请关闭此窗口并重新选择群组。'};
      const selectionKey=groupId+':'+groupRevision+':'+version;
      const now=Date.now();
      for(const [id,entry] of recent)if(entry.expires<=now)recent.delete(id);
      const previous=recent.get(selectionKey);
      if(inFlight.has(groupId))return {status:409,error:'该群已有一条消息正在发送，请稍后查看结果。'};
      if(previous){
        if(previous.result)return {status:200,...previous.result,duplicate:true};
        return {status:409,error:'企业微信未确认上一条消息的结果，请在群里核对后再试。'};
      }

      const intro='截至 '+report.asOf+'，按 ERP 订单到期日核实，共 '+report.rows.length+
        ' 家客户逾期超过 180 天，未收合计 '+money.format(report.total/100)+' 元。';
      const lines=render=>report.rows.map(r=>render(r.customer)+'　'+money.format(r.cents/100)+' 元');
      const subject='应收账款｜逾期超过 180 天';
      const markdown='**'+subject+'**\n'+intro+'\n\n'+lines(markdownText).join('\n');
      let message={msgtype:'markdown',markdown:{content:markdown}},delivery='message';
      inFlight.add(groupId);
      let sendingToGroup=false;
      let batchId;
      try{
        if(recordDispatch){
          try{batchId=await recordDispatch(group.name)}
          catch{
            return {status:503,error:'无法保存推送记录，请稍后重试。'};
          }
        }
        if(bytes(markdown)>4096){
          const contents='\uFEFF'+subject+'\r\n'+intro+'\r\n\r\n'+lines(cleanText).join('\r\n');
          if(bytes(contents)>19*1024*1024)return {status:413,batchId,error:'逾期明细超过企业微信文件大小限制。'};
          const form=new FormData();
          form.append('media',new Blob([contents],{type:'text/plain;charset=utf-8'}),'overdue-180-days-'+report.asOf+'.txt');
          const uploaded=await call('upload_media',group.key,form);
          if(typeof uploaded?.media_id!=='string')return {status:502,batchId,error:'企业微信未接受明细文件，请联系管理员检查机器人。'};
          message={msgtype:'file',file:{media_id:uploaded.media_id}};
          delivery='file';
        }
        sendingToGroup=true;
        if(!await call('send',group.key,message)){
          sendingToGroup=false;
          return {status:502,batchId,error:'企业微信拒绝了发送请求，请联系管理员检查机器人。'};
        }
        const result={group:group.name,delivery,batchId};
        recent.set(selectionKey,{result,expires:Date.now()+60000});
        return {status:200,...result};
      }catch{
        if(sendingToGroup){
          recent.set(selectionKey,{expires:Date.now()+60000});
          return {status:502,batchId,unconfirmed:true,error:'企业微信未确认发送结果，请先在群里核对。'};
        }
        return {status:502,batchId,error:'连接企业微信失败，请稍后重试。'};
      }finally{
        inFlight.delete(groupId);
      }
    }
  };
}
