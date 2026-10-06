// No fake percentage: only real transfer progress is shown.
'use strict';
const $=id=>document.getElementById(id);
const form=$('download-form'),urlInput=$('youtube-url'),downloadBtn=$('download-start'),stopBtn=$('stop-download');
const notice=$('notice'),progressCard=$('progress-card'),readyCard=$('ready-card'),qualityWrap=$('quality-wrap');
let jobId='',busy=false,cancelledByUser=false,saveDirectory=null;

function event(name,extra={}){fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:name,...extra})}).catch(()=>{});}
function selected(name){return document.querySelector(`input[name="${name}"]:checked`)?.value||'';}
function showError(message){notice.textContent=message||'Something went wrong.';notice.hidden=false;}
function clearError(){notice.hidden=true;notice.textContent='';}
function formatBytes(bytes){const n=Number(bytes)||0;if(n<1024*1024)return `${Math.max(0,n/1024).toFixed(0)} KB`;if(n<1024*1024*1024)return `${(n/1024/1024).toFixed(1)} MB`;return `${(n/1024/1024/1024).toFixed(2)} GB`;}
function setBusy(value){busy=value;downloadBtn.disabled=value;urlInput.disabled=value;document.querySelectorAll('.choice-radio').forEach(el=>el.disabled=value);downloadBtn.textContent=value?'Downloading…':'Download';stopBtn.hidden=!value;}
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data={};try{data=await r.json();}catch{}if(!r.ok)throw new Error(data.detail||data.error||`Request failed (${r.status})`);return data;}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function renderProgress(data){
  const status=data.status||'queued';
  const raw=String(data.progress??'').trim(),pct=Number(raw),real=raw!==''&&Number.isFinite(pct)&&pct>=0&&pct<=100;
  $('state-label').textContent=real?'Downloading':(status==='queued'?'Queued':'Preparing');
  $('stage-label').textContent=real?'Downloading':(status==='queued'?'Waiting for a worker':'Preparing download');
  $('progress-track').hidden=!real;
  $('progress-number').textContent=real?`${pct.toFixed(pct<10?1:0)}%`:'';
  $('progress-bar').style.width=real?`${pct}%`:'0%';
  $('queue-copy').textContent=status==='queued'&&data.queue_position?`Queue position ${data.queue_position}${data.queue_length?` of ${data.queue_length}`:''}`:'';
}

async function waitForJob(id){
  for(;;){
    if(cancelledByUser)throw new Error('Download cancelled.');
    const data=await api(`/api/jobs/${encodeURIComponent(id)}`);
    if(data.status==='ready')return data;
    if(data.status==='failed')throw new Error(data.error||'The download failed.');
    if(data.status==='cancelled')throw new Error('Download cancelled.');
    renderProgress(data);
    await sleep(900);
  }
}

async function chooseDirectoryIfSupported(){
  if(!('showDirectoryPicker' in window))return null;
  try{return await window.showDirectoryPicker({mode:'readwrite'});}catch(err){if(err&&err.name==='AbortError')return false;throw err;}
}

async function saveToChosenDirectory(ready){
  const response=await fetch(`/api/jobs/${encodeURIComponent(jobId)}/stream`,{credentials:'same-origin'});
  if(!response.ok)throw new Error(`Could not save the file (${response.status}).`);
  const fileHandle=await saveDirectory.getFileHandle(ready.file_name||'download',{create:true});
  const writable=await fileHandle.createWritable();
  try{
    if(response.body&&response.body.getReader){
      const reader=response.body.getReader();
      let received=0,total=Number(response.headers.get('content-length')||ready.output_size||0);
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        await writable.write(value);
        received+=value.byteLength;
        if(total>0){const pct=Math.min(100,received/total*100);$('state-label').textContent='Saving';$('stage-label').textContent='Saving to computer';$('progress-track').hidden=false;$('progress-number').textContent=`${pct.toFixed(0)}%`;$('progress-bar').style.width=`${pct}%`;}
      }
    }else{
      await writable.write(await response.blob());
    }
    await writable.close();
  }catch(err){try{await writable.abort();}catch{}throw err;}
}

function startNativeDownload(){
  const frame=document.createElement('iframe');
  frame.hidden=true;
  frame.src=`/api/jobs/${encodeURIComponent(jobId)}/file?download=1&t=${Date.now()}`;
  document.body.appendChild(frame);
  setTimeout(()=>frame.remove(),60000);
}

function syncFormat(){qualityWrap.hidden=selected('format')!=='video';}
document.querySelectorAll('input[name="format"]').forEach(input=>input.addEventListener('change',syncFormat));
syncFormat();stopBtn.hidden=true;

stopBtn.addEventListener('click',async()=>{
  if(!busy)return;
  cancelledByUser=true;stopBtn.disabled=true;
  try{if(jobId)await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`,{method:'POST',body:'{}'});}catch{}
  progressCard.hidden=true;readyCard.hidden=true;setBusy(false);stopBtn.disabled=false;showError('Download cancelled.');
});

form.addEventListener('submit',async e=>{
  e.preventDefault();
  if(busy)return;
  clearError();readyCard.hidden=true;cancelledByUser=false;jobId='';
  const url=urlInput.value.trim();
  if(!url){showError('Paste a YouTube video URL first.');urlInput.focus();return;}
  const format=selected('format')||'mp3';
  const quality=format==='video'?(selected('quality')||'maximum'):'maximum';

  let picked=null;
  try{picked=await chooseDirectoryIfSupported();}catch(err){showError(err.message);return;}
  if(picked===false)return;
  saveDirectory=picked;

  setBusy(true);progressCard.hidden=false;renderProgress({status:'queued'});event('download_start',{format,quality:format==='video'?quality:''});
  try{
    const job=await api('/api/download',{method:'POST',body:JSON.stringify({url,format,quality})});
    jobId=job.id;
    const ready=await waitForJob(jobId);
    if(cancelledByUser)return;
    if(saveDirectory)await saveToChosenDirectory(ready);else startNativeDownload();
    progressCard.hidden=true;
    $('ready-name').textContent=ready.file_name||'Your file is ready';
    $('ready-size').textContent=ready.output_size?formatBytes(ready.output_size):'';
    readyCard.hidden=false;
    event('download_file',{format,quality:format==='video'?quality:''});
    setBusy(false);
  }catch(err){
    if(cancelledByUser)return;
    progressCard.hidden=true;setBusy(false);showError(err.message);
  }
});
event('visit');
