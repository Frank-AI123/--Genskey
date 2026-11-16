// Synthetic fixtures for the standalone HTML. No runtime data is read by the build.
const demoReports=[730000,814000,768000,920000,1068000,995000].map((amount,i)=>{
 const id='2026-'+String(i+5).padStart(2,'0');
 const revenue=amount*100,cost=Math.round(revenue*.62),expense=Math.round(revenue*.16);
 const cash=Math.round(revenue*.19),operating=revenue-cost-expense;
 return {id,revenue,cost,expense,cash,operating,company:{
  balance:[['货币资金',160000000+i*12000000,148000000],['应收账款',89000000+i*4000000,64000000],['资产总计',760000000+i*27000000,733000000],['负债和所有者权益总计',760000000+i*27000000,733000000]],
  income:[['营业收入',revenue,null],['营业成本',cost,null],['营业利润',operating,null]],
  cashflow:[['经营活动产生的现金流量净额',cash,null]]
 }};
});
const demoMonths=demoReports.map(({id,revenue})=>({id,net:revenue,gross:Math.round(revenue*1.13),lines:2,other:0,missing:0}));
const demoCustomers=[
 ['示例客户 A',24000000,6000000,5000000,3000000,2000000,6500000,0],
 ['示例客户 B',15000000,2500000,2500000,2000000,3000000,4500000,0],
 ['示例客户 C',11300000,7000000,6200000,1800000,700000,1800000,0],
 ['示例客户 D', 8400000,4000000,6000000,2000000,1200000,0,400000],
].map(([customer,book,paid,current,days_1_90,days_91_180,verified_days_181_plus,unknown])=>{
 const estimated=current+days_1_90+days_91_180+verified_days_181_plus+unknown;
 return {customer,book,paid,current,days_1_90,days_91_180,days_181_plus:book-current-days_1_90-days_91_180,verified_days_181_plus,unknown,estimated,difference:book-estimated,term:60};
});
const demoSum=key=>demoCustomers.reduce((total,row)=>total+row[key],0);
const demoUpdated='2026-10-31T04:00:00Z',demoYear=2026;
const demoItems=[{subject:'软件订阅',month:3,amount:2400000,note:'演示项目'},{subject:'设备更新',month:9,amount:3600000,note:'演示项目'}];
const demoBudget={department:'示例运营部',year:demoYear,status:'approved',total:6000000,updated_at:demoUpdated,items:demoItems,
 events:[{action:'submit',at:'2026-10-30T04:00:00Z',email:'填报员（示例）'},{action:'approve',at:demoUpdated,email:'财务人员（示例）',note:'已复核预算明细。'}]};
const demoSkills=[
 {id:'reconcile',name:'月末应收核对',category:'月结',summary:'核对期末应收、订单余额与已分配回款。',instructions:'1. 对齐报表截止日。\n2. 核对总账与客户明细。\n3. 标记余额和账期差异，留待复核。'},
 {id:'budget',name:'部门预算检查',category:'预算',summary:'复核预算的科目、月份和填报说明。',instructions:'1. 按科目和月份汇总明细。\n2. 检查是否漏填或重复。\n3. 对重大金额变动补充说明。'},
].map(skill=>({...skill,published:1,owner:'财务团队（示例）',version:'1.0',updated_at:demoUpdated}));
const demoState={email:'示例访客',role:'viewer',wecom:false,members:[],ar:[],report:demoReports,erp:{
 months:demoMonths,
 snapshot:{as_of:'2026-10-31',period_start:'2026-01-01',book_customers:demoCustomers.length,book:demoSum('book'),paid:demoSum('paid'),
  estimated:demoSum('estimated'),missing_terms:demoSum('unknown'),difference:demoSum('difference')},
 aging:{current:demoSum('current'),short:demoSum('days_1_90'),middle:demoSum('days_91_180'),long:demoSum('verified_days_181_plus'),
  unknown:demoSum('unknown'),needs_review:demoCustomers.filter(row=>row.days_181_plus<0).length},
 exposure:demoCustomers.map(row=>({customer:row.customer,book:row.book,residual:row.days_181_plus,verified:row.verified_days_181_plus}))
}};

function demoApi(path,data){
 if(data!==undefined)throw Error('演示页面为只读。');
 const url=new URL(path,'https://demo.invalid/');
 const get=key=>url.searchParams.get(key)||'';
 const q=get('q').trim().toLowerCase();
 const matches=(...fields)=>fields.some(field=>String(field).toLowerCase().includes(q));
 const rowsPage=rows=>({rows,page:1,next:false});
 switch(url.pathname){
  case '/state': return demoState;
  case '/erp/customers': return rowsPage(demoCustomers.filter(row=>matches(row.customer)));
  case '/erp/orders': {
   const customer=demoCustomers.find(row=>row.customer===get('customer'));
   const n=demoCustomers.indexOf(customer)+1;
   const buckets=[['current','2026-09-13','2026-11-12',0],['days_1_90','2026-07-17','2026-09-15',46],
    ['days_91_180','2026-04-13','2026-06-12',141],['verified_days_181_plus','2026-02-08','2026-04-09',205],
    ['unknown','2026-10-15',null,null]];
   const orders=customer?buckets.flatMap(([bucket,first_day,first_due,max_days],i)=>{
    const order_no='DEMO-SO-'+n+'-'+(i+1),document='DEMO-AR-'+n+'-'+(i+1);
    const estimated=customer[bucket],paid=i===0?customer.paid:0;
    return estimated&&matches(order_no,document)?[{order_no,document,org:'示例主体',first_day,first_due,max_days,unknown:!first_due,
     order_total:estimated+paid,invoiced:estimated+paid,paid,estimated}]:[];
   }):[];
   return {...rowsPage(orders),customer};
  }
  case '/erp/revenue': {
   const month=demoMonths.find(row=>row.id===get('month'));
   const rows=month?[0,1].map(i=>({order_no:'DEMO-REV-'+month.id+'-'+(i+1),date:month.id+'-'+(10+i*10),kind:i?'服务收入':'产品收入',
    customer:demoCustomers[i].customer,net:month.net*(i?.4:.6),gross:month.gross*(i?.4:.6),invoice:'DEMO-INV-'+(i+1)})):[];
   const filtered=rows.filter(row=>matches(row.customer,row.order_no));
   return {...rowsPage(filtered),kinds:filtered.map(row=>({...row,lines:1}))};
  }
  case '/budgets': return {department:demoBudget.department,fill:false,review:false,departments:[demoBudget.department],
   rows:Number(get('year'))===demoYear?[demoBudget]:[]};
  case '/budgets/detail':
   if(Number(get('year'))===demoYear&&get('department')===demoBudget.department)return {budget:demoBudget};
   break;
  case '/skills': return {skills:demoSkills};
 }
 const skill=demoSkills.find(skill=>url.pathname==='/skills/'+skill.id);
 if(skill)return {skill};
 throw Error('演示中没有这项数据。');
}
