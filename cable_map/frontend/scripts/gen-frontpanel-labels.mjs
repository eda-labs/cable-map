import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelsDir = path.resolve(here, '../../operators/cable-map/frontpanel');
const output = path.resolve(here, '../src/generated/frontpanel-labels.json');
const check = process.argv.includes('--check');

const attr = (tag, name) => {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match?.[1] ?? match?.[2] ?? null;
};

function labelStyles(svg, file) {
  const scopes = [];
  const svgStack = [];
  let capture = null;

  for (const token of svg.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (!token.startsWith('<')) {
      if (capture) capture.text += token;
      continue;
    }
    if (/^<svg\b/i.test(token)) {
      svgStack.push({ ports: [], labels: [] });
      continue;
    }
    if (/^<\/svg\b/i.test(token)) {
      const scope = svgStack.pop();
      if (scope) scopes.push(scope);
      continue;
    }
    if (/^<text\b/i.test(token) && attr(token, 'data-added') === '1') {
      capture = { scope: svgStack.at(-1), text: '' };
      continue;
    }
    if (/^<\/text\b/i.test(token)) {
      if (capture?.scope) capture.scope.labels.push(capture.text.trim());
      capture = null;
      continue;
    }
    const port = attr(token, 'data-port');
    if (port && svgStack.length) svgStack.at(-1).ports.push(port);
  }

  const out = {};
  for (const scope of scopes) {
    const byPrefix = new Map();
    for (const port of scope.ports) {
      const parts = port.split('-');
      const number = parts.at(-1);
      const prefix = parts.length > 1 ? parts.slice(0, -1).join('-') : '';
      const group = byPrefix.get(prefix) ?? { numbers: new Set(), labels: new Set(scope.labels) };
      group.numbers.add(number);
      byPrefix.set(prefix, group);
    }
    for (const [prefix, group] of byPrefix) {
      let c = 0, bare = 0;
      for (const number of group.numbers) {
        if (group.labels.has(`c${number}`)) c += 1;
        if (group.labels.has(number)) bare += 1;
      }
      if (c === bare) continue;
      const style = c > bare ? 'c' : '';
      if (Object.hasOwn(out, prefix) && out[prefix] !== style) {
        throw new Error(`${file}: conflicting label styles for panel slot ${prefix || '(fixed)'}`);
      }
      out[prefix] = style;
    }
  }
  return out;
}

const result = {};
for (const file of fs.readdirSync(panelsDir).filter((name) => name.endsWith('.svg')).toSorted()) {
  const platform = file.slice(0, -4);
  const styles = labelStyles(fs.readFileSync(path.join(panelsDir, file), 'utf8'), file);
  if (Object.keys(styles).length) result[platform] = styles;
}

const text = `${JSON.stringify(result)}\n`;
if (check) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (current !== text) {
    console.error('frontpanel-labels.json is stale; run pnpm gen:frontpanel-labels');
    process.exit(1);
  }
} else {
  fs.writeFileSync(output, text);
  console.log(`wrote ${output} (${Object.keys(result).length} platforms)`);
}
