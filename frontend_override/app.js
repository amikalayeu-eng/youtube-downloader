(()=>{
  const $=id=>document.getElementById(id);
  const form=$('download-form');
  const urlInput=$('url');
  const downloadButton=$('download');
  const statusEl=$('status');
  const errorEl=$('error');
  const qualities=$('qualities');

  let selectedFormat='mp3';
  let selectedQuality='maximum';
  let busy=false;

  function clearMessage(){
    errorEl.hidden=true;
    errorEl.textContent='';
  }

  function showError(message){
    statusEl.hidden=true;
    statusEl.textContent='';
    errorEl.textContent=message || 'Ошибка.';
    errorEl.hidden=false;
  }

  function showStatus(message){
    clearMessage();
    statusEl.textContent=message || '';
    statusEl.hidden=!message;
  }

  function setBusy(value){
    busy=value;
    downloadButton.disabled=value;
    urlInput.disabled=value;
    document.querySelectorAll('.choice').forEach(el=>el.disabled=value);
    downloadButton.textContent=value?'Скачиваем...':'Скачать';
  }

  async function api(path, options={}){
    const response=await fetch(path,{
      credentials:'same-origin',
      headers:{'Content-Type':'application/json',...(options.headers||{})},
      ...options
    });
    let data={};
    try{ data=await response.json(); }catch(_){ }
    if(!response.ok){
      const detail=data.detail || data.error || `HTTP ${response.status}`;
      throw new Error(typeof detail==='string'?detail:'Ошибка запроса.');
    }
    return data;
  }

  function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

  async function pollAnalysis(id){
    for(;;){
      const data=await api(`/api/analysis/${encodeURIComponent(id)}`);
      if(data.status==='ready') return data;
      if(data.status==='failed'||data.status==='cancelled') throw new Error(data.error||'Не удалось обработать ссылку.');
      showStatus(data.stage||'Анализ...');
      await sleep(1200);
    }
  }

  async function pollJob(id){
    for(;;){
      const data=await api(`/api/jobs/${encodeURIComponent(id)}`);
      if(data.status==='ready') return data;
      if(data.status==='failed'||data.status==='cancelled') throw new Error(data.error||'Не удалось скачать файл.');
      showStatus(data.stage||'Скачивание...');
      await sleep(1400);
    }
  }

  document.querySelectorAll('[data-format]').forEach(button=>{
    button.addEventListener('click',()=>{
      if(busy) return;
      selectedFormat=button.dataset.format;
      document.querySelectorAll('[data-format]').forEach(el=>{
        const active=el===button;
        el.classList.toggle('selected',active);
        el.setAttribute('aria-checked',String(active));
      });
      qualities.hidden=selectedFormat!=='video';
    });
  });

  document.querySelectorAll('[data-quality]').forEach(button=>{
    button.addEventListener('click',()=>{
      if(busy) return;
      selectedQuality=button.dataset.quality;
      document.querySelectorAll('[data-quality]').forEach(el=>{
        const active=el===button;
        el.classList.toggle('selected',active);
        el.setAttribute('aria-checked',String(active));
      });
    });
  });

  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(busy) return;

    const url=urlInput.value.trim();
    if(!url){
      showError('Вставьте ссылку на YouTube.');
      urlInput.focus();
      return;
    }

    setBusy(true);
    showStatus('Анализ...');

    try{
      const analysisCreated=await api('/api/analyze',{
        method:'POST',
        body:JSON.stringify({url})
      });
      await pollAnalysis(analysisCreated.id);

      showStatus('Подготовка...');
      const jobCreated=await api('/api/jobs',{
        method:'POST',
        body:JSON.stringify({
          analysis_id:analysisCreated.id,
          format:selectedFormat,
          quality:selectedFormat==='video'?selectedQuality:'maximum'
        })
      });

      const ready=await pollJob(jobCreated.id);
      showStatus('Готово');

      const link=document.createElement('a');
      link.href=ready.download_url || `/api/jobs/${encodeURIComponent(jobCreated.id)}/file`;
      link.style.display='none';
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(()=>{
        setBusy(false);
        statusEl.hidden=true;
        statusEl.textContent='';
      },700);
    }catch(error){
      setBusy(false);
      showError(error.message);
    }
  });
})();
