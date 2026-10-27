ALTER TABLE products ADD COLUMN recommendation_mode TEXT NOT NULL DEFAULT 'auto_fill' CHECK(recommendation_mode IN ('auto_fill','manual_only'));
CREATE TABLE product_recommendations (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  recommended_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(product_id,recommended_product_id),
  CHECK(product_id<>recommended_product_id)
);
CREATE INDEX product_collections_collection ON product_collections(collection_id,product_id);
CREATE INDEX traffic_views_product_time ON traffic_views(viewed_at,product_id,visitor_hash);
