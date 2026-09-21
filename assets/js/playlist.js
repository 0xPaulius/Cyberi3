// Playlist panel: pick a playlist, search YouTube and SoundCloud, add/remove/
// reorder tracks, import a whole playlist from either.

import { api, formatTime } from './api.js';
import { icon } from './icons.js';

const el = (id) => document.getElementById(id);

export function createPlaylistPanel({ onToast, onActiveChange }) {
  const select = el('playlistSelect');
  const trackList = el('trackList');
  const results = el('searchResults');
  const searchInput = el('searchInput');

  let playlists = [];
  let activeId = null;
  let selectedId = null;

  function renderSelect() {
    select.innerHTML = '';
    for (const playlist of playlists) {
      const option = document.createElement('option');
      option.value = playlist.id;
      option.textContent =
        `${playlist.name} (${playlist.track_count})` + (playlist.id === activeId ? ' · active' : '');
      select.append(option);
    }
    if (selectedId) select.value = String(selectedId);
    el('playlistActivate').disabled = selectedId === activeId;
    el('playlistActivateText').textContent =
      selectedId === activeId ? 'This is your DJ playlist' : 'Use this playlist when I DJ';
  }

  function trackRow(track, index) {
    const li = document.createElement('li');
    li.className = 'row';
    if (track.unplayable) li.classList.add('is-blocked');
    // The room plays the first track it can, which is not the top one when
    // something above it turned out to be unplayable.
    const nextIndex = tracks.findIndex((candidate) => !candidate.unplayable);
    if (index === nextIndex && selectedId === activeId) li.classList.add('is-next');

    const main = document.createElement('div');
    main.className = 'row__main';
    const title = document.createElement('div');
    title.className = 'row__title';
    title.textContent = track.title;
    const sub = document.createElement('div');
    sub.className = 'row__sub';
    sub.append(
      sourceBadge(track.provider),
      track.unplayable
        ? `${track.author ?? 'Unknown'} · cannot be played here — skipped`
        : `${track.author ?? 'Unknown'} · ${formatTime(track.duration)}`,
    );
    main.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    const up = document.createElement('button');
    up.className = 'btn btn--icon btn--ghost';
    up.title = 'Play sooner';
    up.append(icon('up'));
    up.onclick = () => move(index, index - 1);

    const top = document.createElement('button');
    top.className = 'btn btn--icon btn--ghost';
    top.title = 'Play next';
    top.append(icon('top'));
    top.onclick = () => move(index, 0);

    const remove = document.createElement('button');
    remove.className = 'btn btn--icon btn--ghost';
    remove.title = 'Remove';
    remove.append(icon('close'));
    remove.onclick = async () => {
      await api.del(`/api/playlists/${selectedId}/tracks/${track.id}`);
      await loadTracks();
      await loadPlaylists();
    };

    actions.append(top, up, remove);
    li.append(main, actions);
    return li;
  }

  let tracks = [];

  async function move(from, to) {
    if (to < 0 || to >= tracks.length || from === to) return;
    const ids = tracks.map((t) => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    const response = await api.put(`/api/playlists/${selectedId}/tracks/order`, { ids });
    tracks = response.tracks;
    renderTracks();
  }

  function renderTracks() {
    trackList.innerHTML = '';
    if (tracks.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Nothing here yet. Search above to add songs, or paste a playlist link to import one.';
      trackList.append(empty);
      return;
    }
    tracks.forEach((track, index) => trackList.append(trackRow(track, index)));
  }

  async function loadTracks() {
    if (!selectedId) return;
    const response = await api.get(`/api/playlists/${selectedId}/tracks`);
    tracks = response.tracks;
    renderTracks();
  }

  async function loadPlaylists() {
    const response = await api.get('/api/playlists');
    playlists = response.playlists;
    activeId = response.activePlaylistId;
    if (!playlists.some((p) => p.id === selectedId)) selectedId = activeId ?? playlists[0]?.id;
    renderSelect();
    onActiveChange?.(activeId);
  }

  select.onchange = async () => {
    selectedId = Number(select.value);
    renderSelect();
    await loadTracks();
  };

  el('playlistNew').onclick = async () => {
    const name = prompt('Name this playlist');
    if (!name) return;
    const created = await api.post('/api/playlists', { name });
    selectedId = created.id;
    await loadPlaylists();
    await loadTracks();
  };

  el('playlistRename').onclick = async () => {
    const current = playlists.find((p) => p.id === selectedId);
    const name = prompt('Rename playlist', current?.name ?? '');
    if (!name) return;
    await api.patch(`/api/playlists/${selectedId}`, { name });
    await loadPlaylists();
  };

  el('playlistDelete').onclick = async () => {
    const current = playlists.find((p) => p.id === selectedId);
    if (!confirm(`Delete "${current?.name}"?`)) return;
    try {
      const response = await api.del(`/api/playlists/${selectedId}`);
      selectedId = response.activePlaylistId;
      await loadPlaylists();
      await loadTracks();
    } catch (error) {
      onToast(error.message);
    }
  };

  el('playlistActivate').onclick = async () => {
    await api.post(`/api/playlists/${selectedId}/activate`);
    await loadPlaylists();
    onToast('This playlist will be used when you DJ');
  };

  /**
   * Pulls every track at a playlist link into the selected playlist and says
   * what happened to the ones that did not make it, since a silent 38 out of
   * 50 reads like a bug.
   */
  async function importPlaylist(url) {
    const response = await api.post(`/api/playlists/${selectedId}/import`, { url });
    tracks = response.tracks;
    renderTracks();
    await loadPlaylists();

    const { skipped } = response;
    const reasons = [
      skipped.duplicate && `${skipped.duplicate} already here`,
      skipped.duration && `${skipped.duration} too long or too short`,
      skipped.blocked && `${skipped.blocked} blocked from playing outside YouTube`,
      skipped.full && `${skipped.full} did not fit (playlists hold 500)`,
    ].filter(Boolean);

    const summary = `Added ${response.added} of ${response.found} tracks from “${response.title}”`;
    onToast(reasons.length ? `${summary} · skipped ${reasons.join(', ')}` : summary);
    return response;
  }

  el('playlistImport').onclick = async () => {
    const url = prompt('Paste a YouTube or SoundCloud playlist link');
    if (!url?.trim()) return;
    const button = el('playlistImport');
    button.disabled = true;
    try {
      await importPlaylist(url.trim());
    } catch (error) {
      onToast(error.message);
    } finally {
      button.disabled = false;
    }
  };

  el('playlistShuffle').onclick = async () => {
    if (tracks.length < 2) return onToast('Nothing to shuffle yet');
    const button = el('playlistShuffle');
    button.disabled = true;
    try {
      const response = await api.post(`/api/playlists/${selectedId}/shuffle`);
      tracks = response.tracks;
      renderTracks();
    } catch (error) {
      onToast(error.message);
    } finally {
      button.disabled = false;
    }
  };

  el('searchForm').onsubmit = async (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    results.hidden = false;
    results.innerHTML = '<div class="empty">Searching…</div>';

    try {
      const response = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
      renderResults(response.results ?? [], response.error, response.playlist);
    } catch (error) {
      results.innerHTML = `<div class="empty">${error.message}</div>`;
    }
  };

  /**
   * YouTube exposes a still for every video at a predictable URL; SoundCloud
   * hands us an artwork URL, or nothing at all for tracks without cover art.
   */
  function thumbnail(track) {
    const src =
      track.provider === 'soundcloud'
        ? track.artwork
        : `https://i.ytimg.com/vi/${track.sourceId}/mqdefault.jpg`;

    const img = document.createElement('img');
    img.className = 'row__thumb';
    if (src) img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }

  function sourceBadge(provider) {
    const badge = document.createElement('span');
    badge.className = `badge badge--${provider}`;
    badge.textContent = provider === 'soundcloud' ? 'SoundCloud' : 'YouTube';
    return badge;
  }

  /** A pasted playlist link becomes one row offering to import the lot. */
  function playlistRow(playlist) {
    const row = document.createElement('div');
    row.className = 'row row--playlist';

    const img = document.createElement('img');
    img.className = 'row__thumb';
    if (playlist.artwork) img.src = playlist.artwork;
    img.alt = '';

    const main = document.createElement('div');
    main.className = 'row__main';
    const title = document.createElement('div');
    title.className = 'row__title';
    title.textContent = playlist.title;
    const sub = document.createElement('div');
    sub.className = 'row__sub';
    const count =
      playlist.playable === playlist.count
        ? `${playlist.count} tracks`
        : `${playlist.playable} of ${playlist.count} tracks fit the length limit`;
    // A span rather than a bare text node, so the ellipsis rule reaches it.
    const detail = document.createElement('span');
    detail.textContent = playlist.author ? `${playlist.author} · ${count}` : count;
    detail.title = detail.textContent;
    sub.append(sourceBadge(playlist.provider), detail);
    main.append(title, sub);

    const button = document.createElement('button');
    button.className = 'btn btn--primary';
    button.textContent = 'Import all';
    button.disabled = playlist.playable === 0;
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = 'Importing…';
      try {
        const response = await importPlaylist(playlist.url);
        button.textContent = `Added ${response.added}`;
      } catch (importError) {
        button.disabled = false;
        button.textContent = 'Import all';
        onToast(importError.message);
      }
    };

    row.append(img, main, button);
    return row;
  }

  function renderResults(list, error, playlist) {
    results.innerHTML = '';
    if (playlist) results.append(playlistRow(playlist));
    if (list.length === 0) {
      if (!playlist || error) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = error ?? 'No results.';
        results.append(empty);
      }
      return;
    }

    // The results sit above the playlist in a scrolling panel, so a shorter
    // list keeps the tracks the DJ already owns within reach.
    for (const track of list.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'row';

      const main = document.createElement('div');
      main.className = 'row__main';
      const title = document.createElement('div');
      title.className = 'row__title';
      title.textContent = track.title;
      const sub = document.createElement('div');
      sub.className = 'row__sub';
      sub.append(sourceBadge(track.provider), `${track.author} · ${formatTime(track.duration)}`);
      main.append(title, sub);

      const add = document.createElement('button');
      add.className = 'btn btn--primary btn--icon';
      add.title = 'Add to playlist';
      add.append(icon('plus'));
      add.onclick = async () => {
        add.disabled = true;
        try {
          await api.post(`/api/playlists/${selectedId}/tracks`, {
            provider: track.provider,
            sourceId: track.sourceId,
          });
          add.replaceChildren(icon('check'));
          await loadTracks();
          await loadPlaylists();
        } catch (addError) {
          add.disabled = false;
          onToast(addError.message);
        }
      };

      row.append(thumbnail(track), main, add);
      results.append(row);
    }
  }

  return {
    async refresh() {
      await loadPlaylists();
      await loadTracks();
    },
    activePlaylistId: () => activeId,
  };
}
