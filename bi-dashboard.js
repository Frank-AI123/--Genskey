let biRiskMode='residual';
const biLabels={residual:'账面倒算',verified:'订单核实'};
const biWan=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1,minimumFractionDigits:1});
const biCompact=value=>biWan.format(value/1000000)+' 万';
const biPeriod=value=>Number(value.slice(5))+' 月';
const biClient=customer=>'#ar?'+new URLSearchParams({customer});

function biMetric(label,value,detail,tone=''){
 return '<article class="bi-metric '+tone+'"><span>'+label+'</span><strong>'+value+'</strong><small>'+detail+'</small></article>';
}

function biRevenueChart(months,selected){
 const high=Math.max(1,...months.map(r=>r.net)),low=Math.min(0,...months.map(r=>r.net));
 const step=10**Math.floor(Math.log10(high));
 const upper=Math.ceil(high/step)*step;
 const lower=low<0?Math.floor(low/step)*step:0;
 const span=upper-lower,zero=100*upper/span;
 const ticks=[upper,(3*upper+lower)/4,(upper+lower)/2,(upper+3*lower)/4,lower];
 const guides=ticks.map((v,i)=>'<div class="bi-guide" style="--level:'+i*25+'%"><span>'+Math.round(v/1000000).toLocaleString('zh-CN')+'</span></div>').join('');
 const bars=months.map(m=>{
  const chosen=m.id===period;
  const start=m.net>0?100*(upper-m.net)/span:zero;
  const size=100*Math.abs(m.net)/span;
  const label=m.id+' 不含税收入 '+yuan(m.net);
  return '<button type="button" class="bi-month '+(m.net<0?'negative':'')+'" data-bi-month="'+m.id+'" aria-pressed="'+chosen+'" aria-label="'+esc(label)+'" title="'+esc(label)+'"><span class="bi-column" style="--start:'+start+'%;--size:'+size+'%"></span><span class="bi-month-label">'+biPeriod(m.id)+'</span></button>';
 }).join('');
 return '<section class="bi-panel"><div class="bi-panel-head"><div><h2>月度收入趋势</h2><p>'+period.slice(0,4)+' 年 · ERP 不含税 · 万元</p></div>'+
 (selected?'<button type="button" class="bi-text-button" data-erp-month="'+period+'">'+biPeriod(period)+'明细 ↗</button>':'')+'</div>'+
 (months.length?'<div class="bi-chart"><div class="bi-guides" aria-hidden="true">'+guides+'</div><div class="bi-bars" aria-label="点击月份切换收入指标">'+bars+'</div></div>':'<p class="empty">所选年度暂无 ERP 月度收入。</p>')+'</section>';
}

function biAgingChart(aging){
 const buckets=[['未逾期',aging.current,'#147d72'],['逾期 1–90 天',aging.short,'#57aa9c'],['逾期 91–180 天',aging.middle,'#e6a94e'],['逾期 181 天及以上',aging.long,'#d76e53'],['账期待确认',aging.unknown,'#a7b6c6']];
 const total=sum(buckets,([,value])=>value);
 let start=0;
 const stops=buckets.filter(([,value])=>value>0).map(([,value,color])=>{
  const end=start+100*value/total;
  const stop=color+' '+start+'% '+end+'%';
  start=end;
  return stop;
 });
 const gradient=stops.length?'conic-gradient('+stops.join(',')+')':'#e7edf2';
 return '<section class="bi-panel"><div class="bi-panel-head"><div><h2>应收账龄结构</h2><p>按订单到期日测算 · 含账期待确认金额</p></div></div>'+
 '<div class="bi-aging"><div class="bi-donut" style="--segments:'+gradient+'"><div><small>订单测算余额</small><strong>'+biCompact(total)+'</strong></div></div>'+
 '<ul class="bi-legend">'+buckets.map(([label,value,color])=>'<li><i style="--swatch:'+color+'"></i><span>'+label+'</span><b title="'+yuan(value)+'">'+biCompact(value)+'</b></li>').join('')+'</ul></div></section>';
}

function biRiskRows(rows,mode){
 return rows.filter(r=>r[mode]>0).sort((a,b)=>b[mode]-a[mode]||a.customer.localeCompare(b.customer,'zh-CN'));
}

function biRiskPanel(exposure,aging){
 const mode=biRiskMode,rows=biRiskRows(exposure,mode);
 const top=rows.slice(0,5),total=sum(rows,r=>r[mode]);
 const topShare=pct(sum(top,r=>r[mode]),total);
 const note=mode==='residual'
  ? '倒算额可能含期初应收、缺账期和核销差异。另有 '+aging.needs_review+' 家倒算为负，待核对。'
  : '按到期日可核实的未结订单余额汇总。';
 const ranking=top.map((r,i)=>'<li><span class="bi-rank-number">'+String(i+1).padStart(2,'0')+'</span><div><a href="'+biClient(r.customer)+'">'+esc(r.customer)+'</a><div class="bi-rank-track"><span style="width:'+100*r[mode]/top[0][mode]+'%"></span></div></div><strong>'+yuan(r[mode])+'</strong></li>').join('');
 const all=rows.map(r=>['<a href="'+biClient(r.customer)+'">'+esc(r.customer)+'</a>',erpMoney(r.book),erpMoney(r.residual),yuan(r.verified)]);
 return '<section class="bi-panel bi-risk" id="bi-long-overdue"><div class="bi-panel-head"><div><h2>逾期超过 180 天的客户</h2><p>按金额降序 · 点击客户查看订单</p></div><div class="bi-switch" role="group" aria-label="逾期金额口径">'+Object.entries(biLabels).map(([key,label])=>'<button type="button" data-bi-risk="'+key+'" aria-pressed="'+(mode===key)+'">'+label+'</button>').join('')+'</div></div>'+
 '<div class="bi-risk-grid"><div class="bi-risk-insight"><small>'+biLabels[mode]+' · 逾期 181 天及以上</small><strong>'+yuan(total)+'</strong><dl><div><dt>涉及客户</dt><dd>'+rows.length+' 家</dd></div><div><dt>前五客户占比</dt><dd>'+topShare+'</dd></div></dl><p>'+note+'</p></div>'+
 (top.length?'<ol class="bi-ranking">'+ranking+'</ol>':'<p class="empty">暂无符合该口径的客户。</p>')+'</div>'+
 (rows.length?'<details class="bi-all"><summary>查看全部 '+rows.length+' 家客户</summary>'+grid(['客户','账面期末余额','181 天及以上（倒算）','181 天及以上（订单核实）'],all)+'</details>':'')+'</section>';
}

function executiveDashboard(){
 const {snapshot:s,aging,exposure}=state.erp;
 const months=state.erp.months.filter(r=>r.id.startsWith(period.slice(0,4)));
 const ytd=months.filter(r=>r.id<=period),current=months.find(r=>r.id===period);
 const previous=state.erp.months.find(r=>{
  const [year,month]=period.split('-').map(Number);
  return r.id===(month===1?(year-1)+'-12':year+'-'+String(month-1).padStart(2,'0'));
 });
 const mom=current&&previous?.net?pct(current.net-previous.net,Math.abs(previous.net)):'—';
 const residualRows=biRiskRows(exposure,'residual');
 const report=state.report.find(r=>r.id===period);
 return '<div class="bi-dashboard"><section class="bi-hero"><div><p class="bi-kicker">财务与经营</p><h1>经营驾驶舱</h1><p>月度收入、资金回收与客户账龄</p></div><div class="bi-dates"><div><span>收入期间</span><b>'+period+'</b></div><div><span>应收截止日</span><b>'+s.as_of+'</b></div></div></section>'+
 '<section class="bi-metrics" aria-label="核心经营指标">'+
 biMetric('本年累计 ERP 收入',ytd.length?yuan(sum(ytd,r=>r.net)):'—',ytd.length?'不含税 · 至 '+ytd.at(-1).id:'所选期间暂无 ERP 收入')+
 biMetric('当月 ERP 收入',current?yuan(current.net):'—','不含税 · 较上月 <b>'+mom+'</b>')+
 biMetric('账面期末应收',yuan(s.book),s.book_customers+' 家客户 · '+s.as_of)+
 biMetric('已分配回款',yuan(s.paid),'已分配至财务应收')+
 biMetric('逾期 180 天以上',yuan(sum(residualRows,r=>r.residual)),residualRows.length+' 家 · 账面倒算正值合计','bi-metric-risk')+'</section>'+
 '<div class="bi-charts">'+biRevenueChart(months,current)+biAgingChart(aging)+'</div>'+biRiskPanel(exposure,aging)+
 (report?'<section class="bi-panel bi-report"><div class="bi-panel-head"><div><h2>合并报表指标</h2><p>'+period+(report.cumulative?' · 本年累计':' · 当月')+'</p></div><button class="bi-text-button" type="button" data-tab="statements">查看财务报表 ↗</button></div><div class="bi-metrics bi-report-metrics">'+
 biMetric('营业收入',yuan(report.revenue),'合并利润表')+biMetric('毛利率',pct(report.revenue-report.cost,report.revenue),'营业收入减营业成本')+biMetric(report.company?'营业利润':'经营利润（简化）',yuan(report.operating??report.revenue-report.cost-report.expense),'合并报表口径')+biMetric('经营现金流净额',yuan(report.cash),'现金流量表')+'</div></section>':'')+
 (months.length?'<details class="bi-monthly"><summary>查看 ERP 月度收入底表</summary>'+erpTrend()+'</details>':'')+'</div>';
}
