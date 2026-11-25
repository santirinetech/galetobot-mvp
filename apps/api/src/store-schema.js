export function initializeStoreSchema(db) {
    const additions = {
        products: { description: "TEXT NOT NULL DEFAULT ''", category: "TEXT NOT NULL DEFAULT ''", image_url: "TEXT NOT NULL DEFAULT ''" },
        orders: { checkout_details: 'TEXT' },
        order_items: { product_name: 'TEXT' }
    };
    for (const [table, fields] of Object.entries(additions)) {
        const existing = new Set(db.pragma(`table_info(${table})`).map(column => column.name));
        for (const [name, definition] of Object.entries(fields)) {
            if (existing.has(name)) continue;
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
            if (table === 'order_items' && name === 'product_name') {
                db.exec('UPDATE order_items SET product_name=(SELECT name FROM products WHERE id=order_items.product_id)');
            }
        }
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS store_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stock_movements (
            id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
            delta INTEGER NOT NULL, balance INTEGER NOT NULL CHECK(balance>=0), reason TEXT NOT NULL,
            order_id INTEGER REFERENCES orders(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS site_checkouts (
            token TEXT PRIMARY KEY, request TEXT, summary TEXT, expires_at INTEGER NOT NULL,
            order_id INTEGER UNIQUE REFERENCES orders(id)
        );
        CREATE INDEX IF NOT EXISTS site_checkouts_expiry ON site_checkouts(expires_at) WHERE order_id IS NULL;
    `);
}
