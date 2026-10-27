ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN whatsapp_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN whatsapp_locale TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN whatsapp_updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN whatsapp_clicked_at TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verified_at TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN registration_profile_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1));
CREATE TABLE account_contact_permissions(
 user_id INTEGER NOT NULL REFERENCES users(id), customer_id INTEGER NOT NULL REFERENCES customers(id),
 channel TEXT NOT NULL CHECK(channel IN('whatsapp','email')),scope TEXT NOT NULL CHECK(scope IN('registration_service','email_marketing')),
 address TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('unknown','granted','declined','revoked')),
 source TEXT NOT NULL,version TEXT NOT NULL,locale TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,channel,scope,address)
);
CREATE TABLE account_permission_events(
 id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),customer_id INTEGER NOT NULL REFERENCES customers(id),
 channel TEXT NOT NULL,scope TEXT NOT NULL,address TEXT NOT NULL,state TEXT NOT NULL,
 source TEXT NOT NULL,version TEXT NOT NULL,locale TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX idx_account_permissions_customer ON account_contact_permissions(customer_id,channel,scope,address,state);
CREATE INDEX idx_account_permission_history ON account_permission_events(customer_id,id);
