import { z } from 'zod';
import { parseThreshold } from './threshold';

export const metricNameSchema = z.string().regex(/^(?:p99_ms|p99_rel|tps|tps_post|replication_lag_s|max_replication_lag_s|standby_cancellations|lockmanager_share|lockmanager_count|post_wait_samples|max_lock_wait_s|io_util_pct|oom_kills|server_version|downtime_s|checkpoints_req_share|checkpoints_window_count|recovery_test|backup_verify|setting_changed:work_mem_or_shared_buffers|lever_applied:prepared_part_or_max_locks|shape_(?:mean|p50|post_p50)_ms:q\d{2}|(?:dead_tuples|table_exists|table_partitioned|index_valid|checksum|rowcount|setting):[A-Za-z_][A-Za-z0-9_.]*)$/);
const text = z.string().trim().min(1);
const threshold = z.string().refine(value => { try { parseThreshold(value); return true; } catch { return false; } }, 'Invalid threshold expression');
const expectations = z.record(metricNameSchema, threshold);
export const crSchema = z.object({
  id: text, task: text,
  claims: z.array(z.object({ text, verify_sql: text, expect: z.string().min(1) }).strict()),
  steps: z.array(z.union([
    // retries: rerun the step after 1 s, only on lock_not_available (55P03) or a lock-timeout cancel.
    z.object({ sql: z.string().refine(s => s.trim().length > 0), expected_rows: z.number().int().nonnegative().optional(), retries: z.number().int().min(1).max(10).optional(), expect: expectations }).strict(),
    // An omitted node targets both nodes, matching the existing Actor behavior.
    z.object({ config: z.object({ name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/), value: z.string() }).strict(), node: z.enum(['primary', 'standby', 'both']).optional(), expect: expectations }).strict(),
    z.object({ shell: z.literal('env/upgrade.sh'), expect: expectations }).strict(),
  ])).min(1),
  rehearsal: z.object({ workload: z.enum(['W_prod', 'W_prod-subset-A', 'W_prod-subset-B', 'synthetic-light']), minutes: z.number().positive().finite(), metrics: z.array(metricNameSchema), thresholds: expectations }).strict(),
  rollback: z.array(z.string().refine(s => s.trim().length > 0)).min(1),
  postconditions: z.array(text),
  risk: z.object({ class_guess: text, blast_radius: text }).strict(),
}).strict().superRefine((cr, ctx) => {
  cr.steps.forEach((step, index) => {
    if ('shell' in step && cr.task !== 'T5') ctx.addIssue({ code: 'custom', path: ['steps', index, 'shell'], message: 'env/upgrade.sh is allowed only for T5' });
  });
});
export const CRSchema = crSchema;
export function validateCR(value: unknown) { return crSchema.parse(value); }
