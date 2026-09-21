// Loads the avatar manifest produced by scripts/build-avatars.mjs and validates
// avatar choices, so a client can never point the renderer at a missing file.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve('assets/avatars/manifest.json');
const extrasDir = path.resolve('assets/avatar-extras');

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  manifest = { available: false, dances: ['bob', 'sway', 'handsup', 'twist', 'jump', 'headbang'] };
  console.warn(
    'assets/avatars/manifest.json missing — run "npm run assets". Falling back to simple avatars.',
  );
}

export const avatarManifest = manifest;

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

/**
 * The joke layers are hand-drawn SVGs kept in the repo rather than parts of the
 * Kenney pack, so they are read off disk instead of out of the manifest. That
 * keeps them out of the asset build entirely: dropping a file in the directory
 * is all it takes to add one.
 *
 * Hats and face extras are single files; a costume is a directory holding the
 * torso and hip pieces that replace a shirt and trousers.
 */
function extras(kind, { asDirectories = false } = {}) {
  let entries;
  try {
    entries = readdirSync(path.join(extrasDir, kind), { withFileTypes: true });
  } catch {
    return ['none'];
  }

  const names = entries
    .filter((entry) => (asDirectories ? entry.isDirectory() : entry.name.endsWith('.svg')))
    .map((entry) => entry.name.replace(/\.svg$/, ''))
    .sort();

  // Wearing nothing is always an option, and always the default.
  return ['none', ...names];
}

const extraOptions = {
  costume: extras('costume', { asDirectories: true }),
  hat: extras('hat'),
  faceExtra: extras('face'),
  // Pure CSS, so there is no file to discover: see .av__aura in avatar.css.
  aura: ['none', 'frost', 'ember', 'void', 'holy'],
};

/**
 * How fast the avatar dances. Everyone in the room sees it. Below 60 reads as
 * frozen; the top end is speedcore territory, deliberately past what a human
 * can move to, because a floor of blurred avatars is the joke.
 */
export const BPM = { min: 60, max: 300, default: 120 };

/** The BPM as an integer inside the range, or null for anything else. */
export function clampBpm(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(BPM.max, Math.max(BPM.min, n));
}

/** The choices a user can make, as flat option lists the picker can render. */
export function avatarOptions() {
  if (!manifest.available) return { available: false, dances: manifest.dances };
  return {
    available: true,
    skin: manifest.skin,
    hairColor: manifest.hair.colors,
    hairStyle: manifest.hair.styles,
    shirtColor: manifest.shirt.colors,
    shirtStyle: range(manifest.shirt.torsos),
    sleeve: manifest.shirt.sleeves,
    pantsColor: manifest.pants.colors,
    pantsStyle: range(manifest.pants.waists),
    trouser: manifest.pants.legs,
    shoeColor: manifest.shoes.colors,
    shoeStyle: range(manifest.shoes.styles),
    eyeColor: manifest.face.eyes.colors,
    eyeSize: manifest.face.eyes.sizes,
    browColor: manifest.face.brows.colors,
    browStyle: range(manifest.face.brows.styles),
    mouth: manifest.face.mouths,
    nose: range(manifest.face.noses),
    ...extraOptions,
    dance: manifest.dances,
  };
}

export function randomAvatar() {
  const o = avatarOptions();
  if (!o.available) return { dance: pick(o.dances), bpm: BPM.default };
  return {
    bpm: BPM.default,
    skin: pick(o.skin),
    hairColor: pick(o.hairColor),
    hairStyle: pick(o.hairStyle),
    shirtColor: pick(o.shirtColor),
    shirtStyle: pick(o.shirtStyle),
    sleeve: 'long',
    pantsColor: pick(o.pantsColor),
    pantsStyle: pick(o.pantsStyle),
    trouser: 'long',
    shoeColor: pick(o.shoeColor),
    shoeStyle: pick(o.shoeStyle),
    eyeColor: pick(o.eyeColor),
    eyeSize: 'large',
    browColor: pick(o.browColor),
    browStyle: pick(o.browStyle),
    mouth: pick(o.mouth),
    nose: pick(o.nose),
    // The joke layers are opt-in. This doubles as the fallback for any part a
    // saved avatar is missing, so randomising them here would quietly put a
    // traffic cone on everyone who signed up before they existed.
    costume: 'none',
    hat: 'none',
    faceExtra: 'none',
    aura: 'none',
    dance: pick(o.dance),
  };
}

/**
 * Keeps only values the manifest actually offers, filling the rest from a
 * random avatar. Numbers arrive from JSON as numbers or strings, so compare
 * loosely against the option list.
 */
export function sanitizeAvatar(input) {
  const options = avatarOptions();
  const fallback = randomAvatar();
  if (!options.available) {
    return {
      dance: options.dances.includes(input?.dance) ? input.dance : fallback.dance,
      bpm: clampBpm(input?.bpm) ?? fallback.bpm,
    };
  }

  const result = { bpm: clampBpm(input?.bpm) ?? fallback.bpm };
  for (const [key, allowed] of Object.entries(options)) {
    if (key === 'available' || !Array.isArray(allowed)) continue;
    const value = input?.[key];
    const match = allowed.find((option) => String(option) === String(value));
    result[key] = match ?? fallback[key];
  }
  return result;
}
