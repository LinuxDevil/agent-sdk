// Extract ts/tsx/js fenced code blocks from the selected docs into standalone files.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const DOCS = ['quick-start','installation','api-overview','tools','sessions','approvals','memory','providers','deployment','nextjs','streaming','structured-output','testing','handoffs','configuration'];
const out = new URL('./snippets/', import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1');
rmSync(out,{recursive:true,force:true}); mkdirSync(out,{recursive:true});
const index=[];
for (const d of DOCS) {
  const lines = readFileSync(`E:/agent-sdk/docs/${d}.md`,'utf8').split(/\r?\n/);
  let inBlock=false, lang='', start=0, buf=[], n=0;
  for (let i=0;i<lines.length;i++){
    const l=lines[i];
    const m=l.match(/^\s*```(\w*)/);
    if(!inBlock && m){inBlock=true;lang=m[1];start=i+1;buf=[];continue;}
    if(inBlock && /^\s*```\s*$/.test(l)){
      inBlock=false;
      if(['ts','typescript','tsx','js','javascript'].includes(lang)){
        n++; const ext = lang==='tsx'?'tsx':'ts';
        const name=`${d}__${String(n).padStart(2,'0')}_L${start+1}.${ext}`;
        writeFileSync(join(out,name), `// ${d}.md:${start+1}\n`+buf.join('\n')+'\nexport {};\n');
        index.push(name);
      }
      continue;
    }
    if(inBlock) buf.push(l);
  }
}
console.log(index.length,'snippets');
