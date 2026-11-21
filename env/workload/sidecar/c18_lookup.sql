\set o random(1, 2000000)
\set c 1 + :o % 50000
select status, fee, created_at from public.shipments where shipment_id = :o and customer_id = :c;
