const fs=require('fs'), path=require('path');
const dataDir=path.join('frontend','public','data');
const paperDir=path.join(dataDir,'paper');
const idx=JSON.parse(fs.readFileSync(path.join(dataDir,'index.json'),'utf8'));
const meta={generated_at:null, papers:{}, cet_issues:[]};
// seed issues
try{
  const seed=JSON.parse(fs.readFileSync('seed/import-report.json','utf8'));
  meta.generated_at=seed.generated_at||null;
  for(const it of seed.issues||[]) meta.cet_issues.push(it);
}catch(e){ console.error('seed report skip',e.message); }
const OBJ=new Set(['listening','cloze','matching','reading1','reading2']);
const CHECK_SECTIONS=['cloze','reading1','matching'];
for(const p of idx.papers){
  const fp=path.join(paperDir, encodeURIComponent(p.paper_key)+'.json');
  let j;
  try{ j=JSON.parse(fs.readFileSync(fp,'utf8')); }catch(e){ console.error('MISS',p.paper_key,e.message); meta.papers[p.paper_key]={exam_type:p.exam_type,qcounts:{},has_model_essay:false,has_reference_translation:false}; continue; }
  const qcounts={};
  const checkStatus={}; // for kaoyan
  for(const q of j.questions||[]){
    const sec=q.section;
    const c=qcounts[sec]||(qcounts[sec]={n:0,answers:0});
    c.n++; if(q.answer!==null&&q.answer!==undefined) c.answers++;
    if(CHECK_SECTIONS.includes(sec)){
      const st=q.manual_locked?'manual':'source_only';
      checkStatus[st]=(checkStatus[st]||0)+1;
    }
  }
  let hasEssay=false, hasRef=false;
  for(const sm of j.section_materials||[]){
    let c=sm.content_json||{};
    if(typeof c==='string'){ try{c=JSON.parse(c);}catch{ c={}; } }
    if(sm.section==='writing' && c && c.model_essay) hasEssay=true;
    if(sm.section==='translation' && c && c.reference_translation) hasRef=true;
  }
  const rec={exam_type:p.exam_type, qcounts, has_model_essay:hasEssay, has_reference_translation:hasRef};
  if(p.exam_type==='kaoyan') rec.answer_check_counts=checkStatus;
  meta.papers[p.paper_key]=rec;
}
fs.writeFileSync(path.join(dataDir,'meta.json'), JSON.stringify(meta));
const sz=fs.statSync(path.join(dataDir,'meta.json')).size;
console.log('meta.json bytes', sz, 'papers', Object.keys(meta.papers).length, 'cet_issues', meta.cet_issues.length, 'generated_at', meta.generated_at);
// sanity
console.log('sample 2023-06-1', JSON.stringify(meta.papers['2023-06-1']));
console.log('sample 2024-kaoyan-1', JSON.stringify(meta.papers['2024-kaoyan-1']));
