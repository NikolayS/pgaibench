-- What DROP ... CASCADE of one object drops, for rule S-2: the objects
-- Postgres names in its "drop cascades to" notice.
-- Usage:
--   psql -X -A -t -v refclass=pg_type  -v target=public.order_status_enum -f cascade_closure.sql
--   psql -X -A -t -v refclass=pg_class -v target=public.orders            -f cascade_closure.sql
-- Postgres drops three kinds of dependents. Normal ('n') dependents are what
-- CASCADE is for, and the notice lists them. Auto ('a') and internal ('i')
-- dependents are parts of the object they depend on (a table's indexes, a
-- view's "_RETURN" rule, a foreign key's RI triggers) and go silently with it.
-- So we walk every 'n', 'a' and 'i' edge, as Postgres does. Reaching an
-- internal part from outside its owner reaches the owner too, and what
-- depends on it (a view on a view). A dependent of a column is reached only
-- when that column or its whole table is. We report the objects reached
-- through an 'n' edge and through no 'a' or 'i' edge (a table's CHECK
-- constraint depends normally on its columns, but is part of the table), each
-- as the object it is internal to (a "_RETURN" rule as its view).
-- src/policy/snapshot.smoke.ts checks the result against the notice on
-- Postgres 18 (#21, #42).
WITH RECURSIVE seed AS (
  SELECT CASE :'refclass'
           WHEN 'pg_type'  THEN 'pg_type'::regclass
           WHEN 'pg_class' THEN 'pg_class'::regclass
         END::oid AS classid,
         CASE :'refclass'
           WHEN 'pg_type'  THEN to_regtype(:'target')::oid
           WHEN 'pg_class' THEN to_regclass(:'target')::oid
         END AS objid
), edge(pclassid, pobjid, psubid, classid, objid, objsubid, deptype, up) AS (
  -- Down: a dependent of the object. Up: an internal part leads to its owner,
  -- which Postgres drops in its place (a view, for its "_RETURN" rule), with
  -- everything that depends on the owner.
  SELECT refclassid, refobjid, refobjsubid, classid, objid, objsubid, deptype, false
  FROM pg_depend WHERE deptype IN ('n', 'a', 'i')
  UNION ALL
  SELECT classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype, true
  FROM pg_depend WHERE deptype = 'i'
), d(classid, objid, objsubid, deptype, depth) AS (
  SELECT e.classid, e.objid, e.objsubid, e.deptype, 1
  FROM edge e
  JOIN seed s ON e.pclassid = s.classid AND e.pobjid = s.objid AND NOT e.up
  UNION
  -- An owner is reached the way its part was. A part reached through an
  -- internal edge was reached from its owner, so we do not step back up.
  SELECT e.classid, e.objid, e.objsubid, CASE WHEN e.up THEN d.deptype ELSE e.deptype END, d.depth + 1
  FROM edge e
  JOIN d ON e.pclassid = d.classid AND e.pobjid = d.objid
        AND (CASE WHEN e.up THEN e.psubid = d.objsubid AND d.deptype <> 'i'
                  ELSE d.objsubid = 0 OR e.psubid = d.objsubid END)
  WHERE d.depth < 20
), owner(classid, objid, objsubid) AS (
  -- Each object reached only through normal dependencies, then up its chain
  -- of internal dependencies to the object that owns it.
  SELECT DISTINCT classid, objid, objsubid FROM d n
  WHERE n.deptype = 'n'
    AND NOT EXISTS (SELECT 1 FROM d p WHERE p.classid = n.classid AND p.objid = n.objid
                    AND p.objsubid = n.objsubid AND p.deptype IN ('a', 'i'))
  UNION
  SELECT dep.refclassid, dep.refobjid, dep.refobjsubid
  FROM owner o
  JOIN pg_depend dep ON dep.classid = o.classid AND dep.objid = o.objid
                    AND dep.objsubid = o.objsubid AND dep.deptype = 'i'
)
SELECT DISTINCT
  (pg_identify_object(o.classid, o.objid, o.objsubid)).type     AS object_type,
  (pg_identify_object(o.classid, o.objid, o.objsubid)).identity AS identity
FROM owner o
WHERE NOT EXISTS (
  SELECT 1 FROM pg_depend dep
  WHERE dep.classid = o.classid AND dep.objid = o.objid
    AND dep.objsubid = o.objsubid AND dep.deptype = 'i')
ORDER BY 1, 2;
