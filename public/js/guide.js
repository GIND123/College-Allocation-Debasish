// Behaviour shared by the counselling guide pages (served by server/guides.js).
import { track, toggleTheme } from './lib.js';

document.getElementById('rr-theme')?.addEventListener('click', toggleTheme);
track('pageview', { guide: document.documentElement.dataset.guide || '' });
