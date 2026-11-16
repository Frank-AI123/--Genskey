"""Build the order and customer review snapshot without changing the accounting ledger."""
import argparse
from collections import Counter, defaultdict
from datetime import date, timedelta
import importlib
import json
import sqlite3

source = importlib.import_module('import-erp')


def age_bucket(days):
    return 0 if days <= 0 else 1 if days <= 90 else 2 if days <= 180 else 3


def allocate(lots, amount):
    for lot in lots:
        if amount <= 0:
            break
        part = min(amount, lot['open'])
        lot['open'] -= part
        lot['paid'] += part
        amount -= part
    return amount


def reconcile(db, cutoff, period_start):
    db.row_factory = sqlite3.Row
    db.executescript('''
        DROP TABLE IF EXISTS snapshot; DROP TABLE IF EXISTS customer_summary; DROP TABLE IF EXISTS order_summary;
        DROP TABLE IF EXISTS receipt_review; DROP TABLE IF EXISTS invoice_review;
        CREATE TABLE snapshot(as_of TEXT NOT NULL, period_start TEXT NOT NULL, book INTEGER, book_customers INTEGER,
            estimated INTEGER NOT NULL, aged INTEGER NOT NULL, missing_terms INTEGER NOT NULL, difference INTEGER NOT NULL,
            unmatched_receipt INTEGER NOT NULL, unmatched_invoice INTEGER NOT NULL, credits INTEGER NOT NULL);
        CREATE TABLE customer_summary(customer TEXT PRIMARY KEY, book INTEGER, estimated INTEGER NOT NULL, current INTEGER NOT NULL,
            days_1_90 INTEGER NOT NULL, days_91_180 INTEGER NOT NULL, days_181_plus INTEGER NOT NULL, unknown INTEGER NOT NULL,
            difference INTEGER, term INTEGER, order_count INTEGER NOT NULL);
        CREATE TABLE order_summary(customer TEXT, org TEXT, order_no TEXT, document TEXT NOT NULL, first_day TEXT NOT NULL,
            first_due TEXT, max_days INTEGER, order_total INTEGER, invoiced INTEGER, paid INTEGER NOT NULL, estimated INTEGER NOT NULL,
            ar_basis INTEGER NOT NULL, unknown INTEGER NOT NULL, credit INTEGER NOT NULL, PRIMARY KEY(customer,org,order_no,document));
        CREATE TABLE receipt_review(sheet TEXT,line INTEGER,amount INTEGER,applied INTEGER,reason TEXT,
            target_month TEXT,allocation_method TEXT,PRIMARY KEY(sheet,line));
        CREATE TABLE invoice_review(line INTEGER PRIMARY KEY,amount INTEGER,applied INTEGER,reason TEXT);
    ''')
    books = dict(db.execute('SELECT customer,sum(balance) FROM aux.book GROUP BY customer'))
    terms = {cust:int(days) for cust, days in db.execute('SELECT customer,min(value) FROM aux.term GROUP BY customer HAVING count(DISTINCT value)=1')
             if days.isdecimal() and 0 <= int(days) <= 3650}
    order_data = {}
    monthly_pools = defaultdict(list)
    order_pools = defaultdict(list)
    by_order = defaultdict(set)
    invoice_map = defaultdict(set)
    invoice_amounts = defaultdict(lambda:defaultdict(int))
    for row in db.execute('''SELECT customer,org,order_no,CASE WHEN order_no='其他' THEN coalesce(nullif(document,''),'行'||line) ELSE '' END AS doc,
            date,gross,ledger,status,invoice FROM revenue WHERE date BETWEEN ? AND ? AND customer<>'' ORDER BY date,line''',(period_start,cutoff)):
        cust,org,number,doc,day,gross,ledger,status,invoice = row
        key = (cust,org,number,doc)
        if key not in order_data:
            order_data[key] = {'first':day,'order_total':0,'missing_gross':False,'invoiced':None,'daily':defaultdict(int)}
        data = order_data[key]
        if number != '其他':
            by_order[(cust,org,number.upper())].add(key)
        if gross is None:
            data['missing_gross'] = True
        else:
            data['order_total'] += gross
        if ledger == '财务应收' and status == '已审核':
            invoice_numbers = set(source.invoice_tokens(invoice))
            for inv in invoice_numbers:
                invoice_map[(cust,org,inv)].add(key)
                if len(invoice_numbers) == 1 and gross is not None:
                    invoice_amounts[(cust,org,inv)][key] += gross
            if gross is not None:
                data['daily'][day] += gross

    for key,data in order_data.items():
        cust,org,number,_ = key
        daily = data.pop('daily')
        # Signed ERP adjustments net within the same customer, collecting entity and order/document.
        credit = -sum(v for v in daily.values() if v<0)
        lots = []
        for day,value in sorted(daily.items()):
            if value <= 0:
                continue
            use = min(credit,value)
            credit -= use
            if value <= use:
                continue
            due = (date.fromisoformat(day)+timedelta(days=terms[cust])).isoformat() if cust in terms else None
            lot = dict(day=day,due=due,principal=value-use,open=value-use,paid=0,key=key)
            lots.append(lot)
            monthly_pools[(cust,org,day[:7])].append(lot)
            if number != '其他':
                order_pools[(cust,org,number.upper())].append(lot)
        data.update(lots=lots,credit=credit)
    for pool in (*order_pools.values(),*monthly_pools.values()):
        pool.sort(key=lambda lot:(lot['day'],lot['key']))

    unmatched_invoice = 0
    seen_requests = set()
    seen_invoices = set()
    for i,request,day,cust,org,status,refund,life,nums,raw_orders,_,actual,gross,returned in db.execute('SELECT * FROM aux.invoice ORDER BY line'):
        if request in seen_requests or status != '已开票' or life != '正常' or not day or not period_start <= day <= cutoff:
            continue
        seen_requests.add(request)
        numbers = source.invoice_tokens(nums)
        orders = json.loads(raw_orders)
        candidates = set()
        for number in orders:
            candidates.update(by_order.get((cust,org,number),()))
        for number in numbers:
            candidates.update(invoice_map.get((cust,org,number),()))
        try:
            parts = [source.cents(a) for a in actual.replace('，',',').split(',') if a.strip()]
        except ArithmeticError:
            parts = []
        amount = sum(parts) if parts else gross
        distributions = defaultdict(int)
        verified_split = bool(numbers) and len(set(numbers)) == len(numbers)
        for number in numbers:
            matched = invoice_amounts.get((cust,org,number),{})
            verified_split &= bool(matched) and set(matched) == invoice_map[(cust,org,number)]
            for key,value in matched.items():
                distributions[key] += value
        verified_split &= (set(distributions)==candidates and sum(distributions.values())==amount and
                           all(v>0 for v in distributions.values()))
        if any((org,n) in seen_invoices for n in numbers):
            reason = '发票号码重复'
        elif returned or refund:
            reason = '退票状态待核'
        elif not candidates:
            reason = '未匹配订单'
        elif not verified_split and (len(candidates) != 1 or len(orders) > 1):
            reason = '涉及多笔订单，缺少可靠分摊金额'
        else:
            reason = ''
        if not any((org,n) in seen_invoices for n in numbers):
            seen_invoices.update((org,n) for n in numbers)
        if reason:
            unmatched_invoice += 0 if reason == '发票号码重复' else amount
        else:
            for key,value in (distributions.items() if verified_split else ((next(iter(candidates)),amount),)):
                data = order_data[key]
                data['invoiced'] = (data['invoiced'] or 0)+value
        db.execute('INSERT INTO invoice_review VALUES (?,?,?,?)',(i,amount,0 if reason else amount,reason))

    pending = []
    seen_receipts = set()
    unmatched_receipt = 0
    known_orders = {key[2] for key in by_order}
    order_prefixes = {prefix[0] for number in known_orders if (prefix:=source.re.match(r'[A-Z]{1,8}(?=\d)',number))}
    for r in db.execute('SELECT * FROM aux.receipt WHERE day BETWEEN ? AND ? ORDER BY day,sheet,line',(period_start,cutoff)):
        references = [ref for ref in json.loads(r['refs']) if ref in known_orders or any(ref.startswith(p) and ref[len(p):len(p)+1].isdigit() for p in order_prefixes if p not in ('DZ','FP','AR'))]
        splits = {number:amount for number,amount in json.loads(r['splits']).items() if number in references}
        # A bank entry can be recorded on several lines with different order allocations.
        key = tuple(r[column] for column in ('trace','day','customer','org','amount','currency','returned','bill','older_hint','target_month','ambiguous_month'))
        key += (tuple(references),tuple(sorted(splits.items())))
        if r['trace']:
            if key in seen_receipts:
                continue
            seen_receipts.add(key)
        pending.append((r,references,splits))
    # Reserve balances for explicit orders and months before allocating by receipt month.
    for r,references,splits in sorted(pending,key=lambda item:0 if item[1] else 1 if item[0]['target_month'] else 2):
        amount = r['amount']
        remaining = amount
        cust,org = r['customer'],r['org']
        month = r['target_month']
        method = None
        if amount <= 0 or r['returned'] or r['currency'] not in ('','人民币','CNY'):
            reason = '退款、冲账或非人民币待核'
        elif r['bill']:
            reason = '承兑票据待核销确认'
        elif not cust or not org:
            reason = '缺少客户或收款主体'
        elif splits:
            method = '订单'
            itemized = sum(splits.values())
            if itemized > amount:
                reason = '备注分摊合计超过该笔回款'
            else:
                for number,part in splits.items():
                    targets = order_pools.get((cust,org,number),())
                    remaining -= part-allocate(targets,part)
                if remaining > amount-itemized:
                    reason = '部分备注订单未匹配或超过应收'
                elif remaining:
                    reason = '部分回款无可核实分摊金额'
                else:
                    reason = ''
        elif len(references) > 1:
            method = '订单'
            reason = '指定多个订单，缺少分摊金额'
        elif references:
            method = '订单'
            targets = order_pools.get((cust,org,references[0]),())
            remaining = allocate(targets,amount)
            reason = '指定订单未匹配或未形成应收' if not targets else '超过指定订单应收' if remaining else ''
        elif month:
            method = '月份'
            targets = monthly_pools.get((cust,org,month),())
            if month < period_start[:7] or month > cutoff[:7]:
                reason = '指定月份超出应收明细期间'
            elif not targets:
                reason = '指定月份无同客户同主体的应收订单'
            else:
                remaining = allocate(targets,amount)
                reason = '超过指定月份未结应收' if remaining else ''
        elif r['ambiguous_month']:
            reason = 'D 列涉及多个月份或日期无法确认'
        elif r['older_hint']:
            reason = '附有以前年度提示，缺期初应收明细'
        else:
            method = '收款月先进先出'
            month = r['day'][:7]
            targets = monthly_pools.get((cust,org,month),())
            remaining = allocate(targets,amount)
            if not targets:
                reason = '收款月份无同客户同主体的应收订单'
            else:
                reason = '超过收款月份未结应收' if remaining else ''
        unmatched_receipt += max(0, remaining)
        db.execute('INSERT INTO receipt_review VALUES (?,?,?,?,?,?,?)',(r['sheet'],r['line'],amount,amount-remaining,reason,month,method))

    totals = defaultdict(lambda:[0,0,0,0,0,0])
    ref_date = date.fromisoformat(cutoff)
    for (cust,org,number,doc),data in order_data.items():
        arr = [0]*5
        due_dates = []
        for lot in data['lots']:
            if lot['open'] and lot['due']:
                due_dates.append(lot['due'])
            age = (ref_date-date.fromisoformat(lot['due'])).days if lot['due'] else None
            arr[age_bucket(age) if age is not None else 4] += lot['open']
        for i,value in enumerate(arr):
            totals[cust][i] += value
        totals[cust][5] += 1
        due = min(due_dates,default=None)
        db.execute('INSERT INTO order_summary VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(cust,org,number,doc,data['first'],due,
            max(0,(ref_date-date.fromisoformat(due)).days) if due else None,
            None if data['missing_gross'] else data['order_total'],data['invoiced'],sum(l['paid'] for l in data['lots']),sum(arr),
            sum(l['principal'] for l in data['lots']),arr[4],data['credit']))
    for cust in sorted(books.keys()|totals.keys()):
        a,b,c,d,u,count = totals[cust]
        calc = a+b+c+d+u
        book = books.get(cust)
        db.execute('INSERT INTO customer_summary VALUES (?,?,?,?,?,?,?,?,?,?,?)', (cust,book,calc,a,b,c,d,u,None if book is None else book-calc,terms.get(cust),count))
    db.execute('''INSERT INTO snapshot SELECT ?,?,sum(book),count(book),sum(estimated),sum(current+days_1_90+days_91_180+days_181_plus),
               sum(unknown),sum(coalesce(book,0))-sum(estimated),?,?,(SELECT sum(credit) FROM order_summary) FROM customer_summary''',
               (cutoff,period_start,unmatched_receipt,unmatched_invoice))
    assert db.execute('SELECT count(*) FROM order_summary WHERE ar_basis<>paid+estimated').fetchone()[0]==0
    assert db.execute('SELECT count(*) FROM customer_summary WHERE estimated<>current+days_1_90+days_91_180+days_181_plus+unknown').fetchone()[0]==0
    db.commit()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('data')
    parser.add_argument('aux')
    parser.add_argument('--cutoff',default='2026-10-31',type=date.fromisoformat)
    args = parser.parse_args()
    with sqlite3.connect(args.data) as db:
        db.execute('ATTACH DATABASE ? AS aux',(args.aux,))
        reconcile(db,args.cutoff.isoformat(),args.cutoff.replace(month=1,day=1).isoformat())
        print(json.dumps(dict(db.execute('SELECT * FROM snapshot').fetchone()),ensure_ascii=False))
        print(json.dumps([tuple(r) for r in db.execute('SELECT reason,count(*),sum(amount-applied) FROM receipt_review GROUP BY reason')],ensure_ascii=False))
