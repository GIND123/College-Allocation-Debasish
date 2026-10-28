// Unit tests for the counselling-guide frame (server/guides.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { registry, guideList, guidePage, roadmap, followSiteTheme, siteFonts } from '../server/guides.js';

test('the registry lists every guide with a valid region and file', () => {
  const { guides } = registry();
  assert.ok(guides.length >= 13);
  assert.equal(new Set(guides.map(g => g.slug)).size, guides.length, 'slugs are unique');
  for (const g of guideList()) assert.equal('file' in g, false, `${g.slug}: file names stay private`);
  for (const s of ['bihar', 'madhya-pradesh', 'maharashtra', 'rajasthan', 'rims-imphal', 'tamil-nadu-dnb', 'deemed-seats',
    'chhattisgarh', 'dadra-nagar-haveli', 'puducherry', 'uttar-pradesh', 'uttarakhand', 'uttarakhand-seats'])
    assert.ok(guides.some(g => g.slug === s), `${s} is listed`);
});

test('the counselling roadmap has dated stages in order', () => {
  const { stages } = roadmap();
  assert.ok(stages.length >= 5);
  stages.forEach((s, i) => {
    assert.ok(s.name && s.detail && Date.parse(s.from) <= Date.parse(s.to), `${s.name}: dates`);
    if (i) assert.ok(Date.parse(stages[i - 1].to) <= Date.parse(s.from), `${s.name}: follows ${stages[i - 1].name}`);
  });
});

test('dark rules that only follow the OS also follow the site switch', () => {
  const out = followSiteTheme('@media (prefers-color-scheme: dark){ :root{--bg:#000} .x, html body .y{color:red} }');
  assert.match(out, /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{--bg:#000\}/);
  assert.match(out, /:root\[data-theme="dark"\]\{--bg:#000\}/);
  assert.match(out, /:root\[data-theme="dark"\] \.x, html\[data-theme="dark"\] body \.y\{color:red\}/);
});

test('rules already aware of the site switch are left alone', () => {
  const css = '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#000}} @media (max-width:600px){.x{a:1}}';
  assert.equal(followSiteTheme(css), css);
});

test("a guide's own web fonts are swapped for RankRound's, and nothing else changes", () => {
  assert.equal(siteFonts('body{font:16px/1.55 Inter,system-ui}'), 'body{font:16px/1.55 Geist,system-ui}');
  assert.equal(siteFonts('b{font-family:Fraunces,Georgia,serif}'), 'b{font-family:"Source Serif 4",Georgia,serif}');
  assert.equal(siteFonts('p{content:"Interactive";font-family:"IBM Plex Mono"}'), 'p{content:"Interactive";font-family:"Geist Mono"}');
  assert.equal(siteFonts(':root{--display:"Archivo",Arial,sans-serif;--note:"Inter-state"}'), ':root{--display:Geist,Arial,sans-serif;--note:"Inter-state"}');
});

test('every guide page gets the RankRound frame without breaking the guide', () => {
  for (const { slug } of guideList()) {
    const html = guidePage(slug);
    assert.ok(html.includes(`data-guide="${slug}"`), `${slug}: tagged`);
    assert.equal(html.match(/<title>[^<]*<\/title>/)?.[0], '<title>RankRound</title>', `${slug}: the tab title is the brand only`);
    assert.ok(html.includes('class="rr-top"') && html.includes('class="rr-guidebar"') && html.includes('class="rr-foot"'), `${slug}: frame`);
    assert.ok(html.includes('/css/guide.css') && html.includes('/js/guide.js'), `${slug}: frame assets`);
    assert.match(html, /<div class="rr-nav"[^>]*>\s*<a href="\/predict">Intelligent prediction<\/a>\s*<a href="\/counselling" aria-current="page">Counselling guide<\/a>\s*<a href="\/method">Method<\/a>/, `${slug}: the three main tabs`);
    // The theme script must not leave globals behind: the DNB guide declares its own `t`.
    assert.ok(html.includes('<script>(function(){try{var t='), `${slug}: theme script is wrapped`);
    const fonts = html.match(/fonts\.googleapis\.com\/css2\?family=[\w+]+/g) || [];
    assert.deepEqual(fonts, ['fonts.googleapis.com/css2?family=Geist'], `${slug}: only RankRound's fonts load`);
    assert.equal(/data:[\w.+-]+\/[\w.+-]+(;[\w=-]+)*;base64,/.test(html), false, `${slug}: no files embedded in the page`);
  }
});

test('an unknown guide gives null', () => {
  assert.equal(guidePage('nowhere'), null);
});
