import { getStore } from '@netlify/blobs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
export const config = { path: '/api/*' };
const j=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const text=(s,n=200)=>String(s??'').trim().slice(0,n);
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return y.length>0&&x.length===y.length&&timingSafeEqual(x,y)};
const slug=s=>text(s,100).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,30)||'main';
const failure=(error,status=400)=>({error,status});
const initial=()=>({v:randomUUID(),generation:randomUUID(),people:[],got:{},events:[],audit:[],ops:{},label:'',note:'',archived:false});
const own=(o,k)=>Object.hasOwn(o,k);
const K=b=>encodeURIComponent(b); // prefix prevents special object property names
const rk=b=>'b:'+K(b);
const lookup=(s,b)=>s.people.find(p=>p.barcode===b||p.was===b);
const received=(s,b)=>s.got[rk(b)];
const keyOf=p=>p.barcode||p.id;
function audit(s,action,d,detail){s.audit.push({t:Date.now(),action,d,detail});if(s.audit.length>3000)s.audit.shift()}
export function mutate(s,route,b,device,role){
  const bc=text(b.barcode), now=Date.now(), t=Math.min(now,Math.max(1,Number(b.t)||now));
  if(s.archived&&!['restore'].includes(route))return failure('Event is archived; restore it first',409);
  if(route==='scan'){
    if(b.generation!==s.generation)return failure('Event changed since this scan was queued',409);
    const p=lookup(s,bc);if(!bc||!p||p.absent){if(bc)s.events.push({t,type:'u',d:device,b:bc});return {status:p?.absent?'absent':'unknown'}}
    const cur=p.barcode,via=cur!==bc?cur:undefined,old=received(s,cur);
    if(old){s.events.push({t,type:'d',d:device,b:bc});return {status:'dup',name:p.name,received_at:old.t,device:old.d,via}}
    s.got[rk(cur)]={t,d:device};return {status:'ok',name:p.name,received_at:t,device,via};
  }
  if(role!=='admin')return failure('Administrator access required',403);
  if(route==='upload'){
    const seen=new Set(), incoming=[];for(const p of Array.isArray(b.people)?b.people:[]){const name=text(p.name,100),barcode=text(p.barcode);if(!name)continue;if(barcode&&seen.has(barcode))return failure('Duplicate barcode: '+barcode);if(barcode)seen.add(barcode);incoming.push({name,barcode,id:randomUUID()})}
    if(!incoming.length||incoming.length>5000)return failure('Namelist must have 1 to 5000 rows');
    if(b.merge){for(const p of incoming){const old=p.barcode?lookup(s,p.barcode):s.people.find(x=>!x.barcode&&x.name.toLowerCase()===p.name.toLowerCase());if(old){if(old.barcode!==p.barcode)return failure('Barcode already registered as an original barcode: '+p.barcode,409);old.name=p.name}else s.people.push(p)}}
    else {s.people=incoming;s.got={};s.events=[];s.generation=randomUUID();s.ops={}}
    if(s.people.length>5000)return failure('Maximum 5000 participants');s.label=text(b.label,60)||s.label;s.note=b.note===undefined?s.note:text(b.note);s.people.sort((a,b)=>a.name.localeCompare(b.name));audit(s,route,device,b.merge?'Merge namelist':'Replace namelist');return {ok:true,count:s.people.length};
  }
  if(route==='assign'){
    if(!bc)return failure('Missing barcode');if(lookup(s,bc))return failure('Barcode already belongs to another person',409);
    let p,old; if(b.newName){const name=text(b.newName,100);if(!name||s.people.length>=5000)return failure('Invalid name or list full');p={name,barcode:bc,id:randomUUID(),reg:1,add:1};s.people.push(p)}
    else {p=s.people.find(x=>b.from?x.barcode===b.from:x.id===b.id&&!x.barcode);if(!p||p.absent)return failure('Participant changed or unavailable',409);if(p.barcode){old=received(s,p.barcode);delete s.got[rk(p.barcode)];p.was=p.was||p.barcode}p.barcode=bc;p.reg=1}
    if(old||b.markReceived)s.got[rk(bc)]=old||{t,d:device};s.people.sort((a,b)=>a.name.localeCompare(b.name));audit(s,route,device,bc);return {ok:true,name:p.name,received:!!received(s,bc)};
  }
  if(route==='unassign'){const p=s.people.find(x=>x.barcode===bc&&x.reg);if(!p)return failure('Barcode cannot be unlinked',409);delete s.got[rk(bc)];if(p.add)s.people=s.people.filter(x=>x!==p);else{p.barcode=p.was||'';delete p.was;delete p.reg}audit(s,route,device,bc);return {ok:true}}
  if(route==='undo'){delete s.got[rk(bc)];audit(s,route,device,bc);return {ok:true}}
  if(route==='remove'||route==='attend'){const set=new Set([].concat(b.barcodes||b.barcode||[]).map(String));for(const p of s.people){if(set.has(keyOf(p))){if(route==='remove'&&received(s,p.barcode))return failure('Participant already received; refresh first',409);p.absent=route==='remove'}}audit(s,route,device,set.size+' participants');return {ok:true}}
  if(route==='note'){s.note=text(b.note);s.label=s.label||text(b.label,60);audit(s,route,device,'Updated remark');return {ok:true}}
  if(route==='archive'||route==='restore'){s.archived=route==='archive';audit(s,route,device,'Event '+route);return {ok:true}}
  if(route==='clear'){const oldAudit=s.audit;Object.assign(s,initial(),{audit:oldAudit});audit(s,route,device,'Cleared event');return {ok:true}}
  return failure('Not found',404);
}
export default async(req)=>{
  try{
    const access=Netlify.env.get('ACCESS_CODE'),staff=Netlify.env.get('STAFF_CODE'),code=req.headers.get('x-code');const role=equal(code,access)?'admin':equal(code,staff)?'staff':null;
    if(!role)return j({error:'Wrong access code'},401);
    const url=new URL(req.url),route=url.pathname.replace(/^\/api\//,''),L=slug(decodeURIComponent(req.headers.get('x-list')||'main'));
    const store=getStore({name:'tally-v2',consistency:'strong'}),meta=getStore({name:'meta',consistency:'strong'}),NL=L==='main'?'namelist':'namelist-'+L;
    const load=async()=>{let entry=await store.getWithMetadata(L,{type:'json'});if(entry)return entry;
      const s=initial(),nl=await meta.get(NL,{type:'json'});if(nl){s.people=nl.people.map(p=>({...p,id:p.id||randomUUID()}));s.label=nl.label||'';s.note=nl.note||'';const rec=getStore({name:L==='main'?'received':'rec-'+L,consistency:'strong'}),ev=getStore({name:L==='main'?'events':'ev-'+L,consistency:'strong'});const {blobs}=await rec.list();for(const chunk of Array.from({length:Math.ceil(blobs.length/30)},(_,i)=>blobs.slice(i*30,i*30+30)))await Promise.all(chunk.map(async b=>{const v=await rec.get(b.key,{type:'json'});if(v)s.got[rk(decodeURIComponent(b.key))]=v}));const es=await ev.list();s.events=es.blobs.map(b=>{const [t,type,d,...bc]=decodeURIComponent(b.key).split('|');return {t:+t,type,d,b:bc.join('|')}})}
      await store.setJSON(L,s,{onlyIfNew:true});entry=await store.getWithMetadata(L,{type:'json'});if(!entry)throw Error('Initialization failed');return entry};
    if(route==='batches'&&req.method==='GET'){const [a,b]=await Promise.all([store.list(),meta.list({prefix:'namelist'})]);const names=new Set([...a.blobs.map(x=>x.key),...b.blobs.map(x=>x.key==='namelist'?'main':x.key.replace(/^namelist-/,''))]);const batches=await Promise.all([...names].map(async name=>{const s=await store.get(name,{type:'json'})||await meta.get(name==='main'?'namelist':'namelist-'+name,{type:'json'});return {name,label:s?.label||'',note:s?.note||'',count:s?.people?.length||0,archived:!!s?.archived}}));return j({batches,role})}
    if(req.method==='GET'){const {data:s}=await load();if(route==='list'){const same=url.searchParams.get('v')===s.v;return j({role,v:s.v,generation:s.generation,label:s.label,note:s.note,archived:s.archived,people:same?undefined:s.people,got:same?undefined:s.people.filter(p=>received(s,p.barcode)).map(p=>p.barcode),details:same?undefined:Object.fromEntries(s.people.filter(p=>received(s,p.barcode)).map(p=>[p.barcode,received(s,p.barcode)])),events:same?undefined:s.events.slice(-2000),audit:role==='admin'?s.audit.slice(-100):[]})}if(route==='details')return j(Object.fromEntries(s.people.filter(p=>received(s,p.barcode)).map(p=>[p.barcode,received(s,p.barcode)])));if(route==='stats')return j({events:s.events});return j({error:'Not found'},404)}
    if(req.method!=='POST')return j({error:'Method not allowed'},405);
    const b=await req.json(),device=text(b.device,40).replace(/\|/g,''),op=text(b.op,100);
    for(let i=0;i<8;i++){const {data:s,etag}=await load();if(!etag)return j({error:'Storage version unavailable'},503);if(op&&own(s.ops,'o:'+op))return j(s.ops['o:'+op]);const result=mutate(s,route,b,device,role);if(result.error)return j({error:result.error},result.status);if(s.events.length>10000)s.events=s.events.slice(-10000);if(op){s.ops['o:'+op]=result;const keys=Object.keys(s.ops);if(keys.length>10000)delete s.ops[keys[0]]}s.v=randomUUID();const written=await store.setJSON(L,s,{onlyIfMatch:etag});if(written.modified)return j(result);await new Promise(r=>setTimeout(r,15+i*15))}return j({error:'Busy: retry without discarding the scan'},503);
  }catch(e){console.error('Tally API failure',e?.name);return j({error:'Service unavailable; retry'},503)}
};
