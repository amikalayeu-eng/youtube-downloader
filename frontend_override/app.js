'use strict';
const $=id=>document.getElementById(id);
const form=$('download-form'),urlInput=$('youtube-url'),downloadBtn=$('download-start');
const notice=$('notice'),progressCard=$('progress-card'),readyCard=$('ready-card'),qualityWrap=$('quality-wrap');
let analysisId='',jobId='',pollTimer=null,busy=false;

function event(name,extra={}){fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:name,...extra})}).catch(()=>{});}
function selected(name){return document.querySelector(`input[name="${name}"]:checked`)?.value||'';}
function showError(message){notice.textContent=message||'Something went wrong.';notice.hidden=false;}
function clearError(){notice.hidden=true;notice.textContent='';}
function setBusy(value){busy=value;downloadBtn.disabled=value;urlInput.disabled=value;document.querySelectorAll('.choice-radio').forEach(el=>el.disabled=value);downloadBtn.textContent=value?'Downloading…':'Download';}
function formatBytes(bytes){const n=Number(bytes)||0;if(n<1024*1024)return `${Math.max(0,n/1024).toFixed(0)} KB`;if(n<1024*1024*1024)return `${(n/1024/1024).toFixed(1)} MB`;return `${(n/1024/1024/1024).toFixed(2)} GB`;}
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data={};try{data=await r.json();}catch{}if(!r.ok)throw new Error(data.detail||data.error||`Request failed (${r.status})`);return data;}
function stopPoll(){if(pollTimer){clearTimeout(pollTimer);pollTimer=null;}}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function renderProgress(data){
  const status=data.status||'queued';
  $('state-label').textContent=status.replace(/(^|_)([a-z])/g,(_,a,b)=>`${a?' ':' '}${b.toUpperCase()}`).trim();
  $('stage-label').textContent=data.stage||({queued:'Waiting for a worker',analyzing:'Analyzing',downloading:'Downloading',processing:'Processing',validating:'Validating'}[status]||'Working');
  const raw=String(data.progress??'').trim(),pct=Number(raw),real=raw!==''&&Number.isFinite(pct)&&pct>=0&&pct<=100;
  $('progress-track').hidden=!real;
  $('progress-number').textContent=real?`${pct.toFixed(pct<10?1:0)}%`:'';
  $('progress-bar').style.width=real?`${pct}%`:'0%';
  $('queue-copy').textContent=status==='queued'?(data.queue_position?`Queue position ${data.queue_position}${data.queue_length?` of ${data.queue_length}`:''}`:'Waiting for available capacity'):'';
}

async function waitForAnalysis(id){
  for(;;){
    const data=await api(`/api/analyze/${encodeURIComponent(id)}`);
    if(data.status==='ready')return data;
    if(data.status==='failed'||data.status==='cancelled')throw new Error(data.error||'Could not analyze this video.');
    renderProgress({status:data.status||'analyzing',stage:data.stage||'Analyzing'});
    await sleep(1100);
  }
}

async function waitForJob(id){
  for(;;){
    const data=await api(`/api/jobs/${encodeURIComponent(id)}`);
    if(data.status==='ready')return data;
    if(data.status==='failed'||data.status==='cancelled')throw new Error(data.error||'The download failed.');
    renderProgress(data);
    await sleep(1300);
  }
}

function syncFormat(){qualityWrap.hidden=selected('format')!=='video';}
document.querySelectorAll('input[name="format"]').forEach(input=>input.addEventListener('change',syncFormat));
syncFormat();

form.addEventListener('submit',async e=>{
  e.preventDefault();
  if(busy)return;
  stopPoll();clearError();readyCard.hidden=true;
  const url=urlInput.value.trim();
  if(!url){showError('Paste a YouTube video URL first.');urlInput.focus();return;}
  const format=selected('format')||'mp3';
  const quality=format==='video'?(selected('quality')||'maximum'):'maximum';
  setBusy(true);progressCard.hidden=false;renderProgress({status:'analyzing',stage:'Analyzing'});event('download_start',{format,quality:format==='video'?quality:''});
  try{
    const analysis=await api('/api/analyze',{method:'POST',body:JSON.stringify({url})});
    analysisId=analysis.id;
    await waitForAnalysis(analysisId);
    renderProgress({status:'queued',stage:'Preparing download'});
    const job=await api('/api/jobs',{method:'POST',body:JSON.stringify({analysis_id:analysisId,format,quality})});
    jobId=job.id;
    const ready=await waitForJob(jobId);
    progressCard.hidden=true;
    $('ready-name').textContent=ready.file_name||'Your file is ready';
    $('ready-size').textContent=ready.output_size?formatBytes(ready.output_size):'';
    readyCard.hidden=false;
    const link=document.createElement('a');
    link.href=ready.download_url||`/api/jobs/${encodeURIComponent(jobId)}/file`;
    link.style.display='none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    event('download_file',{format,quality:format==='video'?quality:''});
    setBusy(false);
  }catch(err){
    progressCard.hidden=true;setBusy(false);showError(err.message);
  }
});
window.addEventListener('pagehide',()=>stopPoll());
event('visit');
