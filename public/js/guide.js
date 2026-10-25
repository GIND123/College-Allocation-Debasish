// Behaviour shared by the counselling guide pages (served by server/guides.js).
import { track, toggleTheme } from './lib.js';

document.getElementById('rr-theme')?.addEventListener('click', toggleTheme);
track('pageview', { guide: document.documentElement.dataset.guide || '' });

// A guide's own section links (Key dates, Eligibility…): the section being read is marked
// (aria-current + .rr-here) so the reader can see where they are.
const groups = new Map();
for (const a of document.querySelectorAll('a[href^="#"]')) {
  if (a.closest('[data-rr]')) continue;
  const target = a.hash.length > 1 && document.getElementById(decodeURIComponent(a.hash.slice(1)));
  if (!target) continue;
  const box = a.closest('nav, ul, ol, div');
  if (!groups.has(box)) groups.set(box, []);
  groups.get(box).push({ a, target });
}
const links = [...groups.values()].filter(g => g.length >= 3).flat();
if (links.length) {
  let queued = false;
  const mark = () => {
    queued = false;
    // The section whose top is the last one past the upper third of the screen.
    const line = innerHeight / 3;
    let on = null, best = -Infinity;
    for (const { target } of links) {
      const top = target.getBoundingClientRect().top;
      if (top <= line && top > best) { best = top; on = target; }
    }
    for (const { a, target } of links) {
      a.classList.toggle('rr-here', target === on);
      target === on ? a.setAttribute('aria-current', 'location') : a.removeAttribute('aria-current');
    }
  };
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(mark); } };
  addEventListener('scroll', later, { passive: true });
  addEventListener('resize', later);
  mark();
}
