// Avatar picker: dropdowns for every part, with a live animated preview.

import { api } from './api.js';
import { buildAvatar } from './avatar.js';

const LABELS = [
  ['skin', 'Skin'],
  ['costume', 'Costume'],
  ['hairStyle', 'Hair'],
  ['hairColor', 'Hair colour'],
  ['hat', 'Hat'],
  ['shirtStyle', 'Shirt'],
  ['shirtColor', 'Shirt colour'],
  ['pantsStyle', 'Pants'],
  ['pantsColor', 'Pants colour'],
  ['shoeStyle', 'Shoes'],
  ['shoeColor', 'Shoe colour'],
  ['eyeColor', 'Eyes'],
  ['browColor', 'Brows'],
  ['mouth', 'Mouth'],
  ['nose', 'Nose'],
  ['faceExtra', 'Face extra'],
  ['aura', 'Aura'],
  ['dance', 'Dance'],
];

/** A costume covers the trunk, so these say nothing about how you look. */
const COVERED_BY_COSTUME = new Set([
  'shirtStyle',
  'shirtColor',
  'pantsStyle',
  'pantsColor',
]);

// Slugs the generic prettifier cannot make readable on its own.
const NAMES = {
  none: 'None',
  cone: 'Traffic cone',
  chicken: 'Rubber chicken',
  poop: 'Poop',
  crown: 'Crown',
  tinfoil: 'Tinfoil hat',
  cap: 'Backwards cap',
  toilet: 'Toilet seat',
  googly: 'Googly eyes',
  unibrow: 'Unibrow',
  clownnose: 'Clown nose',
  shades: 'Shades',
  moustache: 'Moustache',
  eyepatch: 'Eye patch',
  banana: 'Banana suit',
  dino: 'Dinosaur onesie',
  hotdog: 'Hot dog',
  vest: 'Vest and boxers',
  skullhelm: 'Skull helm',
  horns: 'Demon horns',
  hood: 'Warlock hood',
  halo: 'Aero halo',
  skullpaint: 'Skull paint',
  glow: 'Glowing eyes',
  visor: 'Chrome visor',
  deathknight: 'Death knight plate',
  aero: 'Aero suit',
  chrome: 'Chrome puffer',
  frost: 'Frost',
  ember: 'Ember',
  void: 'Void',
  holy: 'Holy',
};

const pretty = (value) =>
  NAMES[value] ??
  String(value)
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

export function createAvatarPicker({ initial, onSaved, onToast }) {
  const preview = document.getElementById('avatarPreview');
  const controls = document.getElementById('avatarControls');

  let options = null;
  let avatar = { ...initial };

  function renderPreview() {
    preview.innerHTML = '';
    preview.append(buildAvatar(avatar, { scale: 0.38, anim: avatar.dance }));
  }

  /**
   * An avatar saved before a part existed has no value for it, which would
   * leave that dropdown blank. Anything the manifest does not offer falls back
   * to the first choice, and for the joke layers that is 'none'.
   */
  function fillGaps() {
    if (!options?.available) return;
    for (const [key] of LABELS) {
      const list = options[key];
      if (!Array.isArray(list) || list.length === 0) continue;
      if (!list.some((value) => String(value) === String(avatar[key]))) {
        avatar[key] = String(list[0]);
      }
    }
  }

  function renderControls() {
    controls.innerHTML = '';
    if (!options?.available) {
      controls.innerHTML =
        '<div class="empty">Avatar artwork is not installed. Run <code>npm run assets</code>.</div>';
      return;
    }

    fillGaps();
    const inCostume = Boolean(avatar.costume) && avatar.costume !== 'none';

    for (const [key, label] of LABELS) {
      const list = options[key];
      if (!Array.isArray(list) || list.length === 0) continue;

      const row = document.createElement('label');
      row.className = 'picker__row';
      const name = document.createElement('span');
      name.textContent = label;

      const select = document.createElement('select');
      for (const value of list) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = pretty(value);
        select.append(option);
      }
      select.value = String(avatar[key]);
      select.disabled = inCostume && COVERED_BY_COSTUME.has(key);
      row.classList.toggle('is-disabled', select.disabled);
      select.onchange = () => {
        avatar[key] = select.value;
        // Putting a costume on greys out the clothes it hides.
        if (key === 'costume') renderControls();
        renderPreview();
      };

      row.append(name, select);
      controls.append(row);
    }
  }

  function randomize() {
    if (!options?.available) return;
    for (const [key] of LABELS) {
      const list = options[key];
      if (Array.isArray(list) && list.length) {
        avatar[key] = String(list[Math.floor(Math.random() * list.length)]);
      }
    }
    renderControls();
    renderPreview();
  }

  document.getElementById('avatarRandom').onclick = randomize;

  document.getElementById('avatarSave').onclick = async () => {
    try {
      const response = await api.put('/api/auth/me/avatar', avatar);
      avatar = { ...response.avatar };
      renderControls();
      renderPreview();
      onSaved?.(avatar);
      onToast('Look saved');
    } catch (error) {
      onToast(error.message);
    }
  };

  return {
    async load() {
      options = await api.get('/api/avatars/options');
      renderControls();
      renderPreview();
    },
    set(next) {
      avatar = { ...next };
      renderControls();
      renderPreview();
    },
    /** For fields set elsewhere (the tempo), so saving a look keeps them. */
    patch(fields) {
      avatar = { ...avatar, ...fields };
      renderPreview();
    },
  };
}
