/* Room Video Player — MIT */
(() => {
  'use strict';
  if (window.__roomVideoLoaded) return;
  window.__roomVideoLoaded = true;
  const base = new URL('.', document.currentScript.src);
  const load = path => new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = new URL(path, base).href;
    script.onload = resolve; script.onerror = () => reject(Error('Cannot load ' + script.src)); document.head.append(script);
  });
  load('rvp-core.js').then(() => window.addEventListener('bs-loaded', () => {
    const scene = BS.Scene.GetInstance();
    scene.On('unity-loaded', () => {
      document.querySelectorAll('bs-snippet[name="room-video-player"]').forEach(el => {
        if (el.dataset.roomVideoStarted) return; el.dataset.roomVideoStarted = 'true';
        start(el, scene).catch(e => console.error('[RoomVideo]', e));
      });
    });
  })).catch(console.error);

  async function start(el, scene) {
    const C = window.RoomVideoCore;
    const attr = (key, fallback = '') => el.getAttribute(key) || fallback;
    const flag = (key, fallback = false) => attr(key, String(fallback)) === 'true';
    const triple = key => {
      const v = attr(key, key === 'position' ? '0 1.5 0' : '0 0 0').split(/\s+/).map(Number);
      if (v.length !== 3 || v.some(x => !Number.isFinite(x))) throw Error('Invalid ' + key); return v;
    };
    const config = { origins: C.origins(attr('media-origins')), maxItems: C.clamp(attr('max-items', '100'), 1, 100),
      autoplay: flag('autoplay', true), loop: flag('loop', true), locked: flag('locked'), modsOnly: flag('mods-only'),
      pinnedHost: attr('host-uid'), idle: attr('idle-video'), tolerance: C.clamp(attr('sync-tolerance', '1.5'), .3, 10) };
    const channel = attr('channel', 'main');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(channel)) throw Error('channel must be 1–40 letters, numbers, underscores or hyphens.');
    const key = 'roomVideo_' + channel;
    if (!window.__roomVideoChannels) window.__roomVideoChannels = new Set();
    if (window.__roomVideoChannels.has(channel)) throw Error('Duplicate player channel: ' + channel);
    window.__roomVideoChannels.add(channel);
    const position = triple('position'), rotation = triple('rotation');
    const width = C.clamp(attr('width', '1.6'), .2, 50), screenPixels = 1280, panelPixels = 480, pageHeight = 880;
    // A single browser keeps the playlist to the viewer's right at every screen rotation.
    // Shift its centre right by half the sidebar width, leaving position at the video centre.
    const q = eulerQuaternion(rotation);
    const localRight = rotate(q, {x:1, y:0, z:0}); // viewer at -Z sees local +X on the right
    const offset = panelPixels / screenPixels * width / 2;
    const centre = position.map((x, i) => x + [localRight.x, localRight.y, localRight.z][i] * offset);
    // Video is above the control bar; offset panel down so position is the video centre.
    const up = rotate(q, {x:0,y:1,z:0});
    const down = (pageHeight - 720) / screenPixels * width / 2;
    const object = new BS.GameObject({name:'RoomVideo:' + channel, localPosition: new BS.Vector3(...centre.map((x,i) => x - [up.x,up.y,up.z][i]*down)),
      localEulerAngles: new BS.Vector3(...rotation), localScale: new BS.Vector3(...Array(3).fill(width * 1300 / screenPixels))});
    await object.Async();
    const pageURL = new URL('rvp-player.html', base); pageURL.searchParams.set('channel', channel);
    let browser, state = null, pageReady = false, ready = false, dead = false, head = null;
    let clockOffset = 0, offsetReady = false, lastPong = 0, lastPing = '', lastPingAt = 0, pending = Promise.resolve();
    let hostSeenAt = performance.now(), lastHost = '', sequence = 0, lastPersist = 0;
    const requestPrefix=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const timers = [], seenRequests = new Set();
    const users = () => Object.values(scene.users || {}).filter(u => u.uid && u.id !== 'local');
    const me = () => scene.localUser?.uid;
    const isHost = () => !!state && state.host === me();
    const eligible = u => u && (!config.modsOnly || u.isSpaceAdmin);
    const elected = () => {
      const choices = users().filter(eligible).map(u => u.uid).sort();
      return choices.includes(config.pinnedHost) ? config.pinnedHost : choices[0];
    };
    const hostPresent = () => users().some(u => u.uid === state?.host);
    const now = () => Date.now() + (isHost() ? 0 : clockOffset);
    const tellPage = message => {
      if (!browser || !pageReady || dead) return;
      browser.RunActions(JSON.stringify({actions:[{actionType:'postmessage',strParam1:JSON.stringify({channel,...message})}]}));
    };
    const notice = text => tellPage({type:'notice',text:String(text)});
    const view = () => tellPage({type:'state',state,position:state ? C.position(state, now()) : 0,
      host:isHost(),canControl:!!state && eligible(scene.localUser) && (!(config.locked || state.locked) || isHost()),
      users:users().map(u=>({uid:u.uid,name:u.name})), synced:ready && (isHost() || offsetReady),
      config:{...config, volume:C.clamp(attr('volume','80'),0,100),muted:flag('muted'),controls:flag('controls',true)}});
    const send = message => scene.OneShot({channel, ...message});
    const queueWork = task => { pending = pending.then(task).catch(e => { console.error('[RoomVideo]',e); notice(e.message); }); return pending; };
    async function persist(s) {
      const valid = C.validate(s, config.origins, config.maxItems);
      if(new TextEncoder().encode(JSON.stringify(JSON.stringify(valid))).length>15500)throw Error('Shared playlist storage is full. Remove some items or saved lists.');
      await scene.SpaceStateSet(key, JSON.stringify(valid), {protected: config.modsOnly});
      state = valid; lastPersist = performance.now(); view();
    }
    function receiveState(raw) {
      try {
        const s = C.validate(typeof raw === 'string' ? JSON.parse(raw) : raw, config.origins, config.maxItems);
        if (state && s.host === state.host && s.revision < state.revision) return;
        if (lastHost !== s.host) { clockOffset = 0; offsetReady = false; lastHost = s.host; hostSeenAt = performance.now(); }
        state = s; view();
      } catch(e) { notice(e.message); }
    }
    async function execute(command, sender) {
      if (!isHost() || !sender || !eligible(sender)) return;
      if ((config.locked || state.locked) && sender.uid !== state.host) throw Error('The host has locked this player.');
      if (['lock','transfer'].includes(command.action) && sender.uid !== state.host) throw Error('Only the host can do that.');
      if (command.action === 'ended' && sender.uid !== state.host) return;
      if (command.action === 'transfer' && !users().some(u => u.uid === command.uid && eligible(u))) throw Error('That player cannot host.');
      if (command.action === 'add') command.items = (command.items || [command.item]).map(x=>C.item(x, config.origins));
      const next = C.reduce(state,command,config,Date.now());
      if (next === state) return;
      if (command.action === 'transfer') {
        // Persist a transferable position. New host rebases onto its own clock on receipt.
        await persist(next);
      } else await persist(next);
    }
    function command(command) {
      if (!ready || !state) return notice('Waiting for room connection. Enable local multiplayer in Unity for testing.');
      if (isHost()) queueWork(()=>execute(command,scene.localUser));
      else {
        const message={type:'command',request:me()+':'+requestPrefix+':'+(++sequence),command};
        if(new TextEncoder().encode(JSON.stringify({channel,...message})).length>3900)return notice('Command too large. Use shorter URLs or smaller imports.');
        send(message).catch(e=>notice(e.message));
      }
    }
    object.On('browser-message', e => {
      let m; try {m=JSON.parse(e.detail);}catch{return;}
      if (m.channel !== channel) return;
      if (m.type === 'ready') {pageReady = true; view();}
      else if (m.type === 'command') command(m.command || {});
      else if (m.type === 'ended' && isHost()) command({action:'ended',revision:m.revision});
    });
    scene.On('pose-update', e => {head=e.detail?.head?.position;});
    scene.On('space-state', e => {
      if (!ready) return;
      const change = e.detail.changes.find(c => c.path === key && c.scope === (config.modsOnly ? 'protected' : 'public'));
      const raw = change?.deleted ? null : change?.value;
      if (raw) {
        const wasHost = isHost(), oldHost = state?.host, oldPosition = state ? C.position(state,now()) : 0;
        receiveState(raw);
        if (!wasHost && isHost() && oldHost) queueWork(async()=> {
          const s=structuredClone(state); s.position=oldPosition; s.at=Date.now(); s.revision++; await persist(s);
        });
      }
    });
    scene.On('one-shot', e => {
      let m; try {m=JSON.parse(e.detail.data);}catch{return;}
      if (m.channel !== channel || !ready) return;
      const sender = users().find(u=>u.id===e.detail.fromId); if (!sender) return;
      if (m.type==='command' && isHost()) {
        if (typeof m.request !== 'string' || seenRequests.has(m.request)) return;
        if (seenRequests.size>1000) seenRequests.clear(); seenRequests.add(m.request);
        queueWork(async()=>{try{await execute(m.command || {},sender);}catch(err){await send({type:'error',to:sender.uid,text:err.message});}});
      } else if (m.type==='error' && sender.uid===state?.host && m.to===me()) notice(m.text);
      else if (m.type==='ping' && isHost()) {
        send({type:'pong',to:sender.uid,nonce:m.nonce,time:Date.now(),revision:state.revision}).catch(console.error);
      } else if (m.type==='pong' && sender.uid===state?.host && m.to===me() && m.nonce===lastPing) {
        const rtt=performance.now()-lastPingAt;
        if (rtt<3000 && Number.isFinite(m.time)) {
          clockOffset=m.time+rtt/2-Date.now(); offsetReady=true; lastPong=performance.now(); hostSeenAt=performance.now();
          view();
        }
      } else if (m.type==='heartbeat' && sender.uid===state?.host) {
        hostSeenAt=performance.now();
      }
    });
    browser = await object.AddComponent(new BS.Browser({url:pageURL.href,pageWidth:screenPixels+panelPixels,pageHeight,
      rolloffMode:0,minDistance:3,maxDistance:18}));
    async function readList(url) {
      const safe=C.item({url},config.origins).url;
      const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),10000);
      try {
        const response=await fetch(safe,{credentials:'omit',signal:abort.signal,redirect:'error'});
        if(!response.ok)throw Error('Playlist download failed: '+response.status);
        const text=await response.text();if(text.length>64000)throw Error('Playlist file is too large.');
        let raw;
        try{raw=JSON.parse(text);}catch{raw=text.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#')).map(url=>({url}));}
        const items=Array.isArray(raw)?raw:raw.items;
        if(!Array.isArray(items)||!items.length||items.length>config.maxItems)throw Error('Invalid playlist file.');
        return {name:String(raw.name||new URL(safe).pathname.split('/').pop()).slice(0,50),items:items.map(x=>C.item(x,config.origins))};
      } finally {clearTimeout(timeout);}
    }
    const tick = async () => {
      if (dead) return;
      if (!ready) {
        if (!me() || scene.localUser.id==='local') return;
        // Get a server snapshot before election: never overwrite a late joiner's playlist with defaults.
        const all=await scene.SpaceStateGetAll();
        const raw=(config.modsOnly?all.protected:all.public)?.[key];
        if (raw) receiveState(raw);
        ready=true; hostSeenAt=performance.now();
      }
      if ((!state || !hostPresent()) && elected()===me()) {
        // A short settle period lets the roster arrive before picking an authority.
        if (performance.now()-hostSeenAt<3500) return;
        const fresh=!state;
        const s=state?structuredClone(state):C.initial(config,me(),Date.now());
        if (state) s.position=C.position(state,now());
        s.host=me(); s.at=Date.now(); s.revision++;
        await persist(s); offsetReady=true; lastHost=me();
        if(fresh) {
          if(attr('playlist')) {
            const list=await readList(attr('playlist'));
            await execute({action:'add',items:list.items},scene.localUser);
          } else if(attr('video')) await execute({action:'add',item:{url:attr('video')}},scene.localUser);
          for(const url of attr('playlists').split(/[\s,]+/).filter(Boolean).slice(0,5)) {
            const list=await readList(url);await execute({action:'import-list',...list},scene.localUser);
          }
        }
        view();
      }
      if (isHost()) {
        await send({type:'heartbeat',revision:state.revision,time:Date.now()});
        if (performance.now()-lastPersist>10000) {
          const s=structuredClone(state);s.position=C.position(s,Date.now());s.at=Date.now();await persist(s);
        }
      } else if (state) {
        lastPing=me()+':'+(++sequence);lastPingAt=performance.now();
        await send({type:'ping',nonce:lastPing});
        if (performance.now()-lastPong>10000) {offsetReady=false;view();}
      }
    };
    timers.push(setInterval(()=>queueWork(tick),2000));
    timers.push(setInterval(()=> {
      if (state) tellPage({type:'clock',position:C.position(state,now()),synced:ready&&(isHost()||offsetReady),revision:state.revision});
      let gain=1;
      if(flag('distance-volume',true) && head) {
        const d=Math.hypot(head.x-position[0],head.y-position[1],head.z-position[2]);
        const near=C.clamp(attr('full-volume-distance','3'),.1,500),far=Math.max(near+.1,C.clamp(attr('silence-distance','18'),.2,1000));
        const min=C.clamp(attr('min-volume','0'),0,100)/100;
        gain=1-(1-min)*C.clamp((d-near)/(far-near),0,1);
      }
      tellPage({type:'gain',gain});
    },500));
    scene.On('user-joined',view); scene.On('user-left',view);
    const cleanup=new MutationObserver(()=> {
      if(el.isConnected)return;
      dead=true;timers.forEach(clearInterval);cleanup.disconnect();object.Destroy();window.__roomVideoChannels.delete(channel);
    }); cleanup.observe(document.documentElement,{childList:true,subtree:true});
    queueWork(tick);
  }
  function eulerQuaternion([x,y,z]) {
    const mul=(a,b)=>({w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w});
    const a=(v,n)=>{const r=n*Math.PI/360;return {x:v===0?Math.sin(r):0,y:v===1?Math.sin(r):0,z:v===2?Math.sin(r):0,w:Math.cos(r)};};
    return mul(mul(a(1,y),a(0,x)),a(2,z));
  }
  function rotate(q,v) {const t={x:2*(q.y*v.z-q.z*v.y),y:2*(q.z*v.x-q.x*v.z),z:2*(q.x*v.y-q.y*v.x)};return {x:v.x+q.w*t.x+q.y*t.z-q.z*t.y,y:v.y+q.w*t.y+q.z*t.x-q.x*t.z,z:v.z+q.w*t.z+q.x*t.y-q.y*t.x};}
})();
