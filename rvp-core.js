/* Room Video Player — original implementation, MIT licensed. */
(function (root) {
  'use strict';
  const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || 0));
  function origins(text) {
    return String(text || '').split(/[\s,]+/).filter(Boolean).map(x => {
      const u = new URL(x);
      if (u.protocol !== 'https:' || u.username || u.password) throw Error('Media origins must be HTTPS origins.');
      return u.origin;
    });
  }
  function item(raw, allowed) {
    const u = new URL(String(raw.url || '').trim());
    if (u.protocol !== 'https:' || u.username || u.password || !allowed.includes(u.origin))
      throw Error('Use an HTTPS media URL on a configured media-origins host.');
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|twitch\.tv|googlevideo\.com|drive\.google\.com)$/.test(u.hostname))
      throw Error('Platform embeds and extracted platform URLs are disabled in strict ad-free mode.');
    return { url: u.href, title: String(raw.title || decodeURIComponent(u.pathname.split('/').pop()) || 'Video').slice(0, 100), live: raw.live === true };
  }
  function position(s, now) {
    return Math.max(0, s.position + (s.playing ? Math.max(0, now - s.at) / 1000 : 0));
  }
  function initial(config, uid, now) {
    return { v: 1, host: uid, revision: 1, queue: [], lists: [], index: -1, position: 0,
      at: now, playing: false, loop: config.loop, locked: config.locked, quality: 'auto' };
  }
  function validate(raw, allowed, max) {
    if (!raw || raw.v !== 1 || typeof raw.host !== 'string' || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw Error('Invalid room state.');
    if (!Array.isArray(raw.queue) || raw.queue.length > max || !Array.isArray(raw.lists) || raw.lists.length > 5) throw Error('Invalid playlist size.');
    const s = structuredClone(raw);
    s.queue = s.queue.map(x => item(x, allowed));
    s.lists = s.lists.map(x => {
      if (!Array.isArray(x.items) || x.items.length > max) throw Error('Invalid saved list.');
      return { name: String(x.name).slice(0, 50), items: x.items.map(y => item(y, allowed)) };
    });
    if (!Number.isInteger(s.index) || s.index < -1 || s.index >= s.queue.length || (s.index === -1 && s.playing)) throw Error('Invalid playback index.');
    if (!Number.isFinite(s.at) || !Number.isFinite(s.position) || s.position < 0) throw Error('Invalid playback time.');
    s.playing = s.playing === true; s.loop = s.loop === true; s.locked = s.locked === true;
    s.quality = ['auto', '720', '1080'].includes(s.quality) ? s.quality : 'auto';
    if (new TextEncoder().encode(JSON.stringify(s)).length > 15000) throw Error('Shared playlist storage is full; shorten URLs or remove items/lists.');
    return s;
  }
  function reduce(state, command, config, now) {
    const s = structuredClone(state), a = command.action;
    s.position = position(s, now); s.at = now;
    const index = n => { if (!Number.isInteger(n) || n < 0 || n >= s.queue.length) throw Error('Choose a valid playlist item.'); return n; };
    const select = n => { s.index = n; s.position = 0; s.playing = n >= 0; };
    switch (a) {
      case 'add': {
        const items = (command.items || [command.item]).map(x => item(x, config.origins));
        if (!items.length || s.queue.length + items.length > config.maxItems) throw Error('Playlist limit reached.');
        const first = s.queue.length; s.queue.push(...items);
        if (command.play || (config.autoplay && s.index < 0)) select(first);
        break;
      }
      case 'play': if (s.index < 0 && s.queue.length) select(0); else if (s.index >= 0) s.playing = true; break;
      case 'pause': s.playing = false; break;
      case 'stop': s.playing = false; s.position = 0; break;
      case 'seek': if (!s.queue[s.index]?.live) s.position = clamp(command.position, 0, 7 * 86400); break;
      case 'select': select(index(command.index)); break;
      case 'next': case 'ended': {
        if (a === 'ended' && command.revision !== state.revision) return state;
        if (s.index + 1 < s.queue.length) select(s.index + 1);
        else if (s.loop && s.queue.length) select(0);
        else { s.playing = false; s.position = 0; }
        break;
      }
      case 'previous': if (s.queue.length) select(Math.max(0, s.index - 1)); break;
      case 'remove': {
        const i = index(command.index); s.queue.splice(i, 1);
        if (!s.queue.length) select(-1);
        else if (i === s.index) select(Math.min(i, s.queue.length - 1));
        else if (i < s.index) s.index--;
        break;
      }
      case 'move': {
        const i = index(command.index), j = index(command.to), current = s.queue[s.index];
        s.queue.splice(j, 0, s.queue.splice(i, 1)[0]); s.index = s.queue.indexOf(current); break;
      }
      case 'clear': s.queue = []; select(-1); break;
      case 'loop': s.loop = command.value === true; break;
      case 'lock': s.locked = config.locked || command.value === true; break;
      case 'quality': s.quality = String(command.value); break;
      case 'save-list':
        if (!s.queue.length || s.lists.length >= 5) throw Error('Save up to five nonempty lists.');
        s.lists.push({name: String(command.name || 'Saved list').slice(0, 50), items: structuredClone(s.queue)}); break;
      case 'import-list':
        if (s.lists.length >= 5 || !Array.isArray(command.items) || !command.items.length) throw Error('Save up to five nonempty lists.');
        s.lists.push({name:String(command.name || 'Imported list').slice(0,50),items:command.items.map(x=>item(x,config.origins))}); break;
      case 'delete-list':
        if (!s.lists[command.index]) throw Error('List not found.'); s.lists.splice(command.index, 1); break;
      case 'load-list': {
        const list = s.lists[command.index]; if (!list) throw Error('List not found.');
        if (command.append) s.queue.push(...structuredClone(list.items));
        else { s.queue = structuredClone(list.items); select(s.queue.length ? 0 : -1); }
        break;
      }
      case 'transfer': if (typeof command.uid !== 'string') throw Error('Choose a host.'); s.host = command.uid; break;
      default: throw Error('Unknown player command.');
    }
    s.revision++;
    return validate(s, config.origins, config.maxItems);
  }
  const api = { clamp, origins, item, position, initial, validate, reduce };
  if (typeof module !== 'undefined') module.exports = api;
  else root.RoomVideoCore = api;
})(typeof window === 'undefined' ? globalThis : window);
