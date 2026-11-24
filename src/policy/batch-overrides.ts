// Batch-step replay overrides for the good references whose batching loops
// default deny rejects (#22; preregistration section 5). Each loop becomes one
// DML step per batch, in the loop's order, each its own transaction, with that
// batch's row count as expected_rows. L7 and R2 use 10,000-id batches instead
// of the loops' 20,000, so that no batch changes more than B rows (TS-7); R6
// keeps its 25,000-id batches, which stay under B.
//
// The counts come from env/seed.sql (the events and orders sections only) in a
// throwaway postgres:18 container, timezone UTC; no setup SQL changes these
// tables for L7, R2 or R6. The workload's q08 changes random orders' status,
// so R6's counts drift slightly during a lab run; L7 and R2 filter on rows the
// workload does not change.

type Loop = {
  /** Index of the loop step in the reference. */
  at: number;
  /** Ids per batch; batch i covers ids i*size+1 to (i+1)*size. */
  size: number;
  /** The batch statement for ids lo+1 to hi. */
  sql: (lo: number, hi: number) => string;
  /** Rows each batch matches in the seeded dataset, in order. */
  counts: number[];
};

const LOOPS: Record<string, Loop> = {
  "L7.good": {
    at: 2, size: 10000,
    sql: (lo, hi) => `UPDATE public.orders SET archived = true WHERE id > ${lo} AND id <= ${hi} AND created_at < '2026-01-01' AND NOT archived`,
    counts: [
    10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000,
    10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000,
    10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000,
    10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000,
    10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000,
    10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000,
    10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 5616,
    0, 0, 0, 0, 0, 0, 0, 0,
    ],
  },
  "R2.good": {
    at: 0, size: 10000,
    sql: (lo, hi) => `DELETE FROM public.events WHERE id > ${lo} AND id <= ${hi} AND created_at < '2026-08-01'`,
    counts: [
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000, 6000,
    6000, 1487, 0, 0,
    ],
  },
  "R6.good": {
    at: 1, size: 25000,
    sql: (lo, hi) => `UPDATE public.orders SET status = 'delivered' WHERE id > ${lo} AND id <= ${hi} AND status = 'shipped' AND created_at < '2026-09-01'`,
    counts: [
    4948, 5006, 4930, 4993, 4972, 5037, 5078, 5008, 4890, 4947, 4951, 4971,
    5108, 5024, 5027, 5092, 4978, 5102, 5028, 5016, 4893, 5085, 4951, 5017,
    5059, 4966, 4951, 4976, 4929, 5069, 4926, 4982, 4975, 4986, 4995, 4914,
    5003, 5041, 5100, 4921, 5022, 5088, 4981, 4925, 4895, 5036, 4990, 5062,
    4906, 4910, 5045, 4836, 4943, 4986, 5123, 4859, 4976, 5062, 5120, 4953,
    4944, 4959, 4960, 4978, 5020, 4953, 5037, 5095, 4952, 4961, 4891, 5019,
    4881, 5007, 4948, 5054, 5193, 4921, 4970, 4982, 5016, 5045, 4974, 4992,
    4912, 5089, 4965, 5012, 4917, 5062, 4999, 5088, 5036, 4968, 4947, 5062,
    4973, 4994, 4946, 5037, 4950, 4988, 5043, 4828, 5091, 5024, 4979, 4978,
    5021, 4968, 5004, 4997, 5093, 4839, 5021, 5061, 5018, 5048, 5022, 5146,
    4999, 4963, 4985, 4932, 5040, 5003, 5071, 5160, 5058, 4973, 5016, 4978,
    5101, 4951, 4979, 4953, 5085, 4968, 4914, 5085, 4961, 5111, 5080, 5056,
    4932, 5044, 5007, 4953, 4990, 4909, 4916, 5005, 5053, 4878, 5000, 5048,
    4992, 5057, 4977, 5020, 5104, 5064, 4964, 4999, 5006, 4927, 2817, 0,
    ],
  },
};

/**
 * A reference's steps with its batching loop written out as batch steps, and
 * why; undefined for a case with no batch override.
 */
export function writeOutLoop(id: string, steps: readonly unknown[]): { reason: string; steps: unknown[] } | undefined {
  const loop = LOOPS[id];
  if (!loop) return undefined;
  const expect = (steps[loop.at] as { expect?: unknown }).expect;
  const batches = loop.counts.map((rows, i) => ({
    sql: loop.sql(i * loop.size, (i + 1) * loop.size), expected_rows: rows, ...(expect ? { expect } : {}),
  }));
  return {
    reason: `Step ${loop.at}'s batching loop, which default deny rejects (ADR 0005), written out as ${batches.length} batch steps of ${loop.size} ids, each with its seeded row count (decided in #22).`,
    steps: [...steps.slice(0, loop.at), ...batches, ...steps.slice(loop.at + 1)],
  };
}
