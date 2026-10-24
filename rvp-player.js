/* Room Video Player — MIT */
(() => {
  'use strict';
  const C=window.RoomVideoCore, $=id=>document.getElementById(id), video=$('video');
  const channel=new URL(location.href).searchParams.get('channel') || 'main';
  function fit(){document.querySelector('main').style.transform='scale('+Math.min(innerWidth/1760,innerHeight/880)+')';}
  window.addEventListener('resize',fit);fit();
  let state=null, config=null, canControl=false, host=false, synced=false, volume=.8, muted=false, gain=1;
  let hls=null, loaded='', revision=-1, expected=0, anchor=performance.now(), grid=false, appliedVolume=false, lastUsers='', lastCanControl=null, lastHostFlag=null;
  const send=(type,data={})=>{if(window.O?.sendMessage) window.O.sendMessage('room-video',JSON.stringify({channel,type,...data}));};
  const command=data=>send('command',{command:data});
  const notify=text=>{$('notice').textContent=text;};
  const fmt=n=>{n=Math.max(0,Math.floor(n||0));return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');};
  const target=()=>expected+(state?.playing ? (performance.now()-anchor)/1000 : 0);
  const makeButton=(text,fn,enabled=canControl)=>{const b=document.createElement('button');b.textContent=text;b.disabled=!enabled;b.onclick=fn;return b;};
  function audio(){video.volume=C.clamp(volume*gain,0,1);video.muted=muted;$('mute').textContent=muted?'Unmute':'Mute';}
  function checkURL(url){return C.item({url},config.origins).url;}
  function release(){if(hls){hls.destroy();hls=null;}video.pause();video.removeAttribute('src');video.load();}
  function load(item){
    const url=checkURL(item.url); release();
    if(/\.m3u8(?:$|\?)/i.test(new URL(url).pathname)) {
      if(window.Hls?.isSupported()) {
        hls=new Hls({maxBufferLength:20,enableWorker:true,xhrSetup:xhr=>{xhr.withCredentials=false;},
          fetchSetup:(ctx,init)=>new Request(checkURL(ctx.url),{...init,credentials:'omit'}),
          // Every playlist, segment and encryption key must use a configured origin.
          loader:class extends Hls.DefaultConfig.loader {
            load(context,cfg,callbacks){try{checkURL(context.url);super.load(context,cfg,callbacks);}catch(err){callbacks.onError({code:0,text:err.message},context,null);}}
          }});
        hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal){notify('Stream failed: '+data.details);release();loaded='';}});
        hls.on(Hls.Events.MANIFEST_PARSED,()=>{quality();reconcile(true);});
        hls.loadSource(url);hls.attachMedia(video);
      } else if(video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS cannot enforce the segment host allowlist; fail closed instead.
        notify('Native HLS is disabled because its segment hosts cannot be checked. Use a direct MP4/WebM or a device supporting the bundled HLS engine.');loaded='';
      } else {notify('HLS is unsupported on this device. Use MP4/WebM.');loaded='';}
    } else {video.src=url;video.load();}
    audio();
  }
  function quality(){if(!hls)return;const wanted=Number(state?.quality);hls.currentLevel=Number.isFinite(wanted)?hls.levels.reduce((best,l,i)=>l.height<=wanted?i:best,-1):-1;}
  async function reconcile(force=false){
    if(!state || !config || !synced){video.pause();return;}
    const item=state.queue[state.index], selected=item || (config.idle?{url:config.idle,title:'Idle video'}:null);
    $('idle').hidden=!!selected;$('title').textContent=selected?.title || 'No video selected';
    if(!selected){if(loaded){release();loaded='';}return;}
    // Index/revision alone must not reload the same source on every heartbeat.
    const id=selected.url+'|'+(item?state.index:'idle');
    if(loaded!==id){try{loaded=id;load(selected);}catch(e){loaded='';notify(e.message);return;}}
    const shouldPlay=item?state.playing:true;
    video.loop=!item;
    if(video.readyState>=1 && item){
      if(item.live){
        const end=video.seekable.length?video.seekable.end(video.seekable.length-1)-3:0;
        if(end>0 && (force || Math.abs(video.currentTime-end)>config.tolerance+3)) video.currentTime=end;
      } else {
        const t=Number.isFinite(video.duration)?Math.min(target(),Math.max(0,video.duration-.05)):target();
        const drift=t-video.currentTime;
        if(force||Math.abs(drift)>config.tolerance)video.currentTime=Math.max(0,t);
        video.playbackRate=shouldPlay&&Math.abs(drift)>.2?C.clamp(1+drift*.03,.97,1.03):1;
      }
    }
    if(shouldPlay && video.paused && !video.ended){try{await video.play();$('unlock').hidden=true;}catch{$('unlock').hidden=false;notify('Press Enable playback once on this device.');}}
    else if(!shouldPlay)video.pause();
  }
  function renderQueue(){
    const root=$('queue');root.replaceChildren();root.className=grid?'grid':'';
    const query=$('filter').value.toLowerCase();
    state.queue.forEach((item,i)=>{
      if(!item.title.toLowerCase().includes(query))return;
      const row=document.createElement('article');row.className='item'+(i===state.index?' playing':'');
      const title=document.createElement('strong');title.textContent=`${i+1}. ${item.title}`;
      const info=document.createElement('small');info.textContent=item.live?'LIVE · shared live edge':new URL(item.url).hostname;
      const buttons=document.createElement('div');buttons.className='row';
      buttons.append(makeButton('Play',()=>command({action:'select',index:i})),makeButton('↑',()=>command({action:'move',index:i,to:i-1}),canControl&&i>0),makeButton('↓',()=>command({action:'move',index:i,to:i+1}),canControl&&i<state.queue.length-1),makeButton('✕',()=>command({action:'remove',index:i})));
      row.append(title,info,buttons);root.append(row);
    });
    if(!state.queue.length)root.textContent='Your queue is empty. Open Add / Search to add media.';
  }
  function renderLists(){
    const root=$('lists');root.replaceChildren();
    state.lists.forEach((list,i)=>{
      const row=document.createElement('article');row.className='item';const name=document.createElement('strong');name.textContent=list.name+' · '+list.items.length;
      const actions=document.createElement('div');actions.className='row';actions.append(makeButton('Play all',()=>command({action:'load-list',index:i})),makeButton('Append',()=>command({action:'load-list',index:i,append:true})),makeButton('Delete',()=>command({action:'delete-list',index:i})));
      row.append(name,actions);root.append(row);
    });
    if(!state.lists.length)root.textContent='Use Save queue to create a saved list.';
  }
  function render(message){
    state=message.state;config=message.config;host=message.host;canControl=message.canControl;synced=message.synced;
    if(!state)return;
    expected=message.position;anchor=performance.now();
    if(!appliedVolume){volume=config.volume/100;muted=config.muted;$('volume').value=config.volume;appliedVolume=true;audio();}
    $('sync').textContent=synced?(host?'Host · synced':'Following host · synced'):'Waiting for host clock…';
    $('host').textContent='Host: '+(message.users.find(u=>u.uid===state.host)?.name || state.host);
    $('count').textContent=state.queue.length;$('loop').classList.toggle('active',state.loop);$('loop').textContent=state.loop?'Loop on':'Loop off';
    $('quality').value=state.quality;$('permissions').textContent=config.modsOnly?'Moderator writes are protected by the server.':(state.locked?'Only the host can control playback.':'Everyone in the room can control playback.');
    $('lock').textContent=state.locked?'Unlock controls':'Lock controls';$('lock').disabled=!host||config.locked;
    document.querySelectorAll('[data-action]').forEach(b=>b.disabled=!canControl);
    ['seek','quality','save','add','play-now','import-button'].forEach(id=>$(id).disabled=!canControl);
    document.querySelector('.transport').hidden=!config.controls;
    const roster=JSON.stringify(message.users);
    if(roster!==lastUsers || revision!==state.revision || lastCanControl!==canControl || lastHostFlag!==host){
      renderQueue();renderLists();$('users').replaceChildren();
      message.users.forEach(u=>{$('users').append(makeButton(u.name+(u.uid===state.host?' · host':' → Make host'),()=>command({action:'transfer',uid:u.uid}),host&&u.uid!==state.host));});
      lastUsers=roster;revision=state.revision;lastCanControl=canControl;lastHostFlag=host;
    }
    quality();reconcile();
  }
  window.addEventListener('bsmessage',e=>{
    let m;try{m=JSON.parse(e.detail.message);}catch{return;}if(m.channel!==channel)return;
    if(m.type==='state')render(m);
    else if(m.type==='clock' && state && m.revision===state.revision){expected=m.position;anchor=performance.now();synced=m.synced;reconcile();}
    else if(m.type==='gain'){gain=C.clamp(m.gain,0,1);audio();}
    else if(m.type==='notice')notify(m.text);
  });
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>command({action:b.dataset.action}));
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.tab').forEach(t=>t.hidden=t.id!==b.dataset.tab+'-tab');
    document.querySelectorAll('[data-tab]').forEach(t=>t.classList.toggle('selected',t===b));
  });
  $('loop').onclick=()=>command({action:'loop',value:!state?.loop});
  $('lock').onclick=()=>command({action:'lock',value:!state?.locked});
  $('quality').onchange=()=>command({action:'quality',value:$('quality').value});
  $('seek').onchange=()=>{if(Number.isFinite(video.duration))command({action:'seek',position:video.duration*Number($('seek').value)/1000});};
  $('volume').oninput=()=>{volume=Number($('volume').value)/100;audio();};
  $('mute').onclick=()=>{muted=!muted;audio();};
  $('unlock').onclick=async()=>{try{await video.play();$('unlock').hidden=true;reconcile(true);}catch(e){notify(e.message);}};
  $('toggle-panel').onclick=()=>{$('panel').style.visibility=$('panel').style.visibility==='hidden'?'visible':'hidden';};
  $('view').onclick=()=>{grid=!grid;$('view').textContent=grid?'List view':'Grid view';renderQueue();};
  $('filter').oninput=()=>state&&renderQueue();
  $('save').onclick=()=>command({action:'save-list',name:'Saved list '+(state.lists.length+1)});
  function add(play){try{const item=C.item({url:$('url').value,title:$('new-title').value,live:$('live').checked},config.origins);command({action:'add',item,play});}catch(e){notify(e.message);}}
  $('add').onclick=()=>add(false);$('play-now').onclick=()=>add(true);
  $('import-button').onclick=()=>{try{
    const text=$('import').value.trim();let raw=text.startsWith('[')?JSON.parse(text):text.split(/\r?\n/).filter(Boolean).map(url=>({url}));
    if(!Array.isArray(raw)||!raw.length||raw.length>config.maxItems)throw Error('Import a nonempty list within the item limit.');
    const items=raw.map(x=>C.item(x,config.origins));
    // One-shots are limited to ~4 KB. Large imports must be split into small batches.
    const batches=[];let batch=[];
    for(const item of items){if(new TextEncoder().encode(JSON.stringify([...batch,item])).length>2800){if(!batch.length)throw Error('A media URL is too long.');batches.push(batch);batch=[];}batch.push(item);}if(batch.length)batches.push(batch);
    batches.forEach((items,i)=>setTimeout(()=>command({action:'add',items}),i*700));notify('Import sent; watch the queue for accepted items.');
  }catch(e){notify(e.message);}};
  $('export').onclick=()=>{$('export-text').hidden=false;$('export-text').value=JSON.stringify(state.queue,null,2);};
  video.addEventListener('loadedmetadata',()=>reconcile(true));
  video.addEventListener('ended',()=>{if(host && state?.queue[state.index])send('ended',{revision:state.revision});});
  video.addEventListener('error',()=>notify('Media could not load. Check HTTPS access, CORS, codec, URL expiry and server range support.'));
  setInterval(()=>{
    $('elapsed').textContent=fmt(video.currentTime);$('duration').textContent=!loaded?'0:00':(Number.isFinite(video.duration)?fmt(video.duration):(state?.queue[state.index]?.live?'LIVE':'—'));
    if(document.activeElement!==$('seek'))$('seek').value=Number.isFinite(video.duration)&&video.duration?1000*video.currentTime/video.duration:0;
    $('seek').disabled=!canControl || !!state?.queue[state.index]?.live || !Number.isFinite(video.duration);
  },500);
  setInterval(()=>send('ready'),2000);send('ready');
})();
