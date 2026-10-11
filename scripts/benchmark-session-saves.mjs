import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const home = fs.mkdtempSync(path.join(os.tmpdir(),'unjailed-save-bench-'));
process.env.UNJAILED_HOME=home;
const { newSession, saveSession, appendSession, loadSession, sessionsDir } = await import('../dist/sessions.js');
try {
  const seed=Array.from({length:4000},(_,i)=>({role:i%2?'assistant':'user',content:`message ${i}: `+'content '.repeat(180)}));
  const old=newSession('/fake-project','test'), current=newSession('/fake-project','test');
  old.messages=[...seed];current.messages=[...seed];
  saveSession(old);await appendSession(current);
  const file=path.join(sessionsDir(),current.id+'.json'), journal=file.replace(/\.json$/,'.jsonl');
  const before=fs.statSync(journal).size;
  let oldMs=0,currentMs=0,oldBytes=0,metadataBytes=0;
  for(let i=0;i<20;i++) {
    const turn=[{role:'user',content:`new task ${i}`},{role:'assistant',content:`new response ${i}`}];
    old.messages.push(...turn);current.messages.push(...turn);
    let start=performance.now();saveSession(old);oldMs+=performance.now()-start;
    oldBytes+=fs.statSync(path.join(sessionsDir(),old.id+'.json')).size;
    start=performance.now();await appendSession(current);currentMs+=performance.now()-start;
    metadataBytes+=fs.statSync(file).size;
  }
  const restored=loadSession(current.id);
  if(JSON.stringify(restored.messages)!==JSON.stringify(current.messages))throw new Error('Saved history mismatch');
  const receipt={fakeLocalDataOnly:true,customerMutations:0,historyMessages:4000,newTurns:20,savedMessages:restored.messages.length,fullHistoryPreserved:true,previous:{totalRewriteMs:Number(oldMs.toFixed(2)),writtenBytes:oldBytes},current:{totalAppendMs:Number(currentMs.toFixed(2)),newJournalBytes:fs.statSync(journal).size-before,metadataBytes,writtenBytes:fs.statSync(journal).size-before+metadataBytes}};
  fs.mkdirSync(new URL('../receipts/',import.meta.url),{recursive:true});
  fs.writeFileSync(new URL('../receipts/session-save-benchmark.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt,null,2));
} finally { fs.rmSync(home,{recursive:true,force:true}); }
