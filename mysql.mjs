import {spawn} from 'node:child_process';

// Encode every value as a UTF-8 hexadecimal literal. SQL is passed on stdin.
const literal=value=>"_utf8mb4 X'"+Buffer.from(value,'utf8').toString('hex')+"'";
const table='finance_record';
const count=async(sql,query)=>Number((await query(sql+'; SELECT ROW_COUNT();')).trim());

export function mysqlStore(){
  const port=Number(process.env.FINANCE_MYSQL_PORT||3306);
  const profile=process.env.FINANCE_MYSQL_LOGIN_PATH||'finance-desk';
  if(!Number.isInteger(port)||port<1||port>65535||!/^[a-zA-Z0-9_-]+$/.test(profile))throw Error('MySQL 端口或登录配置名称无效');
  if(process.env.FINANCE_MYSQL_DATABASE&&!/^[a-zA-Z0-9_]+$/.test(process.env.FINANCE_MYSQL_DATABASE))throw Error('MySQL 数据库名称无效');
  const database=process.env.FINANCE_MYSQL_DATABASE||'finance_desk';
  function query(sql){
    return new Promise((resolve,reject)=>{
      const child=spawn(process.env.FINANCE_MYSQL_BINARY||'mysql',['--no-defaults','--login-path='+profile,'--protocol=TCP','--host=127.0.0.1','--port='+port,'--database='+database,'--connect-timeout=5','--default-character-set=utf8mb4','--binary-mode','--batch','--raw','--skip-column-names'],{windowsHide:true});
      let out='',err='';
      child.stdout.setEncoding('utf8').on('data',chunk=>{out+=chunk;if(out.length>32000000){child.kill();reject(Error('MySQL 返回的数据过大'))}});
      child.stderr.setEncoding('utf8').on('data',chunk=>{err+=chunk});
      const timeout=setTimeout(()=>{child.kill();reject(Error('MySQL 查询超时'))},30000);
      child.on('error',error=>{clearTimeout(timeout);reject(Error('无法启动 MySQL 客户端：'+error.code))});
      child.stdin.on('error',()=>{});
      child.on('close',code=>{
        clearTimeout(timeout);
        if(code===0)resolve(out);
        else reject(Error('MySQL 调用失败'+(err.match(/ERROR \d+(?: \([A-Z0-9]+\))?/)?.[0]?' ('+err.match(/ERROR \d+(?: \([A-Z0-9]+\))?/)[0]+')':'')));
      });
      child.stdin.end(sql+';\n');
    });
  }
  return {
    async list(){
      const result=await query('SELECT type, CAST(data AS CHAR CHARACTER SET utf8mb4) FROM '+table+' ORDER BY id,type');
      return result.split(/\r?\n/).filter(Boolean).map(line=>{const tab=line.indexOf('\t');return {type:line.slice(0,tab),data:line.slice(tab+1)}});
    },
    async write(rows,keepExisting=false){
      if(!rows.length)return;
      const values=rows.map(({type,id,data})=>'('+[type,id,data].map(literal).join(',')+')').join(',');
      await query('INSERT INTO '+table+' (type,id,data) VALUES '+values+' AS incoming ON DUPLICATE KEY UPDATE data='+(keepExisting?table+'.data':'incoming.data'));
    },
    async payment(id,amount){
      if(!Number.isSafeInteger(amount)||amount<=0)throw Error('无效回款金额');
      const paid="CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.paid')) AS SIGNED)";
      const total="CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.amount')) AS SIGNED)";
      return count("UPDATE "+table+" SET data=JSON_SET(data,'$.paid',"+paid+"+"+amount+") WHERE type='ar' AND id="+literal(id)+" AND "+total+"-"+paid+">="+amount,query);
    },
    async check(){await query('SELECT type,id FROM '+table+' LIMIT 0')}
  };
}
