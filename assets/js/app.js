// Room orchestration: auth gate, socket state, dance floor, votes and chat.

import { api, formatTime } from './api.js';
import { BPM, buildAvatar, DJ_ANIMATIONS, setBpm } from './avatar.js';
import { icon, voteArt } from './icons.js';
import { createAvatarPicker } from './picker.js';
import { createPlaylistPanel } from './playlist.js';
import * as player from './player.js';
import { request, serverNow, socket } from './socket.js';

const el = (id) => document.getElementById(id);

let me = null;
let state = null;
let picker = null;
let playlistPanel = null;
let djAnimationTimer = null;

/** Avatar elements are reused across renders so animations do not restart. */
const dancers = new Map();

// --- toasts ---------------------------------------------------------------

function toast(message) {
  if (!message) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  el('toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

// --- auth -----------------------------------------------------------------

let mode = 'register';

function showAuthError(message) {
  const box = el('authError');
  box.textContent = message;
  box.hidden = !message;
}

el('authToggle').onclick = () => {
  mode = mode === 'register' ? 'login' : 'register';
  el('authSubmit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
  el('authToggle').textContent =
    mode === 'register' ? 'I already have an account' : 'I need an account';
  el('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  showAuthError('');
};

el('authForm').onsubmit = async (event) => {
  event.preventDefault();
  showAuthError('');
  el('authSubmit').disabled = true;

  try {
    me = await api.post(`/api/auth/${mode}`, {
      username: el('username').value,
      password: el('password').value,
    });
    await startRoom();
  } catch (error) {
    showAuthError(error.message);
  } finally {
    el('authSubmit').disabled = false;
  }
};

el('logout').onclick = async () => {
  await api.post('/api/auth/logout');
  window.location.reload();
};

// --- tabs -----------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('is-active', other === tab);
    }
    for (const panel of document.querySelectorAll('.panel')) {
      panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
    }
  };
}

// --- room rendering -------------------------------------------------------

function renderNowPlaying() {
  const current = state?.current;
  el('nowTitle').textContent = current ? current.title : 'Nothing playing';
  el('nowDj').textContent = state?.dj
    ? `${state.dj.username} is playing`
    : 'The booth is empty — join the queue';
  el('boothLabel').textContent = state?.dj
    ? `${state.dj.username} · ${current?.title ?? ''}`
    : 'Nobody is playing';
  // Covers the embed while it has no video, and hides the empty progress bar.
  el('screen').classList.toggle('is-idle', !current);
  el('now').classList.toggle('is-idle', !current);

  // Your own song is already in your playlist, so voting and grabbing are both
  // meaningless from the booth.
  const voting = Boolean(current) && state.dj?.userId !== me.id;
  el('wootBtn').disabled = !voting;
  el('mehBtn').disabled = !voting;
  el('grabBtn').disabled = !voting;

  const mine = state?.votes?.byUser?.[me.id];
  el('wootBtn').classList.toggle('is-on', mine === 'woot');
  el('mehBtn').classList.toggle('is-on', mine === 'meh');
  el('grabBtn').classList.toggle('is-on', state?.votes?.grabbedBy?.includes(me.id));

  el('wootCount').textContent = state?.votes?.woots ?? 0;
  el('mehCount').textContent = state?.votes?.mehs ?? 0;
  el('grabCount').textContent = state?.votes?.grabs ?? 0;

  const isDj = state?.dj?.userId === me.id;
  el('skipBtn').hidden = !isDj;
  const queued = (state?.waitlist ?? []).some((entry) => entry.userId === me.id);
  el('queueBtnText').textContent = isDj || queued ? 'Leave the queue' : 'Join the queue';
  el('queueBtn').dataset.action = isDj || queued ? 'leave' : 'join';
}

function renderProgress() {
  const current = state?.current;
  if (!current) {
    el('nowTime').textContent = '';
    el('nowProgress').style.width = '0';
    return;
  }
  const elapsed = Math.min(current.duration, (serverNow() - current.startedAt) / 1000);
  el('nowTime').textContent = `${formatTime(elapsed)} / ${formatTime(current.duration)}`;
  el('nowProgress').style.width = `${(elapsed / current.duration) * 100}%`;
}

/** Reuses existing avatar nodes so in-flight CSS animations are not restarted. */
function renderFloor() {
  const floor = el('floor');
  const booth = el('boothDj');
  const playing = Boolean(state?.current);
  const seen = new Set();

  for (const user of state?.users ?? []) {
    seen.add(user.userId);
    let entry = dancers.get(user.userId);

    // The tempo is applied below without a rebuild, so dragging the slider
    // does not make the dancer hop back onto the floor every few pixels.
    const { bpm, ...rest } = user.avatar ?? {};
    const look = JSON.stringify(rest);
    if (!entry || entry.look !== look) {
      const wrapper = document.createElement('div');
      wrapper.className = 'dancer av--entering';
      const avatar = buildAvatar(user.avatar, { scale: 0.3 });
      const name = document.createElement('div');
      name.className = 'dancer__name';
      const tempo = document.createElement('small');
      tempo.className = 'dancer__bpm';
      name.append(document.createTextNode(user.username), tempo);
      wrapper.append(avatar, name);
      // Dropped once it has played, otherwise moving the node to the booth
      // would replay the entrance hop.
      setTimeout(() => wrapper.classList.remove('av--entering'), 700);

      entry?.wrapper.remove();
      entry = { wrapper, avatar, look };
      dancers.set(user.userId, entry);
    }

    entry.wrapper.classList.toggle('is-dj', user.isDj);
    entry.wrapper.querySelector('.dancer__name').firstChild.textContent = user.username;
    entry.wrapper.querySelector('.dancer__bpm').textContent = `${bpm ?? BPM.default}`;
    setBpm(entry.avatar, bpm);

    // The DJ stands behind the decks, a little larger; everyone else is on the
    // floor. Both sizes come from the stylesheet, which scales them to the
    // window rather than letting the room outgrow the space it has.
    const target = user.isDj ? booth : floor;
    entry.avatar.style.setProperty(
      '--av-scale',
      user.isDj ? 'var(--dj-scale, 0.32)' : 'var(--dance-scale, 0.3)',
    );
    if (entry.wrapper.parentElement !== target) {
      if (user.isDj && entry.wrapper.parentElement === floor) {
        // Walk across before settling into a DJ animation.
        entry.avatar.dataset.anim = 'walk';
        setTimeout(() => {
          if (dancers.get(user.userId) === entry && state?.dj?.userId === user.userId) {
            entry.avatar.dataset.anim = pickDjAnimation();
          }
        }, 1200);
      }
      target.append(entry.wrapper);
    }

    if (!user.isDj) {
      entry.avatar.dataset.anim = playing ? user.avatar?.dance ?? 'bob' : 'idle';
    } else if (!DJ_ANIMATIONS.includes(entry.avatar.dataset.anim) && entry.avatar.dataset.anim !== 'walk') {
      // Someone already in the booth when we arrived: give them a pose now
      // rather than leaving a dance-floor animation until the cycle fires.
      entry.avatar.dataset.anim = pickDjAnimation();
    }

    const vote = state?.votes?.byUser?.[user.userId];
    let badge = entry.wrapper.querySelector('.dancer__vote');
    if (vote) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'dancer__vote';
        entry.wrapper.append(badge);
      }
      if (badge.dataset.vote !== vote) {
        badge.dataset.vote = vote;
        badge.replaceChildren(voteArt(vote));
      }
    } else badge?.remove();
  }

  for (const [userId, entry] of dancers) {
    if (!seen.has(userId)) {
      entry.wrapper.remove();
      dancers.delete(userId);
    }
  }
}

const pickDjAnimation = () => DJ_ANIMATIONS[Math.floor(Math.random() * DJ_ANIMATIONS.length)];

/** Cycles the DJ through poses so the booth never looks frozen. */
function scheduleDjAnimation() {
  clearTimeout(djAnimationTimer);
  const next = 8000 + Math.random() * 4000;
  djAnimationTimer = setTimeout(() => {
    const djId = state?.dj?.userId;
    const entry = djId ? dancers.get(djId) : null;
    if (entry && entry.avatar.dataset.anim !== 'walk') {
      entry.avatar.dataset.anim = pickDjAnimation();
    }
    scheduleDjAnimation();
  }, next);
}

function renderQueue() {
  el('queueDj').textContent = state?.dj ? state.dj.username : 'Nobody';

  const list = el('queueList');
  list.innerHTML = '';
  const waitlist = state?.waitlist ?? [];
  if (waitlist.length === 0) {
    list.innerHTML = '<li class="empty">The queue is empty.</li>';
  } else {
    waitlist.forEach((entry, index) => {
      const li = document.createElement('li');
      const pos = document.createElement('span');
      pos.className = 'queue__pos';
      pos.textContent = String(index + 1);
      const name = document.createElement('span');
      name.textContent = entry.username ?? 'someone';
      li.append(pos, name);
      list.append(li);
    });
  }
}

function renderHistory(entries) {
  const list = el('historyList');
  list.innerHTML = '';
  if (!entries?.length) {
    list.innerHTML = '<li class="empty">Nothing has played yet.</li>';
    return;
  }
  for (const entry of entries) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'row__main';
    const title = document.createElement('div');
    title.className = 'row__title';
    title.textContent = entry.title;
    const sub = document.createElement('div');
    sub.className = 'row__sub';
    sub.textContent = `played by ${entry.dj_username}`;
    main.append(title, sub);

    const votes = document.createElement('span');
    votes.className = 'history__votes';
    votes.append(voteArt('woot'), ` ${entry.woots} `, voteArt('meh'), ` ${entry.mehs}`);
    li.append(main, votes);
    list.append(li);
  }
}

function applyState(next) {
  const previousTrack = state?.current;
  state = next;

  renderNowPlaying();
  renderQueue();
  renderFloor();
  renderProgress();

  const changed =
    previousTrack?.sourceId !== state.current?.sourceId ||
    previousTrack?.startedAt !== state.current?.startedAt;

  if (changed && player.isReady()) {
    if (state.current) player.play(state.current);
    else player.stop();
  }
}

// --- chat -----------------------------------------------------------------

function addChatMessage({ username, text, system }) {
  const log = el('chatLog');
  const node = document.createElement('div');
  node.className = system ? 'chat__msg chat__msg--system' : 'chat__msg';
  if (system) {
    node.textContent = text;
  } else {
    const who = document.createElement('span');
    who.className = 'chat__who';
    who.textContent = username;
    node.append(who, document.createTextNode(text));
  }
  log.append(node);
  log.scrollTop = log.scrollHeight;
}

el('chatForm').onsubmit = async (event) => {
  event.preventDefault();
  const input = el('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const reply = await request('chat', { text });
  if (reply.error) toast(reply.error);
};

// --- controls -------------------------------------------------------------

el('wootBtn').onclick = async () => toast((await request('vote', { kind: 'woot' })).error);
el('mehBtn').onclick = async () => toast((await request('vote', { kind: 'meh' })).error);
el('grabBtn').onclick = async () => {
  const reply = await request('grab', {});
  if (reply.error) toast(reply.error);
  else {
    toast(`Saved to "${reply.playlist}"`);
    playlistPanel?.refresh();
  }
};
el('skipBtn').onclick = async () => toast((await request('dj:skip', {})).error);
el('queueBtn').onclick = async () => {
  const leaving = el('queueBtn').dataset.action === 'leave';
  const reply = await request(leaving ? 'waitlist:leave' : 'waitlist:join', {});
  if (reply.error) toast(reply.error);
};

// --- tempo ----------------------------------------------------------------

/** Mirrors a tempo into the slider, its readout and the pulsing dot. */
function renderBpm(bpm) {
  const value = Number(bpm) || BPM.default;
  el('bpmRange').value = value;
  el('bpmValue').textContent = value;
  el('bpmRange').closest('.bpm').style.setProperty('--bpm', value);
}

let bpmTimer = null;
el('bpmRange').oninput = (event) => {
  const bpm = Number(event.target.value);
  renderBpm(bpm);
  // The readout and the local dancer follow the thumb; the room hears about it
  // once the hand pauses, so a drag is one broadcast rather than a hundred.
  if (me?.id) setBpm(dancers.get(me.id)?.avatar, bpm);
  clearTimeout(bpmTimer);
  bpmTimer = setTimeout(async () => {
    const reply = await request('bpm:set', { bpm });
    if (reply.error) toast(reply.error);
    else {
      me.avatar = { ...me.avatar, bpm: reply.bpm };
      picker?.patch({ bpm: reply.bpm });
    }
  }, 180);
};

/** The player owns the volume state; the slider and icon just mirror it. */
function renderVolume({ volume, muted }) {
  el('volume').value = volume;
  el('muteBtn').replaceChildren(icon(muted || volume === 0 ? 'mute' : 'volume'));
}

el('volume').oninput = (event) => renderVolume(player.setVolume(event.target.value));
el('muteBtn').onclick = () => renderVolume(player.toggleMute());

// --- socket wiring --------------------------------------------------------

socket.on('hello', (payload) => {
  me = { ...me, ...payload.you };
  el('meName').textContent = me.username;
  picker?.set(payload.you.avatar);
  renderBpm(payload.you.avatar?.bpm);
  el('chatLog').innerHTML = '';
  for (const message of payload.chat ?? []) addChatMessage(message);
  renderHistory(payload.history);
  applyState(payload.state);
});

socket.on('room:state', applyState);
socket.on('room:history', renderHistory);
socket.on('chat', addChatMessage);
socket.on('notice', ({ message }) => {
  toast(message);
  addChatMessage({ text: message, system: true });
});
socket.on('disconnect', () => addChatMessage({ text: 'Disconnected — reconnecting…', system: true }));
socket.on('connect_error', (error) => {
  if (error.message === 'not signed in') window.location.reload();
});

// --- boot -----------------------------------------------------------------

async function startRoom() {
  el('gate').hidden = true;
  el('app').hidden = false;
  el('meName').textContent = me.username;

  const config = await api.get('/api/config').catch(() => ({ roomName: 'the room' }));
  el('roomName').textContent = config.roomName;

  picker = createAvatarPicker({
    initial: me.avatar,
    onToast: toast,
    onSaved: () => socket.emit('avatar:changed'),
  });
  await picker.load();

  playlistPanel = createPlaylistPanel({ onToast: toast });
  await playlistPanel.refresh();

  socket.connect();
  scheduleDjAnimation();
  setInterval(renderProgress, 500);

  el('enterGate').hidden = false;
}

el('enterRoom').onclick = async () => {
  el('enterRoom').disabled = true;
  try {
    await player.createPlayer({
      onStatus: (text) => {
        const status = el('playerStatus');
        status.textContent = text;
        status.hidden = !text;
      },
      // Only the provider playing right now should be on screen.
      onProvider: (name) => {
        el('screen').dataset.provider = name;
      },
    });
    el('enterGate').hidden = true;
    if (state?.current) player.play(state.current);
  } catch {
    toast('Could not start the player');
    el('enterRoom').disabled = false;
  }
};

try {
  me = await api.get('/api/auth/me');
  await startRoom();
} catch {
  el('gate').hidden = false;
}
