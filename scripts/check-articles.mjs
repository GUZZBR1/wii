// Verify that the build bundles the site articles and their figures. An empty
// import.meta.glob is valid, so a green build alone can hide missing articles.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const siteDir = join(new URL('.', import.meta.url).pathname, '..');
const researchDir = join(siteDir, 'docs/research');
const portugueseArticlesDir = join(siteDir, 'src/data/articles-pt');
const portugueseFiguresDir = join(portugueseArticlesDir, 'figures');
const englishFiguresDir = join(researchDir, 'figures/en');
const bundle = readdirSync(join(siteDir, 'dist/assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(siteDir, 'dist/assets', f), 'utf8'))
  .join('\n');

const titleOf = (path) => {
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith('# '));
  return line ? line.slice(2).trim() : null;
};

const missing = [];
const check = (name, haystack) => { if (!bundle.includes(haystack)) missing.push(name); };

const pt = readdirSync(portugueseArticlesDir).filter((f) => /^\d\d-.*\.md$/.test(f));
const en = readdirSync(join(siteDir, 'src/data/articles-en')).filter((f) => f.endsWith('.md'));
if (pt.length === 0) missing.push('no Portuguese articles in src/data/articles-pt');
if (en.length === 0) missing.push('no English articles in src/data/articles-en');
for (const f of pt) check(`Portuguese article ${f}`, titleOf(join(portugueseArticlesDir, f)) ?? f);
for (const f of en) check(`English article ${f}`, titleOf(join(siteDir, 'src/data/articles-en', f)) ?? f);

for (const [label, dir, bundlePath] of [
  ['Portuguese', portugueseFiguresDir, '../data/articles-pt/figures'],
  ['English', englishFiguresDir, '../../docs/research/figures/en'],
]) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
    check(`${label} figure ${f}`, `${bundlePath}/${f}`);
  }
}

if (missing.length) {
  console.error(`Build is missing ${missing.length} expected item(s):`);
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}
console.log(`OK: ${pt.length} Portuguese articles, ${en.length} English articles, and all figures are bundled.`);
