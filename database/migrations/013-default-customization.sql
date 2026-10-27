ALTER TABLE products ADD COLUMN customization_mode TEXT NOT NULL DEFAULT 'inherit' CHECK(customization_mode IN ('inherit','custom'));
ALTER TABLE products ADD COLUMN customization_template TEXT NOT NULL DEFAULT 'auto' CHECK(customization_template IN ('auto','club','national'));
-- Existing explicit settings, including deliberately disabled options, remain independent.
UPDATE products SET customization_mode='custom' WHERE json_valid(customization) AND EXISTS(SELECT 1 FROM json_each(customization));
