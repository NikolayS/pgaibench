// G4 config assertions: GUC scope, restart context, read-back, hot standby
// ordering, memory.
import type { GuardrailFinding, GuardrailRule } from './types';
import { crStatements, parseBytes, parseDurationMs } from './sql';

/** GUCs with pg_settings.context = postmaster in PostgreSQL 18; used when ctx lacks setting_context. */
export const POSTMASTER_GUCS = new Set(['shared_buffers', 'max_connections', 'max_prepared_transactions', 'max_locks_per_transaction', 'max_pred_locks_per_transaction', 'max_worker_processes', 'max_wal_senders', 'max_replication_slots', 'wal_level', 'wal_buffers', 'shared_preload_libraries', 'huge_pages', 'port', 'listen_addresses', 'archive_mode', 'wal_log_hints', 'track_activity_query_size', 'max_files_per_process', 'superuser_reserved_connections', 'reserved_connections', 'hot_standby', 'io_method', 'autovacuum_worker_slots', 'shared_memory_type', 'wal_decode_buffer_size', 'track_commit_timestamp', 'max_logical_replication_workers', 'data_checksums']);
/** GUCs a hot standby requires to be >= the primary's value. */
export const HOT_STANDBY_GUCS = new Set(['max_connections', 'max_prepared_transactions', 'max_locks_per_transaction', 'max_worker_processes', 'max_wal_senders', 'wal_level']);
/** Session-terminating timeouts. Set cluster-wide they also hit maintenance, backup and monitoring sessions. */
export const GLOBAL_TIMEOUTS = new Set(['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'idle_session_timeout', 'transaction_timeout']);
const MIB = 1024 ** 2;
const LIMITS: Record<string, number> = { work_mem: 64 * MIB, maintenance_work_mem: 2048 * MIB };

export type Scope = 'cluster' | 'database' | 'role' | 'session';
export type ConfigChange = { step: number; name: string; value: string; node: 'primary' | 'standby' | 'both' | undefined; via: 'config' | 'alter system' | 'alter database' | 'alter role' | 'set'; scope: Scope };

const unq = (v: string) => v.trim().replace(/^'(.*)'$/, '$1');

/** Config changes of a CR with their scope: config steps and ALTER SYSTEM are cluster-wide. */
export function configChanges(cr: Parameters<GuardrailRule>[0]): ConfigChange[] {
  const out: ConfigChange[] = [];
  cr.steps.forEach((s, step) => { if ('config' in s) out.push({ step, name: s.config.name.toLowerCase(), value: s.config.value, node: s.node, via: 'config', scope: 'cluster' }); });
  for (const s of crStatements(cr)) {
    let m = /^alter system set (\S+) (?:=|to) (.+)$/.exec(s.text);
    if (m) { out.push({ step: s.step, name: m[1], value: unq(m[2]), node: undefined, via: 'alter system', scope: 'cluster' }); continue; }
    m = /^alter database \S+ set (\S+) (?:=|to) (.+)$/.exec(s.text);
    if (m) { out.push({ step: s.step, name: m[1], value: unq(m[2]), node: undefined, via: 'alter database', scope: 'database' }); continue; }
    m = /^alter (?:role|user) \S+(?: in database \S+)? set (\S+) (?:=|to) (.+)$/.exec(s.text);
    if (m) { out.push({ step: s.step, name: m[1], value: unq(m[2]), node: undefined, via: 'alter role', scope: 'role' }); continue; }
    m = /^set (?:session )?(?!local\b|transaction\b|role\b|session\b)(\S+) (?:=|to) (.+)$/.exec(s.text);
    if (m) out.push({ step: s.step, name: m[1], value: unq(m[2]), node: undefined, via: 'set', scope: 'session' });
  }
  return out.sort((a, b) => a.step - b.step);
}

/** true equal, false different, null undecidable without more facts. */
export function settingEquals(intended: string, actual: string, unit?: string): boolean | null {
  const a = intended.replace(/^'(.*)'$/, '$1').trim().toLowerCase(), b = actual.replace(/^'(.*)'$/, '$1').trim().toLowerCase();
  if (a === b) return true;
  const ba = parseBytes(a, unit), bb = parseBytes(b, unit);
  if (ba !== null && bb !== null) return ba === bb;
  const hasUnit = (v: string) => /[a-z]$/.test(v);
  if ((hasUnit(a) || unit === 'ms') && (hasUnit(b) || unit === 'ms')) {
    const da = parseDurationMs(a), db = parseDurationMs(b);
    if (da !== null && db !== null) return da === db;
  }
  if (/^-?[0-9.]+$/.test(a) && /^-?[0-9.]+$/.test(b)) return Number(a) === Number(b);
  if (/^[a-z_]+$/.test(a) && /^[a-z_]+$/.test(b)) return a === b || ({ on: 'true', true: 'on', off: 'false', false: 'off' } as Record<string, string>)[a] === b;
  return null;
}

export const g4: GuardrailRule = (cr, ctx, ev) => {
  for (const r of ['G4.restart_required', 'G4.standby_order', 'G4.global_timeout']) ev?.declare(r);
  ev?.declare('G4.pending_restart', ['pending_restart']);
  ev?.declare('G4.readback_mismatch', ['steps[i].setting_primary', 'steps[i].setting_standby']);
  ev?.declare('G4.standby_mismatch', ['steps[i].setting_primary', 'steps[i].setting_standby']);
  ev?.declare('G4.scoped_timeout', [], false);
  ev?.declare('G4.memory_budget', [], false);
  const out: GuardrailFinding[] = [];
  const add = (rule: string, step: number, severity: 'block' | 'warn', message: string, evidence: unknown) => out.push({ family: 'G4', rule, step_index: step, severity, message, evidence });
  const all = configChanges(cr);
  const changes = all.filter(c => c.scope === 'cluster');
  if (changes.length) for (const r of ['G4.restart_required', 'G4.standby_order', 'G4.global_timeout']) ev?.ran(r);
  const restartDocumented = cr.postconditions.some(p => /\brestart/i.test(p));
  const baseSettings = ctx.baseline?.settings ?? {};

  for (const c of all) {
    if (c.scope === 'session') continue;
    if (GLOBAL_TIMEOUTS.has(c.name) && parseDurationMs(c.value) !== 0 && !/^default$/i.test(c.value)) {
      if (c.scope === 'cluster') add('G4.global_timeout', c.step, 'block', `cluster-wide ${c.name} = ${c.value} (${c.via}): global timeouts kill legitimate jobs such as index builds, vacuum, backups and monitoring; set it on the application role`, { name: c.name, value: c.value, scope: c.scope, via: c.via });
      else add('G4.scoped_timeout', c.step, 'warn', `${c.scope}-scoped ${c.name} = ${c.value}: check that no maintenance, backup or monitoring session uses this ${c.scope}`, { name: c.name, value: c.value, scope: c.scope, via: c.via });
    }
    const limit = LIMITS[c.name];
    const unit = ctx.setting_units?.[c.name];
    const bytes = limit ? parseBytes(c.value, unit ?? 'kB') : null;
    if (limit && bytes !== null && bytes > limit) {
      const maxConn = ctx.max_connections ?? (Number(baseSettings.max_connections) || undefined);
      const workers = c.name === 'maintenance_work_mem' ? (Number(baseSettings.autovacuum_max_workers) || undefined) : maxConn;
      const total = workers !== undefined ? bytes * workers : null;
      const arithmetic = total !== null ? `${c.value} x ${workers} ${c.name === 'work_mem' ? 'max_connections' : 'autovacuum_max_workers'} = ${total} bytes${ctx.ram_bytes ? ` vs RAM ${ctx.ram_bytes} bytes (${(total / ctx.ram_bytes * 100).toFixed(0)}%)` : ''}` : `${c.value} per operation; worker count unknown`;
      const where = c.scope === 'cluster' ? 'cluster-wide' : `${c.scope}-scoped`;
      add('G4.memory_budget', c.step, 'warn', `${where} ${c.name} = ${c.value} exceeds ${limit / MIB} MiB: ${arithmetic}`, { name: c.name, scope: c.scope, bytes, limit_bytes: limit, multiplier: workers ?? null, total_bytes: total, ram_bytes: ctx.ram_bytes ?? null });
    }
  }

  changes.forEach((c, k) => {
    const context = ctx.setting_context?.[c.name] ?? (POSTMASTER_GUCS.has(c.name) ? 'postmaster' : undefined);
    if (context === 'postmaster' && (c.node === undefined || !restartDocumented)) {
      add('G4.restart_required', c.step, 'block', `${c.name} has context postmaster: the change needs an explicit node target and a documented restart`, { name: c.name, node: c.node ?? null, restart_documented: restartDocumented, context_source: ctx.setting_context?.[c.name] ? 'pg_settings' : 'static list' });
    }
    if (context === 'postmaster') ev?.need('G4.pending_restart', { pending_restart: ctx.pending_restart?.[c.name] !== undefined });
    if (ctx.pending_restart?.[c.name] === true && !changes.slice(k + 1).some(x => x.name === c.name)) {
      add('G4.pending_restart', c.step, 'block', `${c.name} still has pending_restart = true after rehearsal`, { name: c.name });
    }
    const rb = ctx.steps?.[c.step];
    const unit = ctx.setting_units?.[c.name];
    if (c.via === 'config') {
      const p = c.node !== 'standby', sb = c.node !== 'primary';
      ev?.need('G4.readback_mismatch', { 'steps[i].setting_primary': !p || rb?.setting_primary !== undefined, 'steps[i].setting_standby': !sb || rb?.setting_standby !== undefined });
      if (HOT_STANDBY_GUCS.has(c.name)) ev?.need('G4.standby_mismatch', { 'steps[i].setting_primary': rb?.setting_primary !== undefined, 'steps[i].setting_standby': rb?.setting_standby !== undefined });
    }
    const sides: ['primary' | 'standby', string | undefined][] = [['primary', rb?.setting_primary], ['standby', rb?.setting_standby]];
    for (const [side, actual] of sides) {
      if (actual === undefined || (c.node && c.node !== 'both' && c.node !== side)) continue;
      if (settingEquals(c.value, actual, unit) === false) add('G4.readback_mismatch', c.step, 'block', `${c.name} reads back as ${actual} on ${side}, intended ${c.value}`, { name: c.name, side, intended: c.value, actual, unit: unit ?? null });
    }
    if (HOT_STANDBY_GUCS.has(c.name)) {
      const standbyFirst = changes.slice(0, k).some(x => x.name === c.name && x.node !== 'primary');
      const old = Number(baseSettings[c.name]), neu = Number(c.value);
      const decrease = Number.isFinite(old) && Number.isFinite(neu) && neu < old;
      if (c.node === 'primary' && !standbyFirst && !decrease) add('G4.standby_order', c.step, 'block', `${c.name} is raised on the primary without setting the standby first; the hot standby stops replaying`, { name: c.name, value: c.value });
      if (rb?.setting_primary !== undefined && rb?.setting_standby !== undefined && settingEquals(rb.setting_primary, rb.setting_standby, unit) === false && !standbyFirst) {
        add('G4.standby_mismatch', c.step, 'block', `${c.name} differs between primary (${rb.setting_primary}) and standby (${rb.setting_standby})`, { name: c.name, primary: rb.setting_primary, standby: rb.setting_standby });
      }
    }
  });
  return out;
};
