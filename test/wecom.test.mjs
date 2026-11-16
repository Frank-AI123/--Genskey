import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import app from '../worker.js';
import {erpStore} from '../erp-store.mjs';
import {wecomSender} from '../wecom.mjs';

test('only confirmed ERP aging can be sent to a configured group',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'finance-wecom-test-'));
  let platformDb;
  t.after(async()=>{platformDb?.close();await rm(folder,{recursive:true,force:true})});
  const snapshot=join(folder,'snapshot.sqlite'),config=join(folder,'groups.json');
  const db=new DatabaseSync(snapshot);
  try{
    db.exec(`CREATE TABLE snapshot(as_of TEXT NOT NULL);
      INSERT INTO snapshot VALUES ('2026-10-31');
      CREATE TABLE customer_summary(customer TEXT,days_181_plus INT,book INT);
      INSERT INTO customer_summary VALUES ('甲公司',3050,3050),('乙公司',0,50000),('丙公司',101,0);`);
  }finally{db.close()}
  const key='00000000-0000-0000-0000-000000000001';
  const group={id:'robot-test',name:'机器人测试群',webhook:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key='+key};
  const outbound=[];
  let vendorReplies=true;
  const wecom=wecomSender(config,{fetchEndpoint:async (url,options)=>{
    outbound.push({url,options});
    if(!vendorReplies)throw Error('simulated timeout');
    return Response.json({errcode:0,media_id:'test-media'});
  }});
  platformDb=new DatabaseSync(join(folder,'workbench.sqlite'));
  platformDb.exec(`CREATE TABLE member(email TEXT PRIMARY KEY,role TEXT NOT NULL);
    INSERT INTO member VALUES ('finance@example.test','finance'),('admin@example.test','admin'),
      ('viewer@example.test','viewer'),('budget@example.test','budget');`);
  const adapter={
    batch(statements){return statements.map(statement=>statement.run())},
    prepare(sql,args=[]){
      return {bind:(...values)=>adapter.prepare(sql,values),
        run:()=>({meta:platformDb.prepare(sql).run(...args)}),
        first:()=>platformDb.prepare(sql).get(...args),
        all:()=>({results:platformDb.prepare(sql).all(...args)})};
    }
  };
  const origin='http://127.0.0.1:8788';
  const history='/api/erp/wecom-dispatches';
  const request=(role,body,source=origin,path='/api/erp/overdue-wecom')=>app.fetch(new Request(origin+path,{
    method:body?'POST':'GET',
    headers:{'oai-authenticated-user-id':role,'oai-authenticated-user-email':role+'@example.test',
      ...(body?{'Content-Type':'application/json',Origin:source}:{})},
    body:body&&JSON.stringify(body)
  }),{DB:adapter,ERP:erpStore(snapshot),WECOM:wecom,LOCAL_ACCOUNTS:true});

  assert.equal((await request('viewer')).status,403);
  assert.equal((await request('budget')).status,403);
  const unconfigured=await (await request('finance')).json();
  assert.equal(unconfigured.groups[0].configured,false);
  assert.equal((await request('finance',{groupId:group.id,version:unconfigured.version})).status,400);
  await writeFile(config,JSON.stringify([group]));
  const preview=await (await request('finance')).json();
  assert.deepEqual(preview.report,{asOf:'2026-10-31',total:3151,rows:[{customer:'甲公司',cents:3050},{customer:'丙公司',cents:101}]});
  assert.ok(!JSON.stringify(preview).includes(key));
  const confirmation={groupId:group.id,groupRevision:preview.groups[0].revision,version:preview.version,customerIndexes:[0]};
  assert.equal((await request('finance',confirmation,'https://foreign.example')).status,403);
  assert.equal((await request('viewer',confirmation)).status,403);
  assert.equal((await request('finance',{...confirmation,version:'outdated'})).status,409);
  assert.equal((await request('finance',{...confirmation,groupRevision:'outdated'})).status,409);
  for(const customerIndexes of [undefined,[],[0,0],[2],[-1],['0']]){
    assert.equal((await request('finance',{...confirmation,customerIndexes})).status,400);
  }
  assert.equal(outbound.length,0);
  const delivery=await request('finance',confirmation);
  assert.equal(delivery.status,200);
  const {batchId}=await delivery.json();
  const duplicate=await (await request('finance',confirmation)).json();
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.batchId,batchId);
  assert.equal(outbound.length,1);
  assert.equal(outbound[0].url.pathname,'/cgi-bin/webhook/send');
  const sent=JSON.parse(outbound[0].options.body);
  assert.match(sent.markdown.content,/甲公司.+30\.50/);
  assert.doesNotMatch(sent.markdown.content,/乙公司|丙公司/);
  assert.match(sent.markdown.content,/共 1 家客户.+未收合计 30\.50/);
  assert.equal(outbound[0].options.redirect,'error');
  assert.equal((await request('viewer',null,origin,history)).status,403);
  const list=async()=>await (await request('finance',null,origin,history)).json();
  assert.equal((await list()).batches.length,1);
  const details=async()=>await (await request('finance',null,origin,history+'/'+batchId)).json();
  const batch=await details();
  assert.equal(batch.batch.status,'sent');
  assert.ok(!Number.isNaN(Date.parse(batch.batch.sent_at)));
  assert.deepEqual(batch.rows.map(r=>[r.customer,r.cents]),[['甲公司',3050]]);
  assert.equal(batch.batch.total,3050);

  const feedbackPath=history+'/'+batchId+'/feedback?customer=0';
  const firstNote={id:crypto.randomUUID(),result:'客户承诺周五付款'};
  assert.equal((await request('finance',firstNote,origin,feedbackPath.replace('=0','=1'))).status,404);
  assert.equal((await request('viewer',firstNote,origin,feedbackPath)).status,403);
  assert.equal((await request('finance',firstNote,'https://foreign.example',feedbackPath)).status,403);
  assert.equal((await request('finance',{...firstNote,result:'  '},origin,feedbackPath)).status,400);
  const firstSave=await (await request('finance',firstNote,origin,feedbackPath)).json();
  assert.equal(firstSave.feedback[0].author,'finance@example.test');
  assert.ok(!Number.isNaN(Date.parse(firstSave.feedback[0].created_at)));
  assert.deepEqual(await (await request('finance',firstNote,origin,feedbackPath)).json(),firstSave);
  assert.equal((await request('finance',{...firstNote,result:'different text'},origin,feedbackPath)).status,409);
  const secondNote={id:crypto.randomUUID(),result:'收到回单，待核对流水'};
  assert.equal((await request('admin',secondNote,origin,feedbackPath)).status,200);
  const {feedback}=await (await request('finance',null,origin,feedbackPath)).json();
  assert.deepEqual(feedback.map(r=>r.result),[secondNote.result,firstNote.result]);
  assert.equal((await details()).rows[0].feedbackCount,2);
  assert.equal((await list()).batches[0].feedback_count,1);
  assert.equal(outbound.length,1);

  const secondDelivery=await request('finance',{...confirmation,customerIndexes:[1]});
  assert.equal(secondDelivery.status,200);
  const secondBatch=await secondDelivery.json();
  assert.notEqual(secondBatch.batchId,batchId);
  const secondContent=JSON.parse(outbound[1].options.body).markdown.content;
  assert.match(secondContent,/丙公司.+1\.01/);
  assert.doesNotMatch(secondContent,/甲公司/);
  assert.equal((await (await request('finance',confirmation)).json()).batchId,batchId);
  assert.equal(outbound.length,2);

  assert.equal((await wecom.send(group.id,confirmation.groupRevision,
    {...preview.report,rows:Array.from({length:400},(_,i)=>({customer:'测试客户 '+i,cents:1})),total:400},'large')).delivery,'file');
  assert.equal(outbound[2].url.pathname,'/cgi-bin/webhook/upload_media');
  assert.match(await outbound[2].options.body.get('media').text(),/测试客户 399/);
  assert.deepEqual(JSON.parse(outbound[3].options.body),{msgtype:'file',file:{media_id:'test-media'}});
  const updated=new DatabaseSync(snapshot);
  try{updated.exec('UPDATE customer_summary SET days_181_plus=5000 WHERE days_181_plus=3050')}finally{updated.close()}
  vendorReplies=false;
  const changed=await (await request('finance')).json();
  const timeout=await request('finance',{...confirmation,version:changed.version});
  assert.equal(timeout.status,502);
  const {batchId:uncertainId}=await timeout.json();
  const historyAfterTimeout=(await list()).batches;
  assert.equal(historyAfterTimeout.find(item=>item.id===uncertainId).status,'unconfirmed');
  assert.equal((await request('finance',firstNote,origin,history+'/'+uncertainId+'/feedback?customer=0')).status,409);
  assert.equal((await details()).rows[0].cents,3050);
});
