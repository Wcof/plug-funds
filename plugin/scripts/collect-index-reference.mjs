/** 只读采集全标的官方资料并保留 URL、原文及 SHA256；同一证据目录可断点继续。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openBackfillState } from './backfill-metrics.mjs';
import { fetchCnindexSnapshot } from '../server/src/market/cnindex.ts';
import { todayLocal } from '../server/src/ids.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { csindexOfficialCode } from '../server/src/market/index-identities.ts';
const args=process.argv.slice(2);
const arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const dir=path.resolve(arg('--evidence', `.tmp/index-reference-${Date.now()}`)); fs.mkdirSync(dir,{recursive:true});
const handle=openBackfillState(path.resolve(arg('--state',path.join(os.homedir(),'.plug-funds'))));
const db=handle.db;
const codes = arg('--codes')?.split(',');
const targets = db.prepare("SELECT code,name,market,founded_date FROM instruments WHERE active=1 AND type='INDEX' ORDER BY code").all().filter((row) => !codes || codes.includes(row.code));db.close();
const cn = new Set();
const manifestFile=path.join(dir,'manifest.json');
const manifest=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile)):{};
const save=()=>{fs.writeFileSync(manifestFile+'.pending',JSON.stringify(manifest,null,2));fs.renameSync(manifestFile+'.pending',manifestFile);};
const blocked=new Map();
const exec=promisify(execFile);
async function get(code,kind,url,binary=false){
 const key=`${code}-${kind}`;const file=path.join(dir,key+'-'+createHash('sha256').update(url).digest('hex').slice(0,8)+(binary?'.pdf':'.json'));
 const cached=manifest[key];
 if(cached?.status==='OK'&&cached.url===url&&path.basename(cached.file)===cached.file){
  const oldFile=path.join(dir,cached.file);
  if(fs.existsSync(oldFile)){
   const bytes=fs.readFileSync(oldFile);
   if(createHash('sha256').update(bytes).digest('hex')!==cached.sha256)throw new Error('已保存资料 SHA256 不匹配');
   return binary?oldFile:JSON.parse(bytes);
  }
 }
 const host=new URL(url).hostname;
 const endpoint=host+new URL(url).pathname.replace(/[0-9]{6}/g,':code');
 if((blocked.get(endpoint)||0)>=3){manifest[key]={code,kind,url,status:'HOST_BLOCKED',reason:'同一端点连续三次403，中止该端点后续请求'};return null;}
 await new Promise(r=>setTimeout(r,250));
 try{
 const {stdout}=await exec('curl',['-fLsS','--max-time','15','--max-filesize','15000000','-A','Mozilla/5.0','-H',`Referer: https://${host}/`,url],{encoding:binary?'buffer':'utf8',timeout:18000,maxBuffer:15000000});
 const parsed=binary?stdout:JSON.parse(stdout);
 if(binary&&!stdout.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('not PDF');
 fs.writeFileSync(file,stdout);
 manifest[key]={code,kind,url,file:path.basename(file),capturedAt:new Date().toISOString(),sha256:createHash('sha256').update(stdout).digest('hex'),status:'OK'};
 blocked.set(endpoint,0);return binary?file:parsed;
 }catch(error){const msg=String(error.message).slice(0,300); if(msg.includes('403'))blocked.set(endpoint,(blocked.get(endpoint)||0)+1);manifest[key]={code,kind,url,status:'FETCH_FAILED',reason:msg};return null;}
}
let catalogPart=0;
const catalog=await fetchCnindexSnapshot(todayLocal(),url=>get('catalog',`part${++catalogPart}`,url));
for(const row of catalog.rows)cn.add(row.code);
fs.writeFileSync(path.join(dir,'catalog.json'),JSON.stringify(catalog,null,2));
let done=0,index=0;
async function worker(){
 while(index<targets.length){const item=targets[index++];const c=item.code;
 if(cn.has(c)){
  await get(c,'cnintro',`https://www.cnindex.com.cn/index-intro?indexcode=${c}`);
  const funds=await get(c,'cnfunds',`https://www.cnindex.com.cn/info/fund?indexCode=${c}&pageNum=1&rows=2000`);
  if(Array.isArray(funds?.data?.rows)&&funds.data.total>funds.data.rows.length)manifest[`${c}-cnfunds`].incomplete=true;
 }else{
  const official=csindexOfficialCode(c);
  await get(c,'csinfo',`https://www.csindex.com.cn/csindex-home/indexInfo/index-basic-info/${official}`);
  await get(c,'csfunds',`https://www.csindex.com.cn/csindex-home/index-list/queryByIndexCode/${official}?indexCode=${official}`);
  await get(c,'csdetails',`https://www.csindex.com.cn/csindex-home/indexInfo/index-details-data?fileLang=2&indexCode=${official}`);
  await get(c,'factsheet',`https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/${official}factsheet.pdf`,true);
 }
 done++;save();if(done%20===0)console.log(JSON.stringify({done,total:targets.length,ok:Object.values(manifest).filter(r=>r.status==='OK').length,failed:Object.values(manifest).filter(r=>r.status!=='OK').length}));
 }
}
await Promise.all([worker(),worker()]);save();console.log('collection complete',done);
