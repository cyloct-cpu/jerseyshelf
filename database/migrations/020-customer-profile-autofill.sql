ALTER TABLE customers ADD COLUMN mobile TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN registration_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN auto_profile TEXT NOT NULL DEFAULT '{}';
ALTER TABLE customers ADD COLUMN profile_overrides TEXT NOT NULL DEFAULT '{}';
-- Preserve existing merchant edits when adopting automatic profile sync.
UPDATE customers SET profile_overrides=json_object(
 'name',CASE WHEN name!='' THEN 1 ELSE 0 END,
 'phone',CASE WHEN phone!='' THEN 1 ELSE 0 END,
 'country',CASE WHEN country!='' THEN 1 ELSE 0 END
) WHERE EXISTS(SELECT 1 FROM customer_events e WHERE e.customer_id=customers.id AND e.kind='profile');
CREATE INDEX idx_customer_orders_latest ON orders(customer_id,created_at DESC);

UPDATE customers SET registration_phone=phone WHERE phone!='' AND EXISTS(SELECT 1 FROM users u WHERE u.customer_id=customers.id AND u.role='customer') AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.customer_id=customers.id);
