// Normalizes the Kenney modular character pack into a predictable tree plus a
// manifest the client can turn into pickers.
//
// The pack's own naming is inconsistent (blueArm_long vs armWhite_long,
// blueShirt1 vs shirtYellow1, pantsTan_long vs legYellow_long), so parts are
// classified by keyword rather than by prefix.

import { mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [, , packDir, outDir] = process.argv;
if (!packDir || !outDir) {
  console.error('usage: build-avatars.mjs <extracted-pack-dir> <out-dir>');
  process.exit(1);
}

const PNG = path.join(packDir, 'PNG');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const trailingNumber = (s) => Number(s.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
const byNumber = (a, b) => trailingNumber(a) - trailingNumber(b);

async function dirs(p) {
  const entries = await readdir(p, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function pngs(p) {
  const entries = await readdir(p, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.png')).map((e) => e.name);
}

async function put(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
}

const warnings = [];
function expect(cond, message) {
  if (!cond) warnings.push(message);
}

// --- skin: tint1_head.png -> skin/1/head.png -------------------------------
async function buildSkin() {
  const tints = [];
  for (const dir of await dirs(path.join(PNG, 'Skin'))) {
    const src = path.join(PNG, 'Skin', dir);
    const files = await pngs(src);
    const tint = String(Number(dir.match(/(\d+)/)?.[1]));
    let parts = 0;
    for (const file of files) {
      const part = file.match(/_(head|neck|arm|hand|leg)\.png$/)?.[1];
      if (!part) continue;
      await put(path.join(src, file), path.join(outDir, 'skin', tint, `${part}.png`));
      parts += 1;
    }
    expect(parts === 5, `skin tint ${tint}: expected 5 parts, got ${parts}`);
    tints.push(tint);
  }
  return tints.sort((a, b) => Number(a) - Number(b));
}

// --- shirts: torso variants + sleeve overlays ------------------------------
async function buildShirts() {
  const colors = [];
  let torsoCount = 0;
  const sleeves = new Set();
  for (const dir of await dirs(path.join(PNG, 'Shirts'))) {
    const src = path.join(PNG, 'Shirts', dir);
    const color = slug(dir);
    const files = await pngs(src);
    const torsos = files.filter((f) => /shirt/i.test(f)).sort(byNumber);
    const arms = files.filter((f) => /arm/i.test(f));
    for (const [i, file] of torsos.entries()) {
      await put(path.join(src, file), path.join(outDir, 'shirt', color, `torso${i + 1}.png`));
    }
    for (const file of arms) {
      const len = file.match(/_(long|shorter|short)\.png$/)?.[1];
      if (!len) continue;
      sleeves.add(len);
      await put(path.join(src, file), path.join(outDir, 'shirt', color, `sleeve-${len}.png`));
    }
    expect(torsos.length > 0, `shirt ${color}: no torso found`);
    torsoCount = Math.max(torsoCount, torsos.length);
    colors.push(color);
  }
  return { colors, torsos: torsoCount, sleeves: [...sleeves] };
}

// --- pants: waist piece + trouser-leg overlays ----------------------------
async function buildPants() {
  const colors = [];
  let waistCount = 0;
  const legs = new Set();
  for (const dir of await dirs(path.join(PNG, 'Pants'))) {
    const src = path.join(PNG, 'Pants', dir);
    const color = slug(dir);
    const files = await pngs(src);
    const legFiles = files.filter((f) => /_(long|shorter|short)\.png$/.test(f));
    const waists = files.filter((f) => !/_(long|shorter|short)\.png$/.test(f)).sort(byNumber);
    for (const [i, file] of waists.entries()) {
      await put(path.join(src, file), path.join(outDir, 'pants', color, `waist${i + 1}.png`));
    }
    for (const file of legFiles) {
      const len = file.match(/_(long|shorter|short)\.png$/)[1];
      legs.add(len);
      await put(path.join(src, file), path.join(outDir, 'pants', color, `leg-${len}.png`));
    }
    expect(waists.length > 0, `pants ${color}: no waist piece found`);
    waistCount = Math.max(waistCount, waists.length);
    colors.push(color);
  }
  return { colors, waists: waistCount, legs: [...legs] };
}

async function buildShoes() {
  const colors = [];
  let styles = 0;
  for (const dir of await dirs(path.join(PNG, 'Shoes'))) {
    const src = path.join(PNG, 'Shoes', dir);
    const color = slug(dir);
    const files = (await pngs(src)).sort(byNumber);
    for (const [i, file] of files.entries()) {
      await put(path.join(src, file), path.join(outDir, 'shoes', color, `shoe${i + 1}.png`));
    }
    styles = Math.max(styles, files.length);
    colors.push(color);
  }
  return { colors, styles };
}

// --- hair: <color>Man<n>.png / <color>Woman<n>.png ------------------------
async function buildHair() {
  const colors = [];
  const styles = new Set();
  for (const dir of await dirs(path.join(PNG, 'Hair'))) {
    const src = path.join(PNG, 'Hair', dir);
    const color = slug(dir);
    for (const file of await pngs(src)) {
      const m = file.match(/(man|woman)(\d+)\.png$/i);
      if (!m) continue;
      const style = `${m[1].toLowerCase()}${Number(m[2])}`;
      styles.add(style);
      await put(path.join(src, file), path.join(outDir, 'hair', color, `${style}.png`));
    }
    colors.push(color);
  }
  const order = (s) => (s.startsWith('man') ? 0 : 1) * 100 + Number(s.match(/\d+/)[0]);
  return { colors, styles: [...styles].sort((a, b) => order(a) - order(b)) };
}

// --- face: eyes, brows, mouths, noses ------------------------------------
async function buildFace() {
  const face = path.join(PNG, 'Face');
  const eyeColors = new Set();
  const eyeSizes = new Set();
  for (const file of await pngs(path.join(face, 'Eyes'))) {
    const m = file.match(/^eye([A-Za-z0-9]+)_(large|small)\.png$/);
    if (!m) continue;
    const color = slug(m[1]);
    eyeColors.add(color);
    eyeSizes.add(m[2]);
    await put(path.join(face, 'Eyes', file), path.join(outDir, 'face', 'eyes', `${color}-${m[2]}.png`));
  }

  const browColors = new Set();
  let browStyles = 0;
  for (const file of await pngs(path.join(face, 'Eyebrows'))) {
    const m = file.match(/^([A-Za-z0-9]+?)Brow(\d+)\.png$/);
    if (!m) continue;
    const color = slug(m[1]);
    browColors.add(color);
    browStyles = Math.max(browStyles, Number(m[2]));
    await put(path.join(face, 'Eyebrows', file), path.join(outDir, 'face', 'brows', `${color}${Number(m[2])}.png`));
  }

  const mouths = [];
  for (const file of await pngs(path.join(face, 'Mouth'))) {
    const m = file.match(/^mouth_(\w+)\.png$/);
    if (!m) continue;
    mouths.push(m[1].toLowerCase());
    await put(path.join(face, 'Mouth', file), path.join(outDir, 'face', 'mouth', `${m[1].toLowerCase()}.png`));
  }

  let noseStyles = 0;
  for (const dir of await dirs(path.join(face, 'Nose'))) {
    const src = path.join(face, 'Nose', dir);
    for (const file of await pngs(src)) {
      const m = file.match(/^tint(\d+)Nose(\d+)\.png$/);
      if (!m) continue;
      noseStyles = Math.max(noseStyles, Number(m[2]));
      await put(path.join(src, file), path.join(outDir, 'face', 'nose', `${Number(m[1])}-${Number(m[2])}.png`));
    }
  }

  return {
    eyes: { colors: [...eyeColors].sort(), sizes: [...eyeSizes].sort() },
    brows: { colors: [...browColors].sort(), styles: browStyles },
    mouths: mouths.sort(),
    noses: noseStyles,
  };
}

const manifest = {
  available: true,
  generatedAt: new Date().toISOString(),
  source: {
    name: 'Kenney — Modular character pack',
    license: 'CC0 1.0 Universal (public domain)',
    url: 'https://opengameart.org/content/modular-character-pack',
  },
  skin: await buildSkin(),
  shirt: await buildShirts(),
  pants: await buildPants(),
  shoes: await buildShoes(),
  hair: await buildHair(),
  face: await buildFace(),
  dances: ['bob', 'sway', 'handsup', 'twist', 'jump', 'headbang'],
};

await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  path.join(outDir, 'CREDITS.txt'),
  [
    'Avatar artwork: "Modular character pack" by Kenney (kenney.nl)',
    'License: CC0 1.0 Universal — public domain, no attribution required.',
    'Source: https://opengameart.org/content/modular-character-pack',
    '',
    'Parts were re-cut into a normalized directory tree by scripts/build-avatars.mjs.',
    'The artwork itself is unmodified.',
    '',
  ].join('\n'),
);

for (const w of warnings) console.warn(`warning: ${w}`);
console.log(
  `avatars ready: ${manifest.skin.length} skin tints, ` +
    `${manifest.hair.colors.length}x${manifest.hair.styles.length} hair, ` +
    `${manifest.shirt.colors.length} shirt colors, ${manifest.pants.colors.length} pants colors, ` +
    `${manifest.shoes.colors.length} shoe colors`,
);
