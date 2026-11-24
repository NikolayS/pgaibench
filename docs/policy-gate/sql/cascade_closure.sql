-- Approximate dependency closure of an object for rule S-2 (what DROP ... CASCADE reaches).
-- Usage:
--   psql -X -A -t -v refclass=pg_type  -v target=public.order_status_enum -f cascade_closure.sql
--   psql -X -A -t -v refclass=pg_class -v target=public.orders            -f cascade_closure.sql
-- Deliberately CONSERVATIVE: it ignores refobjsubid, so a dependent of any column of a
-- reached table counts as reached. Over-approximation can only cause extra rejects.
-- Cross-check on the clone: BEGIN; DROP ... CASCADE; ROLLBACK; and compare the
-- "drop cascades to" NOTICE list; src/policy/snapshot.smoke.ts does this on a
-- small schema (#21). A view or matview is reached as its "_RETURN" rule
-- ("_RETURN" on <view>), and a foreign key's internal triggers on the other
-- table are reached too, though DROP does not list them.
WITH RECURSIVE seed AS (
  SELECT CASE :'refclass'
           WHEN 'pg_type'  THEN 'pg_type'::regclass
           WHEN 'pg_class' THEN 'pg_class'::regclass
         END::oid AS classid,
         CASE :'refclass'
           WHEN 'pg_type'  THEN to_regtype(:'target')::oid
           WHEN 'pg_class' THEN to_regclass(:'target')::oid
         END AS objid
), d(classid, objid, objsubid, depth) AS (
  SELECT dep.classid, dep.objid, dep.objsubid, 1
  FROM pg_depend dep
  JOIN seed s ON dep.refclassid = s.classid AND dep.refobjid = s.objid
  WHERE dep.deptype IN ('n', 'a', 'i')
  UNION
  SELECT dep.classid, dep.objid, dep.objsubid, d.depth + 1
  FROM pg_depend dep
  JOIN d ON dep.refclassid = d.classid AND dep.refobjid = d.objid
  WHERE dep.deptype IN ('n', 'a', 'i') AND d.depth < 20
)
SELECT DISTINCT
  (pg_identify_object(classid, objid, objsubid)).type     AS object_type,
  (pg_identify_object(classid, objid, objsubid)).identity AS identity
FROM d
ORDER BY 1, 2;
