import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
const [page,styles,dashboard,assistant,budgetStyles,budget]=await Promise.all(['index.html','bi-dashboard.css','bi-dashboard.js','bi-assistant.js','budget.css','budget.js'].map(file=>readFile(file,'utf8')));
const html=page.replace('/* BI_DASHBOARD_STYLES */',()=>styles).replace('/* BI_DASHBOARD_SCRIPT */',()=>dashboard)
  .replace('/* BI_ASSISTANT_SCRIPT */',()=>assistant)
  .replace('/* BUDGET_STYLES */',()=>budgetStyles).replace('/* BUDGET_SCRIPT */',()=>budget);
await Promise.all(['budget.mjs','bi-ai.mjs','wecom-feedback.mjs'].map(file=>copyFile(file,'dist/server/'+file)));
await writeFile('dist/server/index.js','const html = '+JSON.stringify(html)+';\n'+await readFile('worker.js','utf8'));

const demo=await readFile('demo.js','utf8');
const demoHtml=html
  .replace('data-account-mode="hosted"','data-account-mode="demo"')
  .replace('<title>财务管理工作台</title>','<title>财务管理工作台 v2 · 演示</title>')
  .replace('<meta charset="utf-8">','<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">')
  .replace('/* DEMO_SCRIPT */',()=>demo);
await writeFile('dist/index.html',demoHtml);
