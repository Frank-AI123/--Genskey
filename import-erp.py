"""Read the ERP source workbooks locally and stage them for the finance platform."""
import argparse
from hashlib import sha256
import json
import re
import sqlite3
import unicodedata
from collections import Counter
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zipfile import ZipFile

from lxml import etree
from openpyxl import load_workbook

FILES = ('1-10月收入大表.xlsx', '发票清单.xlsx', '回款数据更新表.xlsx', '应收余额.xlsx', '客户账期.xlsx')
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
def clean(value):
    return '' if value is None else str(value).strip()

def identity(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', clean(value)))

def ref_tokens(value):
    return re.findall(r'(?<![A-Z0-9])[A-Z]{1,8}\d{6,}(?:[-_]\d+)?(?![A-Z0-9])', unicodedata.normalize('NFKC', clean(value)).upper())

ORDER_AMOUNT = re.compile(
    r'^\s*([A-Z]{1,8}\d{6,}(?:[-_]\d+)?)'
    r'(?:\s+|\s*[:=]\s*)[¥￥]?\s*'
    r'(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:元)?\s*$'
)

def receipt_splits(value):
    parts = Counter()
    for line in re.split(r'[\r\n;]+', unicodedata.normalize('NFKC', clean(value)).upper()):
        match = ORDER_AMOUNT.fullmatch(line)
        if match:
            number, whole, decimals = match.groups()
            amount = cents(whole + ('.' + decimals if decimals else ''))
            if amount > 0:
                parts[number] += amount
    return parts

MONTH_NUMBER = r'(?:0?[1-9]|1[0-2])'
YEAR_NUMBER = r'(?:19\d{2}|20\d{2}|\d{2})'
DATED_MONTH = re.compile(
    rf'(?<![A-Z0-9])({YEAR_NUMBER})\s*(?:年\s*({MONTH_NUMBER})\s*月(?:\s*(\d{{1,2}})\s*[日号])?'
    rf'|[./-]\s*({MONTH_NUMBER})(?!\d)(?:[./-](\d{{1,2}})(?!\d))?\s*月?)'
)
BARE_MONTH = re.compile(rf'(?<!\d)({MONTH_NUMBER})\s*月')
MONTH_LIST = re.compile(rf'(?<!\d){MONTH_NUMBER}\s*月?\s*[-–—~～至到、,和及]+\s*{MONTH_NUMBER}\s*月')

def receipt_month(value, receipt_day):
    """Identify one business month from the workbook's month column."""
    if isinstance(value, date):
        return value.isoformat()[:7], False
    text = unicodedata.normalize('NFKC', clean(value)).upper()
    if not text:
        return None, False
    booked = date.fromisoformat(receipt_day)

    def key(year, month, day_of_month=None):
        month = int(month)
        if year is None:
            year = booked.year - (month>booked.month)
        else:
            year = int(year)
            if year < 100:
                year += 2000
        return date(year,month,int(day_of_month or 1)).isoformat()[:7]

    compact = re.fullmatch(r'(?:19|20)\d{4}(?:\d{2})?',text) or re.fullmatch(r'\d{4}',text)
    month_day = re.fullmatch(rf'({MONTH_NUMBER})/(\d{{1,2}})', text)
    try:
        if compact:
            n = 2 if len(text)==4 else 4
            return key(text[:n],text[n:n+2],text[n+2:]), False
        if month_day:
            return key(None,*month_day.groups()), False
        if MONTH_LIST.search(text):
            return None, True
        candidates = set()
        for hit in DATED_MONTH.finditer(text):
            year, chinese, chinese_day, numeric, numeric_day = hit.groups()
            candidates.add(key(year,chinese or numeric,chinese_day or numeric_day))
        remaining = DATED_MONTH.sub(' ',text)
        for hit in BARE_MONTH.finditer(remaining):
            candidates.add(key(None,hit[1]))
    except ValueError:
        return None, True
    if len(candidates)>1:
        return None, True
    return next(iter(candidates),None), False

def invoice_tokens(value):
    return re.findall(r'(?<!\d)(?:\d{20}|\d{8})(?!\d)', clean(value))

def cents(value):
    return int((Decimal(clean(value).replace(',', '').replace('，', '') or '0') * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))

def day(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()[:10]
    if isinstance(value, (int, float)) or re.fullmatch(r'\d{5}(\.\d+)?', clean(value)):
        return (date(1899, 12, 30) + timedelta(days=int(float(value)))).isoformat()
    v = clean(value).split(' ')[0].replace('/', '-').replace('.', '-').split('-')
    if len(v) != 3:
        raise ValueError('不是有效的业务日期')
    return date(*map(int, v)).isoformat()

def xml_records(path, wanted=None):
    """Stream worksheet cells; the ERP workbook expands to nearly 900 MB."""
    with ZipFile(path) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            with archive.open('xl/sharedStrings.xml') as stream:
                for _, e in etree.iterparse(stream, tag=NS+'si'):
                    strings.append(''.join(t.text or '' for t in e.iter(NS+'t')))
                    e.clear()
                    while e.getprevious() is not None:
                        del e.getparent()[0]
        getcol = re.compile(r'[A-Z]+').match
        with archive.open('xl/worksheets/sheet1.xml') as stream:
            for _, row in etree.iterparse(stream, tag=NS+'row'):
                record = {}
                for c in row.iterchildren(NS+'c'):
                    col = getcol(c.get('r'))[0]
                    if wanted is not None and col not in wanted:
                        continue
                    v = c.findtext(NS+'v')
                    typ = c.get('t')
                    if typ == 's' and v is not None:
                        v = strings[int(v)]
                    elif typ == 'inlineStr':
                        v = ''.join(t.text or '' for t in c.iter(NS+'t'))
                    elif typ == 'e':
                        v = None
                    if v is not None and str(v).strip():
                        record[col] = v
                if record:
                    yield int(row.get('r')), record
                row.clear()
                while row.getprevious() is not None:
                    del row.getparent()[0]

REVENUE_COLUMNS = dict(B='单据类型', C='单据编号', D='立账类型', E='收入业务类型', F='业务日期', G='销售订单号', H='客户', J='币别', L='单据状态', M='收款组织', AB='价税合计', AP='税额本位币', AQ='不含税金额本位币', AR='价税合计本位币', AX='发票号')

def extract_revenue(path, db):
    db.executescript('''CREATE TABLE revenue(line INTEGER PRIMARY KEY, document_type TEXT NOT NULL, document TEXT NOT NULL,
        ledger TEXT NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL, order_no TEXT NOT NULL, customer TEXT NOT NULL,
        status TEXT NOT NULL, org TEXT NOT NULL, net INTEGER NOT NULL, gross INTEGER, invoice TEXT NOT NULL, gross_source TEXT NOT NULL);
        CREATE TABLE source_notes(key TEXT PRIMARY KEY,value TEXT NOT NULL);''')
    def rows():
        blanks = Counter()
        for i, r in xml_records(path, REVENUE_COLUMNS):
            if i == 1:
                if any(r.get(key) != title for key, title in REVENUE_COLUMNS.items()):
                    raise ValueError('收入大表列名和预期不符')
                continue
            if not r.get('F'):
                blanks['no_date'] += 1
                if r.get('C') or r.get('AQ') or r.get('AR'):
                    blanks['no_date_with_amount_or_document'] += 1
                continue
            net = cents(r.get('AQ'))
            gross = None
            gross_source = 'missing'
            if r.get('AR') is not None:
                gross,gross_source = cents(r['AR']),'erp'
            elif r.get('D') in ('财务应收','暂估应收'):
                if r.get('J') == '人民币' and r.get('AB') is not None:
                    gross,gross_source = cents(r['AB']),'cny'
                elif r.get('AQ') is not None and r.get('AP') is not None:
                    gross,gross_source = net+cents(r['AP']),'net_plus_tax'
                elif r.get('AQ') is None and r.get('AB') is None and r.get('AP') is None:
                    gross,gross_source = 0,'empty_zero'
            blanks[gross_source] += 1
            yield (i, clean(r.get('B')), clean(r.get('C')), clean(r.get('D')), clean(r.get('E')), day(r['F']),
                   clean(r.get('G')) or '其他', identity(r.get('H')), clean(r.get('L')), identity(r.get('M')),
                   net, gross, clean(r.get('AX')), gross_source)
        db.execute('INSERT INTO source_notes VALUES (?,?)', ('ignored_format_rows', json.dumps(blanks)))
    db.executemany('INSERT INTO revenue VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows())
    db.executescript('''CREATE INDEX revenue_by_date ON revenue(date,line);
        CREATE TABLE revenue_month AS SELECT substr(date,1,7) AS id, sum(net) AS net, sum(gross) AS gross,
          count(*) AS lines, sum(order_no='其他') AS other, sum(gross IS NULL) AS missing,
          sum(gross_source IN ('cny','net_plus_tax')) AS derived FROM revenue GROUP BY substr(date,1,7);
        CREATE TABLE revenue_kind AS SELECT substr(date,1,7) AS month, kind, sum(net) AS net, sum(gross) AS gross,
          count(*) AS lines, sum(gross IS NULL) AS missing FROM revenue GROUP BY substr(date,1,7),kind;''')

def payment_orgs():
    path = Path(__file__).with_name('finance-erp-payment-orgs.local.json')
    if not path.is_file():
        return {}
    mapping = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(mapping, dict) or any(not isinstance(value, str) for value in mapping.values()):
        raise ValueError('回款工作表与收款主体的配置必须为 JSON 字符串映射')
    return mapping

def extract_aux(source, db):
    payment_org_by_sheet = payment_orgs()
    db.executescript('''CREATE TABLE invoice(line INTEGER PRIMARY KEY, request TEXT NOT NULL, day TEXT, customer TEXT NOT NULL,
        org TEXT NOT NULL, status TEXT NOT NULL, refund_status TEXT NOT NULL, life TEXT NOT NULL, number TEXT NOT NULL,
        orders TEXT NOT NULL, reconciliation TEXT NOT NULL, actual TEXT NOT NULL, gross INTEGER NOT NULL, refund INTEGER NOT NULL);
        CREATE TABLE receipt(sheet TEXT, line INTEGER, day TEXT NOT NULL, customer TEXT NOT NULL, org TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL, returned INTEGER NOT NULL, bill INTEGER NOT NULL, refs TEXT NOT NULL,
        older_hint INTEGER NOT NULL, trace TEXT, splits TEXT NOT NULL, target_month TEXT, ambiguous_month INTEGER NOT NULL,
        PRIMARY KEY(sheet,line));
        CREATE TABLE book(line INTEGER PRIMARY KEY, code TEXT NOT NULL, customer TEXT NOT NULL, balance INTEGER NOT NULL);
        CREATE TABLE term(line INTEGER PRIMARY KEY, customer TEXT NOT NULL, value TEXT NOT NULL);''')
    cols = 'A C D E F I J K P Y BK BM BP BU CC'.split()
    for i,r in xml_records(source/FILES[1], cols):
        if i == 1 or not r.get('A'):
            continue
        raw_actual = clean(r.get('BP'))
        amount = cents(r.get('Y') or r.get('C'))
        db.execute('INSERT INTO invoice VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (i,r['A'],day(r['D']) if r.get('D') else None,
            identity(r.get('I')),identity(r.get('K')),clean(r.get('F')),clean(r.get('BM')),clean(r.get('BU')),
            clean(r.get('BK')),json.dumps(sorted(set(ref_tokens(r.get('E'))+ref_tokens(r.get('P'))))),clean(r.get('J')),
            raw_actual,amount,cents(r.get('CC'))))
    for i,r in xml_records(source/FILES[3], 'ABC'):
        if i > 1 and r.get('A') and r.get('B') and r.get('C'):
            db.execute('INSERT INTO book VALUES (?,?,?,?)',(i,clean(r['A']),identity(r['B']),cents(r['C'])))
    for i,r in xml_records(source/FILES[4], 'AB'):
        if i > 1 and r.get('A'):
            db.execute('INSERT INTO term VALUES (?,?,?)',(i,identity(r['A']),clean(r.get('B'))))
    wb = load_workbook(source/FILES[2],read_only=True,data_only=True,keep_links=False)
    try:
        for sheet in wb:
            values = sheet.values
            first = next(values)
            headers = {clean(title): i for i,title in enumerate(first) if clean(title)}
            def get(row,*names):
                return next((row[headers[n]] for n in names if n in headers and clean(row[headers[n]])),None)
            bill = '票面金额' in headers
            for i,row in enumerate(values,2):
                amount = get(row,'贷方发生额','贷方金额','票面金额')
                dt = get(row,'回款日期','交易日期','交易日','交易日 ')
                if amount is None or dt is None:
                    continue
                customer = get(row,'收(付)方名称','对方账户名称','对方帐户名称','票据来源')
                org = get(row,'账号名称') or payment_org_by_sheet.get(sheet.title,'')
                currency = clean(get(row,'币种'))
                returned = clean(get(row,'退汇标识','冲账标志')) not in ('','否','0','N','正常','未冲账')
                hints = [get(row,h) for h in ('回款月份','回款对应月份','附言','摘要','扩展摘要','销售订单号','销售订单编号')]
                refs = sorted(set(ref for v in hints for ref in ref_tokens(v)))
                # A memo may repeat across columns. Prefer the first source that contains itemized amounts.
                splits = next((parts for hint in hints if (parts := receipt_splits(hint))), {})
                older_hint = bool(re.search(r'(?<!\d)(?:20)?2[0-5]\s*年', ' '.join(clean(v) for v in hints[:2])))
                trace = get(row,'票据号','流水号','柜员交易号')
                account = get(row,'账号','交易账号') or sheet.title
                key = sha256(f'{account}\0{trace}'.encode()).hexdigest() if trace is not None else None
                try:
                    dt_key, amount_key = day(dt), cents(amount)
                except (ValueError, ArithmeticError):
                    print('跳过非交易行',sheet.title,i,str(amount)[:25],str(dt)[:25])
                    continue
                target_month,ambiguous_month = receipt_month(row[3],dt_key) if clean(first[3]) in ('回款月份','回款对应月份') else (None,False)
                db.execute('INSERT INTO receipt VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(sheet.title,i,dt_key,identity(customer),identity(org),
                    amount_key,currency,returned,int(bill),json.dumps(refs),older_hint,key,json.dumps(splits,sort_keys=True),target_month,int(ambiguous_month)))
    finally:
        wb.close()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('stage', type=Path)
    parser.add_argument('--aux-only', action='store_true')
    args = parser.parse_args()
    with sqlite3.connect(args.stage) as db:
        if args.aux_only:
            extract_aux(args.source,db)
            for sql in ('SELECT status,refund_status,life,count(*),sum(gross),sum(number<>\'\') FROM invoice GROUP BY 1,2,3',
                        'SELECT sheet,org,substr(day,1,4),currency,returned,count(*),sum(amount) FROM receipt GROUP BY 1,2,3,4,5',
                        'SELECT count(*),count(DISTINCT customer),sum(balance),sum(balance<0) FROM book',
                        'SELECT value,count(*) FROM term GROUP BY value'):
                print(db.execute(sql).fetchall())
        else:
            extract_revenue(args.source / FILES[0], db)
            print(json.dumps(db.execute('SELECT * FROM revenue_month ORDER BY id').fetchall(),ensure_ascii=False))
            print(db.execute('SELECT ledger,status,count(*),sum(net),sum(gross) FROM revenue GROUP BY ledger,status').fetchall())
