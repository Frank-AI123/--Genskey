from importlib import import_module
import json
import sqlite3
import unittest

erp = import_module('reconcile-erp')

SCHEMA = '''ATTACH DATABASE ':memory:' AS aux;
    CREATE TABLE revenue (line,customer,org,order_no,document,date,gross,ledger,status,invoice);
    CREATE TABLE aux.book (customer,balance);
    CREATE TABLE aux.term (customer,value);
    CREATE TABLE aux.invoice (line,request,day,customer,org,status,refund_status,life,number,orders,reconciliation,actual,gross,refund);
    CREATE TABLE aux.receipt (sheet,line,day,customer,org,amount,currency,returned,bill,refs,older_hint,trace,splits,target_month,ambiguous_month);
'''
RECEIPT_INSERT = 'INSERT INTO aux.receipt VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'

class ErpReconcile(unittest.TestCase):
    def test_age_boundaries(self):
        self.assertEqual([erp.age_bucket(d) for d in (-1,0,1,90,91,180,181)], [0,0,1,1,2,2,3])

    def test_targeted_receipts_take_precedence_without_crossing_scope(self):
        with sqlite3.connect(':memory:') as db:
            db.executescript(SCHEMA+'''INSERT INTO aux.book VALUES ('A',14000),('B',7000);
                INSERT INTO aux.term VALUES ('A','30');''')
            db.executemany('INSERT INTO revenue VALUES (?,?,?,?,?,?,?,?,?,?)', [
                (1,'A','X','LC260001','A1','2026-01-01',10000,'财务应收','已审核','12345678'),
                (2,'A','X','LC260002','A2','2026-01-02',10000,'财务应收','已审核','12345678'),
                (3,'B','X','LC260001','B1','2026-01-01',7000,'财务应收','已审核',''),
                (4,'A','Y','LC260001','A3','2026-01-01',8000,'财务应收','已审核',''),
                (5,'A','X','LC260003','A4','2026-11-01',8000,'财务应收','已审核','')])
            memo = 'LC260001\t20.00\nLC260002：20.00 元'
            splits = erp.source.receipt_splits(memo)
            self.assertEqual(splits,{'LC260001':2000,'LC260002':2000})
            shared = ('2026-01-03','A','X',4000,'人民币',0,0,json.dumps(list(splits)),0,'r1',json.dumps(splits))
            db.executemany(RECEIPT_INSERT, [row+(None,0) for row in [
                ('X',1,'2026-01-03','A','X',7000,'人民币',0,0,'[]',0,'r1','{}'),
                ('X',2,'2026-01-04','A','X',8000,'人民币',0,0,json.dumps(['LC260001']),0,'r2','{}'),
                ('X',3,'2026-01-05','B','Y',3000,'人民币',0,0,'[]',0,'r3','{}'),
                ('X',4,*shared),
                ('X',5,*shared),
                ('X',6,'2026-01-03','A','X',100,'人民币',0,0,json.dumps(list(splits)),0,'r4',json.dumps(splits))]])
            db.execute("INSERT INTO aux.invoice VALUES (1,'I','2026-01-02','A','X','已开票','','正常','12345678','[]','','200',20000,0)")
            erp.reconcile(db,'2026-10-31','2026-01-01')
            rows = [tuple(r) for r in db.execute('SELECT customer,org,order_no,paid,estimated,invoiced FROM order_summary ORDER BY 1,2,3')]
            self.assertEqual(rows,[('A','X','LC260001',10000,0,10000),('A','X','LC260002',9000,1000,10000),
                                   ('A','Y','LC260001',0,8000,None),('B','X','LC260001',0,7000,None)])
            a,b = db.execute('SELECT days_181_plus,unknown,difference FROM customer_summary ORDER BY customer').fetchall()
            self.assertEqual(tuple(a),(9000,0,5000))
            self.assertEqual(tuple(b),(0,7000,0))
            self.assertEqual(db.execute('SELECT unmatched_receipt FROM snapshot').fetchone()[0],3100)
            review = [tuple(r) for r in db.execute('SELECT line,applied FROM receipt_review ORDER BY line')]
            self.assertEqual(review,[(1,7000),(2,8000),(3,0),(4,4000),(6,0)])

    def test_month_formats_and_cross_year(self):
        cases = [('26年2月检测费','2026-02'),('2026.02月检测费（账单号5241293）','2026-02'),
                 (202602,'2026-02'),('2026/02/07','2026-02'),('12月','2025-12'),(2504,'2025-04'),
                 (None,None),('SY260327002',None)]
        for value,expected in cases:
            self.assertEqual(erp.source.receipt_month(value,'2026-03-10'),(expected,False),value)
        for value in ('2026年1-3月','25.9月、26.3月、24.8月','26年1月和2月','2026-02-31'):
            self.assertEqual(erp.source.receipt_month(value,'2026-03-10'),(None,True),value)

    def test_month_receipts_do_not_spill_to_other_orders(self):
        with sqlite3.connect(':memory:') as db:
            db.executescript(SCHEMA+"INSERT INTO aux.book VALUES ('A',40000);")
            orders = [(1,'A','X','LC260001','2026-01-01',10000),(2,'A','X','LC260002','2026-02-02',10000),
                      (3,'A','X','LC260003','2026-02-28',8000),(4,'A','Y','LC260004','2026-02-02',9000),
                      (5,'B','X','LC260005','2026-02-02',7000),(6,'A','X','LC260006','2026-03-07',7000),
                      (7,'A','X','LC260007','2026-03-11',7000)]
            db.executemany('INSERT INTO revenue VALUES (?,?,?,?,?,?,?,?,?,?)',[
                (i,c,o,n,n,day,gross,'财务应收','已审核','') for i,c,o,n,day,gross in orders])
            receipts = [(1,'2026-02-01',3000,[],None,0),(2,'2026-02-03',18000,[],'2026-02',0),
                        (3,'2026-02-05',4000,['LC260002'],'2026-01',0),
                        (4,'2026-02-05',10000,[],'2025-12',0),(5,'2026-02-05',500,[],None,1),
                        (6,'2026-03-01',8000,[],None,0)]
            db.executemany(RECEIPT_INSERT,[('X',i,day,'A','X',amount,'人民币',0,0,json.dumps(refs),0,str(i),'{}',month,ambiguous)
                for i,day,amount,refs,month,ambiguous in receipts])
            erp.reconcile(db,'2026-10-31','2026-01-01')
            self.assertEqual([tuple(r) for r in db.execute('SELECT line,applied,allocation_method FROM receipt_review ORDER BY line')],
                             [(1,0,'收款月先进先出'),(2,14000,'月份'),(3,4000,'订单'),(4,0,'月份'),(5,0,None),(6,8000,'收款月先进先出')])
            self.assertEqual([tuple(r) for r in db.execute('SELECT order_no,estimated FROM order_summary ORDER BY order_no')],
                             [('LC260001',10000),('LC260002',0),('LC260003',0),('LC260004',9000),('LC260005',7000),('LC260006',0),('LC260007',6000)])
