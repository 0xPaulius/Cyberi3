// Icons for buttons built in JS. Markup written by hand uses the same sprite:
//   <svg class="ico" aria-hidden="true"><use href="/assets/img/icons.svg#name"/></svg>

const SPRITE = '/assets/img/icons.svg';
const VOTE_ART = { woot: '/assets/img/vote-woot-v1.png', meh: '/assets/img/vote-meh-v1.png' };

/** A stroke icon from the sprite, coloured by the surrounding text. */
export function icon(name, className = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${SPRITE}#${name}`);
  svg.append(use);
  return svg;
}

/** The rendered gel hands, for badges over dancers and in the history. */
export function voteArt(kind, className = 'vote-art') {
  const img = document.createElement('img');
  img.className = className;
  img.src = VOTE_ART[kind];
  img.alt = kind === 'woot' ? 'woot' : 'meh';
  img.draggable = false;
  return img;
}
