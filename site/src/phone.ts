// Phone checks in headless Chrome, one browser launch per call (DevTools protocol).
//   bun run site/src/phone.ts overflow <site dir or base URL> <profile dir> [page ...]
//     For each page, width (320, 360, 390, 430) and theme (light, dark): the page must not be wider
//     than the screen (documentElement.scrollWidth <= clientWidth), no element may stick out to the
//     right, and no box may scroll sideways except the grid matrix. Prints a table; exit 1 on a failure.
//   bun run site/src/phone.ts shot <profile dir> <out.png> <url> <width>x<height> <light|dark> [...]
//     Screenshots, four arguments per shot after the profile dir.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const WIDTHS = [320, 360, 390, 430];
export const PAGES = ['', 'leaderboard/', 'grid/', 'method/', 'limits/', 'auditor/', 'scenarios/D5/', 'updates/', 'data/'];

type Send = (method: string, params?: object) => Promise<any>;

async function withChrome<T>(profile: string, fn: (send: Send, waitLoad: () => Promise<void>) => Promise<T>): Promise<T> {
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(100);
    const [port] = readFileSync(portFile, 'utf8').split('\n');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const ws = new WebSocket(targets.find(t => t.type === 'page')!.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map<number, (v: any) => void>();
    let onLoad: (() => void) | null = null;
    ws.addEventListener('message', ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.error ? Promise.reject(new Error(m.error.message)) : m.result); pending.delete(m.id); }
      if (m.method === 'Page.loadEventFired' && onLoad) { onLoad(); onLoad = null; }
    });
    const send: Send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable');
    const waitLoad = () => new Promise<void>(r => { onLoad = r; setTimeout(r, 15000); });
    const out = await fn(send, waitLoad);
    ws.close();
    return out;
  } finally { proc.kill(); await Bun.sleep(300); }
}

async function view(send: Send, waitLoad: () => Promise<void>, url: string, w: number, h: number, theme: string) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  const loaded = waitLoad();
  await send('Page.navigate', { url });
  await loaded;
  await Bun.sleep(150);
}

const PROBE = `(() => {
  const d = document.documentElement, cw = d.clientWidth;
  const name = e => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
  const scrollers = [...document.querySelectorAll('body *')].filter(e => { const s = getComputedStyle(e); return (s.overflowX === 'auto' || s.overflowX === 'scroll') && e.offsetParent !== null; });
  const boxes = scrollers.filter(e => e.scrollWidth > e.clientWidth + 1 && !e.querySelector('table.matrix')).map(name);
  const inScroller = e => scrollers.some(s => s !== e && s.contains(e));
  const out = [...document.querySelectorAll('body *')].filter(e => { if (e.closest('.skip, .sr')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.right > cw + 1 && !inScroller(e); }).map(name);
  return JSON.stringify({ sw: d.scrollWidth, cw, out: [...new Set(out)].slice(0, 4), boxes: [...new Set(boxes)].slice(0, 4) });
})()`;

export async function overflow(site: string, profile: string, pages = PAGES) {
  const base = /^https?:/.test(site) ? site.replace(/\/?$/, '/') : `file://${resolve(site)}/`;
  const rows: { page: string; w: number; theme: string; ok: boolean; note: string }[] = [];
  await withChrome(profile, async (send, waitLoad) => {
    for (const p of pages) for (const theme of ['light', 'dark']) for (const w of WIDTHS) {
      await view(send, waitLoad, base + p + (base.startsWith('file:') ? 'index.html' : ''), w, 844, theme);
      const r = JSON.parse((await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value);
      const ok = r.sw <= r.cw && !r.out.length && !r.boxes.length;
      rows.push({ page: p || 'home', w, theme, ok, note: ok ? '' : `scrollWidth ${r.sw} > ${r.cw}; out: ${r.out.join(' ')}; boxes: ${r.boxes.join(' ')}` });
    }
  });
  return rows;
}

export async function shots(profile: string, list: { out: string; url: string; w: number; h: number; theme: string }[]) {
  await withChrome(profile, async (send, waitLoad) => {
    for (const s of list) {
      await view(send, waitLoad, s.url, s.w, s.h, s.theme);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(s.out, Buffer.from(r.data, 'base64'));
    }
  });
}

if (import.meta.main) {
  const [mode, ...a] = process.argv.slice(2);
  if (mode === 'overflow') {
    const [site, profile, ...pages] = a;
    const rows = await overflow(site!, profile!, pages.length ? pages : PAGES);
    const by = new Map<string, string[]>();
    for (const r of rows) { const k = `${r.page} ${r.theme}`; by.set(k, [...(by.get(k) ?? []), r.ok ? 'ok' : 'OVER']); }
    console.log(`${'page theme'.padEnd(34)}${WIDTHS.map(w => String(w).padStart(6)).join('')}`);
    for (const [k, v] of by) console.log(`${k.padEnd(34)}${v.map(x => x.padStart(6)).join('')}`);
    for (const r of rows.filter(r => !r.ok)) console.log(`${r.page} ${r.theme} ${r.w}: ${r.note}`);
    process.exit(rows.every(r => r.ok) ? 0 : 1);
  } else if (mode === 'shot') {
    const [profile, ...rest] = a;
    const list = [];
    for (let i = 0; i + 3 < rest.length; i += 4) { const [w, h] = rest[i + 2]!.split('x').map(Number); list.push({ out: rest[i]!, url: rest[i + 1]!, w: w!, h: h!, theme: rest[i + 3]! }); }
    await shots(profile!, list);
  } else { console.error('usage: phone.ts overflow <site> <profile> [pages] | shot <profile> (<out> <url> <WxH> <theme>)...'); process.exit(2); }
}
