import { stripSqlComments } from './patterns';

/* Canonical text of one SQL step, used only for pattern matching
   (scenarios/patterns.ts renderSteps). Equivalent spellings of the same
   statement become one text, so a scenario pattern needs only one form:
   - comments removed, whitespace collapsed, lower case outside literals;
   - simple quoted identifiers unquoted ("orders" -> orders);
   - the public. schema prefix removed;
   - typed literals and casts on literals reduced to the literal
     (timestamptz '2026-01-01', '2026-01-01'::timestamptz, cast(... as ...));
   - ONLY after UPDATE / DELETE FROM / ALTER TABLE / TRUNCATE / LOCK / FROM / JOIN removed;
   - the table alias of UPDATE and DELETE removed (update orders as o set);
   - USING btree (the default method) in CREATE INDEX removed;
   - SET SESSION reduced to SET (SET LOCAL stays: it means something else).
   String literals keep their exact text. Dollar-quoted bodies (DO blocks)
   are normalised the same way, recursively. */

const LIT = '\u0001(\\d+)\u0002';
const NAME = '(?:[a-z_][\\w$]*\\.)?[a-z_][\\w$]*';
const TYPE = '(?:timestamptz|timestamp(?:\\s*\\(\\d+\\))?(?:\\s+with(?:out)?\\s+time\\s+zone)?|timetz|time(?:\\s+with(?:out)?\\s+time\\s+zone)?|date|interval|text|varchar|character\\s+varying|uuid|bigint|integer|smallint|int[248]?|numeric|boolean|bool|jsonb|json)';

export function normalizeSql(sql: string): string {
  const src = stripSqlComments(sql);
  const kept: string[] = [];
  const hold = (s: string) => { kept.push(s); return `\u0001${kept.length - 1}\u0002`; };
  let code = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const dollar = c === '$' ? /^\$[A-Za-z_]*\$/.exec(src.slice(i)) : null;
    if (c === "'") {
      const escapes = /[eE]$/.test(code) && !/[\w$][eE]$/.test(code);
      let j = i + 1;
      for (; j < src.length; j++) {
        if (escapes && src[j] === '\\') { j++; continue; }
        if (src[j] === "'") { if (src[j + 1] === "'") { j++; continue; } break; }
      }
      code += hold(src.slice(i, j + 1));
      i = j + 1;
    } else if (c === '"') {
      const end = src.indexOf('"', i + 1);
      const stop = end < 0 ? src.length : end;
      const body = src.slice(i + 1, stop);
      code += /^[A-Za-z_][A-Za-z0-9_$]*$/.test(body) ? body.toLowerCase() : hold(src.slice(i, stop + 1));
      i = stop + 1;
    } else if (dollar) {
      const tag = dollar[0];
      const end = src.indexOf(tag, i + tag.length);
      const body = normalizeSql(src.slice(i + tag.length, end < 0 ? src.length : end));
      code += hold(body ? `${tag} ${body} ${tag}` : `${tag}${tag}`);
      i = end < 0 ? src.length : end + tag.length;
    } else {
      code += c.toLowerCase();
      i++;
    }
  }
  const t = code.replace(/\s+/g, ' ').trim()
    .replace(/\bpublic\s*\.\s*(?=[a-z_])/g, '')
    .replace(new RegExp(`\\bcast\\s*\\(\\s*(${LIT})\\s+as\\s+${TYPE}\\s*\\)`, 'g'), '$1')
    .replace(new RegExp(`(${LIT})\\s*::\\s*${TYPE}(?:\\s*\\[\\])?(?![\\w$])`, 'g'), '$1')
    .replace(new RegExp(`(?<![\\w$.])${TYPE}\\s+(${LIT})`, 'g'), '$1')
    .replace(/\b(update|delete from|alter table(?: if exists)?|truncate(?: table)?|lock(?: table)?|from|join) only\b ?/g, '$1 ')
    .replace(new RegExp(`\\bupdate (${NAME}) (?:as )?(?!set\\b)[a-z_][\\w$]* set\\b`, 'g'), 'update $1 set')
    .replace(new RegExp(`\\bdelete from (${NAME}) (?:as )?(?!where\\b|using\\b|returning\\b)[a-z_][\\w$]*(?=\\s*(?:where\\b|using\\b|returning\\b|;|$))`, 'g'), 'delete from $1')
    .replace(new RegExp(`\\b(on ${NAME}) using btree ?\\(`, 'g'), '$1 (')
    .replace(/\bset session (?!characteristics\b|authorization\b)/g, 'set ')
    .replace(/ {2,}/g, ' ');
  return t.replace(new RegExp(LIT, 'g'), (_, n) => kept[Number(n)]);
}
