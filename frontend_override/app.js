'use strict';
const $=id=>document.getElementById(id);
const form=$('download-form'),urlInput=$('youtube-url'),downloadBtn=$('download-start'),stopBtn=$('stop-download');
const notice=$('notice'),progressCard=$('progress-card'),readyCard=$('ready-card'),qualityWrap=$('quality-wrap');
let jobId='',busy=false,cancelledByUser=false,saveDirectory=null,readyData=null;
let visualStage='',visualPct=0;

function event(name,extra={}){fetch('/api/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:name,...extra})}).catch(()=>{});}
function selected(name){return document.querySelector(`input[name="${name}"]:checked`)?.value||'';}
function showError(message){notice.textContent=message||'Something went wrong.';notice.hidden=false;}
function clearError(){notice.hidden=true;notice.textContent='';}
function formatBytes(bytes){const n=Number(bytes)||0;if(n<1024*1024)return `${Math.max(0,n/1024).toFixed(0)} KB`;if(n<1024*1024*1024)return `${(n/1024/1024).toFixed(1)} MB`;return `${(n/1024/1024/1024).toFixed(2)} GB`;}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

function setButtonState(){
  downloadBtn.classList.toggle('save-ready',Boolean(readyData)&&!busy);
  if(busy){downloadBtn.disabled=true;downloadBtn.textContent='Downloading…';stopBtn.hidden=false;return;}
  stopBtn.hidden=true;
  downloadBtn.disabled=false;
  downloadBtn.textContent=readyData?'Save file':'Download';
}
function setBusy(value){
  busy=value;
  urlInput.disabled=value;
  document.querySelectorAll('.choice-radio').forEach(el=>el.disabled=value);
  setButtonState();
}
function resetReady(){
  if(busy)return;
  readyData=null;jobId='';readyCard.hidden=true;saveDirectory=null;setButtonState();
}
async function api(path,options={}){const r=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let data={};try{data=await r.json();}catch{}if(!r.ok)throw new Error(data.detail||data.error||`Request failed (${r.status})`);return data;}

function setVisualProgress(label,pct){
  const n=Math.max(1,Math.min(100,Number(pct)||1));
  $('state-label').textContent=label;
  $('stage-label').textContent=label;
  $('progress-track').hidden=false;
  $('progress-number').textContent=`${n<10?n.toFixed(0):Math.round(n)}%`;
  $('progress-bar').style.width=`${n}%`;
}
function stagePercent(key,real,step){
  if(visualStage!==key){visualStage=key;visualPct=1;}
  if(real!==null){visualPct=Math.max(1,Math.min(100,real));}
  else visualPct=Math.min(95,visualPct+step);
  return visualPct;
}
function renderProgress(data){
  const status=String(data.status||'queued');
  const stage=String(data.stage||'');
  const raw=String(data.progress??'').trim();
  const parsed=Number(raw);
  const real=raw!==''&&Number.isFinite(parsed)&&parsed>=0&&parsed<=100?parsed:null;
  let label='Finishing',pct=1,key='finishing';

  if(status==='queued'||stage==='Preparing'){
    label='Starting';key='starting';pct=stagePercent(key,null,7);
  }else if(stage==='Saving'){
    label='Saving';key='saving';pct=99;visualStage=key;visualPct=pct;
  }else if(status==='downloading'||stage.toLowerCase().includes('downloading')){
    label='Downloading';key='downloading';pct=stagePercent(key,real,5);
  }else{
    label='Finishing';key='finishing';pct=stagePercent(key,real,4);
    if(status==='validating'&&real===null)pct=Math.max(pct,98);
  }
  setVisualProgress(label,pct);
  $('queue-copy').textContent=status==='queued'&&data.queue_position?`Queue position ${data.queue_position}${data.queue_length?` of ${data.queue_length}`:''}`:'';
}

async function waitForJob(id){
  for(;;){
    if(cancelledByUser)throw new Error('Download cancelled.');
    const data=await api(`/api/jobs/${encodeURIComponent(id)}`);
    if(data.status==='ready'){setVisualProgress('Ready',100);return data;}
    if(data.status==='failed')throw new Error(data.error||'The download failed.');
    if(data.status==='cancelled')throw new Error('Download cancelled.');
    renderProgress(data);
    await sleep(700);
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
        if(total>0){const pct=Math.min(100,received/total*100);setVisualProgress('Saving',pct);}
      }
    }else await writable.write(await response.blob());
    await writable.close();
  }catch(err){try{await writable.abort();}catch{}throw err;}
}
function downloadUrl(){return `/api/jobs/${encodeURIComponent(jobId)}/stream?download=1&t=${Date.now()}`;}
function startNativeDownload(ready){
  const link=document.createElement('a');
  link.href=downloadUrl();
  link.download=ready?.file_name||'download';
  link.style.display='none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
async function saveReadyFile(){
  if(!readyData||!jobId)return;
  clearError();
  downloadBtn.disabled=true;downloadBtn.textContent='Saving…';downloadBtn.classList.add('save-ready');
  try{
    if(saveDirectory)await saveToChosenDirectory(readyData);else startNativeDownload(readyData);
    event('download_file',{format:selected('format')||'',quality:selected('format')==='video'?(selected('quality')||'maximum'):''});
  }catch(err){showError(err.message);}
  finally{setTimeout(()=>{downloadBtn.disabled=false;downloadBtn.textContent='Save file';downloadBtn.classList.add('save-ready');},250);}
}

function syncFormat(){qualityWrap.hidden=selected('format')!=='video';resetReady();}
document.querySelectorAll('input[name="format"]').forEach(input=>input.addEventListener('change',syncFormat));
document.querySelectorAll('input[name="quality"]').forEach(input=>input.addEventListener('change',resetReady));
urlInput.addEventListener('input',resetReady);
qualityWrap.hidden=selected('format')!=='video';stopBtn.hidden=true;

stopBtn.addEventListener('click',async()=>{
  if(!busy)return;
  cancelledByUser=true;stopBtn.disabled=true;
  try{if(jobId)await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`,{method:'POST',body:'{}'});}catch{}
  progressCard.hidden=true;readyCard.hidden=true;readyData=null;setBusy(false);stopBtn.disabled=false;showError('Download cancelled.');
});

form.addEventListener('submit',async e=>{
  e.preventDefault();
  if(readyData&&!busy){await saveReadyFile();return;}
  if(busy)return;
  clearError();readyCard.hidden=true;cancelledByUser=false;jobId='';readyData=null;visualStage='';visualPct=0;
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
    const job=await api('/api/fast-download',{method:'POST',body:JSON.stringify({url,format,quality})});
    jobId=job.id;
    const ready=await waitForJob(jobId);
    if(cancelledByUser)return;
    readyData=ready;
    progressCard.hidden=true;
    $('ready-name').textContent=ready.file_name||'Your file is ready';
    $('ready-size').textContent=ready.output_size?formatBytes(ready.output_size):'';
    readyCard.hidden=false;
    setBusy(false);
    downloadBtn.focus({preventScroll:true});
  }catch(err){
    if(cancelledByUser)return;
    progressCard.hidden=true;readyData=null;setBusy(false);showError(err.message);
  }
});
event('visit');
