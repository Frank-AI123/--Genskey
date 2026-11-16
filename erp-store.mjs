import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';

const customerAging = `SELECT customer, book, estimated, current, days_1_90, days_91_180,
  book - current - days_1_90 - days_91_180 AS days_181_plus,
  days_181_plus AS verified_days_181_plus, unknown, difference, term, order_count,
  coalesce((SELECT sum(o.paid) FROM order_summary o WHERE o.customer=customer_summary.customer),0) AS paid
  FROM customer_summary`;

const revenueDetail = `WITH numbered AS (
  SELECT line, order_no, date, kind, customer, net, gross, invoice,
    row_number() OVER group_key AS position,
    count(*) OVER group_key AS source_lines,
    count(*) FILTER (WHERE gross IS NULL) OVER group_key AS missing_gross,
    sum(net) OVER group_key AS net_total,
    sum(gross) OVER group_key AS gross_total,
    min(coalesce(nullif(net,0),gross,0)) OVER group_key < 0
      AND max(coalesce(nullif(net,0),gross,0)) OVER group_key > 0 AS mixed_sign
  FROM revenue
  WHERE date BETWEEN ? AND ? AND (instr(order_no,?)>0 OR instr(customer,?)>0)
  WINDOW group_key AS (
    PARTITION BY order_no,date,customer,kind,org,invoice,CASE WHEN order_no='其他' THEN line END
    ORDER BY line ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
)
SELECT order_no,date,kind,customer,invoice,
  CASE WHEN mixed_sign THEN net_total ELSE net END AS net,
  CASE WHEN mixed_sign THEN gross_total ELSE gross END AS gross,
  CASE WHEN mixed_sign THEN missing_gross ELSE gross IS NULL END AS missing,
  CASE WHEN mixed_sign THEN source_lines ELSE 1 END AS source_lines
FROM numbered`;

const orderDetail = `WITH customer_orders AS (
  SELECT * FROM order_summary WHERE customer=?
), documents AS (
  SELECT r.org,r.document,min(r.date) AS date,min(r.kind) AS kind,
    sum(r.net) AS net,sum(r.gross) AS gross
  FROM revenue r CROSS JOIN snapshot s
  WHERE r.customer=? AND r.order_no='其他' AND r.document<>'' AND r.org<>''
    AND r.date BETWEEN s.period_start AND s.as_of
  GROUP BY r.org,r.document
  HAVING count(DISTINCT r.date)=1 AND count(DISTINCT r.kind)=1 AND count(DISTINCT r.ledger)=1
    AND count(*)=count(r.gross) AND min(r.status)='已审核' AND max(r.status)='已审核'
    AND min(r.ledger) IN ('财务应收','暂估应收')
), candidates AS (
  SELECT p.org,p.document AS positive,n.document AS negative,
    count(*) OVER (PARTITION BY p.org,p.document) AS positive_matches,
    count(*) OVER (PARTITION BY n.org,n.document) AS negative_matches
  FROM documents p JOIN documents n
    ON n.org=p.org AND n.date=p.date AND n.kind=p.kind AND n.gross=-p.gross AND n.net=-p.net
  WHERE p.gross>0
), pairs AS (
  SELECT org,positive,negative FROM candidates WHERE positive_matches=1 AND negative_matches=1
), displayed AS (
  SELECT o.*,1 AS document_count FROM customer_orders o
  WHERE o.order_no<>'其他' OR NOT EXISTS (
    SELECT 1 FROM pairs p WHERE p.org=o.org AND o.document IN (p.positive,p.negative)
  )
  UNION ALL
  SELECT p.customer,p.org,p.order_no,p.document||' / '||n.document,p.first_day,
    coalesce(min(p.first_due,n.first_due),p.first_due,n.first_due),
    coalesce(max(p.max_days,n.max_days),p.max_days,n.max_days),p.order_total+n.order_total,
    CASE WHEN p.invoiced IS NOT NULL OR n.invoiced IS NOT NULL THEN coalesce(p.invoiced,0)+coalesce(n.invoiced,0) END,
    p.paid+n.paid,p.estimated+n.estimated,p.ar_basis+n.ar_basis,p.unknown+n.unknown,p.credit+n.credit,2
  FROM pairs m
  JOIN customer_orders p ON p.org=m.org AND p.order_no='其他' AND p.document=m.positive
  JOIN customer_orders n ON n.org=m.org AND n.order_no='其他' AND n.document=m.negative
)
SELECT * FROM displayed`;

export function erpStore(path){
  function read(run,otherwise=null){
    if(!existsSync(path))return otherwise;
    const db=new DatabaseSync(path,{readOnly:true});
    try{return run(db)}finally{db.close()}
  }
  const pageSize=50;
  return {
    overdue180(){return read(db=>{
      const items=db.prepare(`SELECT as_of,customer,days_181_plus AS cents FROM snapshot
        LEFT JOIN customer_summary ON days_181_plus>0 ORDER BY cents DESC,customer`).all();
      if(!items.length)return null;
      const rows=items.filter(item=>item.customer!==null).map(({customer,cents})=>({customer,cents}));
      return {asOf:items[0].as_of,rows,total:rows.reduce((total,row)=>total+row.cents,0)};
    })},
    summary(){return read(db=>({
      months:db.prepare('SELECT * FROM revenue_month ORDER BY id').all(),
      snapshot:db.prepare('SELECT snapshot.*, coalesce((SELECT sum(applied) FROM receipt_review),0) AS paid FROM snapshot').get(),
      aging:db.prepare(`SELECT coalesce(sum(current),0) AS current,
        coalesce(sum(days_1_90),0) AS short,coalesce(sum(days_91_180),0) AS middle,
        coalesce(sum(days_181_plus),0) AS long,coalesce(sum(unknown),0) AS unknown,
        count(*) FILTER (WHERE book-current-days_1_90-days_91_180<0) AS needs_review
        FROM customer_summary`).get(),
      exposure:db.prepare(`SELECT customer,book,book-current-days_1_90-days_91_180 AS residual,days_181_plus AS verified
        FROM customer_summary WHERE book-current-days_1_90-days_91_180>0 OR days_181_plus>0
        ORDER BY customer`).all()
    }))},
    details(route,params){
      const page=Math.min(10000,Math.max(1,Number.parseInt(params.get('page'),10)||1));
      const offset=(page-1)*pageSize;
      const q=(params.get('q')??'').trim().slice(0,120);
      return read(db=>{
        function paged(sql,where,args){
          const rows=db.prepare(sql+' '+where+' LIMIT ? OFFSET ?').all(...args,pageSize+1,offset);
          return {rows:rows.slice(0,pageSize),next:rows.length>pageSize,page};
        }
        if(route==='customers')return paged(customerAging,
          'WHERE instr(customer,?)>0 ORDER BY coalesce(book,estimated,0) DESC,customer', [q]);
        if(route==='orders'){
          const customer=(params.get('customer')??'').slice(0,120);
          return {customer:db.prepare(customerAging+' WHERE customer=?').get(customer)??null,
            ...paged(orderDetail,
              'WHERE order_total IS NOT 0 AND (instr(order_no,?)>0 OR instr(document,?)>0) ORDER BY estimated DESC,first_day,order_no,org,document',
              [customer,customer,q,q])};
        }
        if(route==='revenue'){
          const month=params.get('month')??'';
          if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return {rows:[],next:false,page,kinds:[]};
          return { ...paged(revenueDetail,
            'WHERE NOT mixed_sign OR position=1 ORDER BY date,line',
            [month+'-01',month+'-31',q,q]),kinds:db.prepare('SELECT * FROM revenue_kind WHERE month=? ORDER BY net DESC').all(month)};
        }
        return null;
      });
    }
  };
}
