import {mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
const html=await readFile('index.html','utf8');
await writeFile('dist/server/index.js','const html = '+JSON.stringify(html)+';\n'+await readFile('worker.js','utf8'));
