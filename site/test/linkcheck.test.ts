import { describe, expect, test } from 'bun:test';
import { checkLinks } from '../src/linkcheck';
import { buildSite } from '../src/build';
import { join } from 'node:path';

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe('link checker', () => {
  test('passes on a good site', () => {
    const files = new Map([['index.html', page('<a href="/b/a/">a</a><a href="/b/a/#x">x</a><a href="#top" id="top">t</a>')], ['a/index.html', page('<h2 id="x">X</h2>')]]);
    expect(checkLinks(files, '/b/')).toEqual([]);
  });
  test('finds a missing page, a missing anchor, a link outside the base and a bad URL', () => {
    const files = new Map([['index.html', page('<a href="/b/nope/">n</a><a href="/b/#gone">g</a><a href="/other/">o</a><a href="https://exa mple.com">u</a><img src="/b/assets/x.png">')]]);
    const errs = checkLinks(files, '/b/');
    expect(errs.length).toBe(5);
  });
  test('the built site has no broken links for both base paths', () => {
    for (const base of ['/', '/pgaibench/']) expect(checkLinks(buildSite({ published: false, base }), base)).toEqual([]);
  });
  test('the published fixture site has no broken links', () => {
    const fx = (f: string) => join(import.meta.dir, 'fixtures', f);
    expect(checkLinks(buildSite({ published: true, base: '/', resultsPath: fx('results/results.json'), frozenPath: fx('frozen.example.json') }), '/')).toEqual([]);
  });
});
