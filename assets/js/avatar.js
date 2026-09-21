// Builds the layered avatar rig.
//
// The rig is a set of nested full-stage layers ("bones"). Each bone has its
// transform-origin at a joint, so rotating the bone swings everything inside it
// while all artwork stays in one flat coordinate space (see assets/css/avatar.css).

const BASE = '/assets/avatars';
const EXTRAS = '/assets/avatar-extras';

export const DANCES = ['bob', 'sway', 'handsup', 'twist', 'jump', 'headbang'];
export const DJ_ANIMATIONS = ['scratch', 'mix', 'cue', 'hype'];
export const BPM = { min: 60, max: 300, default: 120 };

const part = {
  head: (a) => `${BASE}/skin/${a.skin}/head.png`,
  neck: (a) => `${BASE}/skin/${a.skin}/neck.png`,
  arm: (a) => `${BASE}/skin/${a.skin}/arm.png`,
  hand: (a) => `${BASE}/skin/${a.skin}/hand.png`,
  leg: (a) => `${BASE}/skin/${a.skin}/leg.png`,
  hair: (a) => `${BASE}/hair/${a.hairColor}/${a.hairStyle}.png`,
  shirt: (a) => `${BASE}/shirt/${a.shirtColor}/torso${a.shirtStyle}.png`,
  sleeve: (a) => `${BASE}/shirt/${a.shirtColor}/sleeve-${a.sleeve}.png`,
  waist: (a) => `${BASE}/pants/${a.pantsColor}/waist${a.pantsStyle}.png`,
  trouser: (a) => `${BASE}/pants/${a.pantsColor}/leg-${a.trouser}.png`,
  shoe: (a) => `${BASE}/shoes/${a.shoeColor}/shoe${a.shoeStyle}.png`,
  eye: (a) => `${BASE}/face/eyes/${a.eyeColor}-${a.eyeSize}.png`,
  brow: (a) => `${BASE}/face/brows/${a.browColor}${a.browStyle}.png`,
  mouth: (a) => `${BASE}/face/mouth/${a.mouth}.png`,
  nose: (a) => `${BASE}/face/nose/${a.skin}-${a.nose}.png`,
  hat: (a) => `${EXTRAS}/hat/${a.hat}.svg`,
  faceExtra: (a) => `${EXTRAS}/face/${a.faceExtra}.svg`,
  costumeBody: (a) => `${EXTRAS}/costume/${a.costume}/body.svg`,
  costumeWaist: (a) => `${EXTRAS}/costume/${a.costume}/waist.svg`,
  costumeSleeve: (a) => `${EXTRAS}/costume/${a.costume}/sleeve.svg`,
  costumeLeg: (a) => `${EXTRAS}/costume/${a.costume}/leg.svg`,
};

/** Nothing to draw for an explicit 'none', or for an avatar saved before the
 * part existed and so missing it entirely. */
const wearing = (value) => Boolean(value) && value !== 'none';

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function img(className, source) {
  const node = el('img', className);
  node.src = source;
  node.alt = '';
  node.draggable = false;
  return node;
}

function limb(side, avatar, kind, { costume = false } = {}) {
  // kind: 'arm' | 'leg'. The bone is what animations rotate.
  const root = el('div', `av__${kind} is-${side}`);
  const bone = el('div', `av__${kind}-bone`);

  if (kind === 'arm') {
    bone.append(img('av__arm-skin', part.arm(avatar)));
    // A costume brings its own sleeve, cut to the same outline. Where it wants
    // a bare arm, as the vest does, that file is simply empty.
    bone.append(
      img('av__arm-sleeve', costume ? part.costumeSleeve(avatar) : part.sleeve(avatar)),
    );
    const hand = el('div', 'av__hand');
    hand.append(img('av__hand-skin', part.hand(avatar)));
    bone.append(hand);
  } else {
    bone.append(img('av__leg-skin', part.leg(avatar)));
    bone.append(
      img('av__leg-trouser', costume ? part.costumeLeg(avatar) : part.trouser(avatar)),
    );
    const shoe = el('div', 'av__shoe');
    shoe.append(img('av__shoe-img', part.shoe(avatar)));
    bone.append(shoe);
  }

  root.append(bone);
  return root;
}

function head(avatar) {
  const root = el('div', 'av__head');
  root.append(img('av__head-skin', part.head(avatar)));

  const face = el('div', 'av__face');
  face.append(img('av__brow is-left', part.brow(avatar)));
  face.append(img('av__brow is-right', part.brow(avatar)));
  face.append(img('av__eye is-left', part.eye(avatar)));
  face.append(img('av__eye is-right', part.eye(avatar)));
  face.append(img('av__nose', part.nose(avatar)));
  face.append(img('av__mouth', part.mouth(avatar)));
  if (wearing(avatar.faceExtra)) face.append(img('av__face-extra', part.faceExtra(avatar)));
  root.append(face);

  root.append(img('av__hair', part.hair(avatar)));
  if (wearing(avatar.hat)) root.append(img('av__hat', part.hat(avatar)));
  return root;
}

/** Every animation duration in avatar.css is derived from this. */
export function setBpm(root, bpm) {
  const n = Number(bpm);
  root?.style.setProperty(
    '--av-bpm',
    String(Number.isFinite(n) && n > 0 ? Math.min(BPM.max, Math.max(BPM.min, n)) : BPM.default),
  );
}

/**
 * A glow at the feet and sparks rising through the figure, drawn entirely in
 * CSS. It sits under the body, so it never hides a face.
 */
function aura(avatar) {
  if (!wearing(avatar.aura)) return null;
  const root = el('div', `av__aura av__aura--${avatar.aura}`);
  root.append(el('i'), el('i'), el('i'));
  return root;
}

/** A plain shape used when the Kenney pack has not been downloaded. */
function fallback(avatar, scale) {
  const root = el('div', 'av av--fallback');
  root.style.setProperty('--av-scale', String(scale));
  setBpm(root, avatar?.bpm);
  root.dataset.anim = avatar?.dance || 'bob';
  root.innerHTML = `
    <div class="av__stage">
      <div class="av__body">
        <svg viewBox="0 0 420 620" class="av__fallback-art" aria-hidden="true">
          <circle cx="210" cy="120" r="88" fill="#f6d9b0"/>
          <rect x="132" y="212" width="156" height="200" rx="34" fill="#3a4a5f"/>
          <rect x="150" y="410" width="44" height="150" rx="20" fill="#2b3a4f"/>
          <rect x="226" y="410" width="44" height="150" rx="20" fill="#2b3a4f"/>
        </svg>
      </div>
    </div>`;
  return root;
}

/**
 * @param {object} avatar sanitized avatar config
 * @param {{scale?:number, anim?:string}} options scale is relative to the
 *   420x620 rig stage; anim matches a data-anim CSS block.
 */
export function buildAvatar(avatar, { scale = 0.3, anim } = {}) {
  if (!avatar?.skin) return fallback(avatar, scale);

  const root = el('div', 'av');
  root.style.setProperty('--av-scale', String(scale));
  setBpm(root, avatar.bpm);
  root.dataset.anim = anim ?? avatar.dance ?? 'bob';

  // Staggers the crowd so everyone is not on the same beat.
  root.style.setProperty('--av-offset', `${-(Math.random() * 2).toFixed(2)}s`);

  const stage = el('div', 'av__stage');
  const glow = aura(avatar);
  if (glow) stage.append(glow);
  const body = el('div', 'av__body');
  // A costume takes over the two clothing slots on the trunk.
  const costume = wearing(avatar.costume);

  const legs = el('div', 'av__legs');
  legs.append(limb('left', avatar, 'leg', { costume }), limb('right', avatar, 'leg', { costume }));
  body.append(legs);
  body.append(
    costume
      ? img('av__waist av__waist--costume', part.costumeWaist(avatar))
      : img('av__waist', part.waist(avatar)),
  );

  const torso = el('div', 'av__torso');
  // Shirt first: the arms paint over it, so a raised arm is not hidden behind
  // the torso and the sleeve reads as continuous with the body.
  torso.append(
    costume
      ? img('av__shirt av__shirt--costume', part.costumeBody(avatar))
      : img('av__shirt', part.shirt(avatar)),
  );
  torso.append(limb('left', avatar, 'arm', { costume }), limb('right', avatar, 'arm', { costume }));
  torso.append(img('av__neck', part.neck(avatar)));
  torso.append(head(avatar));
  body.append(torso);

  stage.append(body);
  root.append(stage);
  return root;
}

export function setAnimation(root, anim) {
  if (root) root.dataset.anim = anim;
}
