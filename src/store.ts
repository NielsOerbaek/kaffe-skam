import Database from "better-sqlite3";
import type { Brew, PendingBrew } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brews (
  id              INTEGER NOT NULL,           -- Eversys product-history id (unique within a machine)
  machine_id      INTEGER NOT NULL,
  product_key     INTEGER,                    -- maps to products.product_key for friendly names
  machine_ts      TEXT NOT NULL,
  local_date      TEXT NOT NULL,
  local_month     TEXT NOT NULL,
  drink_type      TEXT NOT NULL,
  is_double       INTEGER NOT NULL,
  beans_g         REAL NOT NULL,
  milk_ml         REAL NOT NULL,
  co2_g           REAL NOT NULL,
  splash_ids      TEXT,
  raw_json        TEXT NOT NULL,
  PRIMARY KEY (machine_id, id)
);
CREATE INDEX IF NOT EXISTS idx_brews_local_date  ON brews(local_date);
CREATE INDEX IF NOT EXISTS idx_brews_local_month ON brews(local_month);
CREATE INDEX IF NOT EXISTS idx_brews_machine_ts  ON brews(machine_ts);
-- idx_brews_product is created by runMigrations() after the product_key column exists.

CREATE TABLE IF NOT EXISTS pending_brew (
  machine_id INTEGER PRIMARY KEY,
  brew_json  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  machine_id  INTEGER NOT NULL,
  product_key INTEGER NOT NULL,
  name        TEXT NOT NULL,
  PRIMARY KEY (machine_id, product_key)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export interface Totals { cups: number; co2_g: number }

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.runMigrations();
    if (this.getMeta("schema_version") == null) {
      this.setMeta("schema_version", "3");
    }
  }

  // Lightweight forward-only migrations. Safe to run on every startup.
  private runMigrations(): void {
    // v3: add product_key column to brews if missing, backfill from raw_json.keyId
    const cols = this.db.prepare(`PRAGMA table_info(brews)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === "product_key")) {
      this.db.exec(`ALTER TABLE brews ADD COLUMN product_key INTEGER`);
    }
    // Index can be created any time after the column exists; IF NOT EXISTS is safe to call repeatedly.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_brews_product ON brews(machine_id, product_key)`);
    // Backfill missing product_key from raw_json.keyId (idempotent — only updates NULLs).
    const rows = this.db.prepare(
      `SELECT machine_id, id, raw_json FROM brews WHERE product_key IS NULL`
    ).all() as Array<{ machine_id: number; id: number; raw_json: string }>;
    if (rows.length > 0) {
      const upd = this.db.prepare(
        `UPDATE brews SET product_key = ? WHERE machine_id = ? AND id = ?`
      );
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          try {
            const raw = JSON.parse(r.raw_json) as { keyId?: number };
            if (typeof raw.keyId === "number") upd.run(raw.keyId, r.machine_id, r.id);
          } catch {
            // ignore broken rows
          }
        }
      });
      tx();
    }

    // v4: clear stale products so the next poller.refreshProducts() repopulates
    // with the corrected mapping (keyId = productId + 1).
    if (this.getMeta("products_shifted_v1") == null) {
      this.db.exec(`DELETE FROM products`);
      this.setMeta("products_shifted_v1", "1");
    }
  }

  close() { this.db.close(); }

  insertBrew(b: Brew): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO brews
        (id, machine_id, product_key, machine_ts, local_date, local_month, drink_type, is_double,
         beans_g, milk_ml, co2_g, splash_ids, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.id, b.machineId, b.productKey, b.machineTs, b.localDate, b.localMonth, b.drinkType, b.isDouble,
      b.beansG, b.milkMl, b.co2G,
      b.splashIds.length ? JSON.stringify(b.splashIds) : null,
      b.rawJson,
    );
  }

  // ─── Products (button name lookup) ──────────────────────────────
  upsertProduct(machineId: number, productKey: number, name: string): void {
    this.db.prepare(`
      INSERT INTO products (machine_id, product_key, name) VALUES (?, ?, ?)
      ON CONFLICT(machine_id, product_key) DO UPDATE SET name = excluded.name
    `).run(machineId, productKey, name);
  }

  getProductName(machineId: number, productKey: number | null): string | null {
    if (productKey == null) return null;
    const row = this.db.prepare(
      `SELECT name FROM products WHERE machine_id = ? AND product_key = ?`
    ).get(machineId, productKey) as { name: string } | undefined;
    return row?.name ?? null;
  }

  getAllProducts(): Array<{ machineId: number; productKey: number; name: string }> {
    const rows = this.db.prepare(`SELECT machine_id, product_key, name FROM products`).all() as Array<{ machine_id: number; product_key: number; name: string }>;
    return rows.map(r => ({ machineId: r.machine_id, productKey: r.product_key, name: r.name }));
  }

  // Return the N most recent brews from a single machine (committed + pending), newest first.
  getRecentBrewsForMachine(machineId: number, limit: number): Brew[] {
    const pending = this.getPending(machineId);
    const need = limit + (pending ? 1 : 0);
    const rows = this.db.prepare(
      `SELECT * FROM brews WHERE machine_id = ? ORDER BY machine_ts DESC, id DESC LIMIT ?`
    ).all(machineId, need) as any[];
    const committed = rows.map(r => this.rowToBrew(r));
    const all: Brew[] = pending ? [pending, ...committed] : committed;
    all.sort((a, b) => b.machineTs.localeCompare(a.machineTs));
    return all.slice(0, limit);
  }

  // Return the N most recent brews (committed + pending), newest first.
  // Pending brews count as "recent" so a brew shows up immediately even before its splash window expires.
  getRecentBrews(limit: number): Brew[] {
    const pendings = this.getAllPending();
    const need = limit + pendings.length;
    const rows = this.db.prepare(
      `SELECT * FROM brews ORDER BY machine_ts DESC, id DESC LIMIT ?`
    ).all(need) as any[];
    const committed = rows.map(r => this.rowToBrew(r));
    const all: Brew[] = [...pendings, ...committed];
    all.sort((a, b) => b.machineTs.localeCompare(a.machineTs));
    return all.slice(0, limit);
  }

  getTodayTotals(localDate: string): Totals {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cups, COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews WHERE local_date = ?
    `).get(localDate) as { cups: number; co2_g: number };
    return this.addPendingIfMatches(row, p => p.localDate === localDate);
  }

  // Return the Monday (YYYY-MM-DD) of the ISO week containing the given
  // local date. Used for week-bucket aggregation.
  static weekStartOf(localDate: string): string {
    // Parse as local midnight to avoid TZ shifts
    const [y, m, d] = localDate.split("-").map(Number);
    const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
    const dow = dt.getDay();              // 0 (Sun) .. 6 (Sat)
    const offset = dow === 0 ? -6 : 1 - dow; // ISO week starts Monday
    dt.setDate(dt.getDate() + offset);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }

  // Weekly rollups (Monday-starting), oldest first.
  getWeeklyTotals(sinceLocalDate: string): Array<{ weekStart: string; cups: number; co2_g: number }> {
    const days = this.getDailyTotals(sinceLocalDate);
    const map = new Map<string, { weekStart: string; cups: number; co2_g: number }>();
    for (const d of days) {
      const ws = Store.weekStartOf(d.date);
      const cur = map.get(ws) ?? { weekStart: ws, cups: 0, co2_g: 0 };
      cur.cups += d.cups;
      cur.co2_g += d.co2_g;
      map.set(ws, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }

  // Per-day rollups for the last N days, oldest first. Pending brews are
  // attributed to their localDate so today's bar reflects in-flight cups too.
  getDailyTotals(sinceLocalDate: string): Array<{ date: string; cups: number; co2_g: number }> {
    const rows = this.db.prepare(`
      SELECT local_date AS date,
             COUNT(*)        AS cups,
             COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews
      WHERE local_date >= ?
      GROUP BY local_date
      ORDER BY local_date ASC
    `).all(sinceLocalDate) as Array<{ date: string; cups: number; co2_g: number }>;

    // Fold pending brews in. (One per machine, may all land on different days.)
    const map = new Map(rows.map(r => [r.date, r]));
    for (const p of this.getAllPending()) {
      if (p.localDate < sinceLocalDate) continue;
      const cur = map.get(p.localDate);
      if (cur) { cur.cups += 1; cur.co2_g += p.co2G; }
      else map.set(p.localDate, { date: p.localDate, cups: 1, co2_g: p.co2G });
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  // Per-drink rollup for a given month, grouped by RESOLVED PRODUCT NAME when
  // available (machine button name from the products table), falling back to
  // the API's drink-type enum. Identical names across machines collapse into
  // a single row. Sorted by CO2 contribution DESC.
  getByDrinkType(localMonth: string): Array<{ key: string; displayName: string; drinkType: string; cups: number; co2_g: number }> {
    const rows = this.db.prepare(`
      SELECT b.drink_type AS drinkType,
             p.name       AS productName,
             COUNT(*)     AS cups,
             COALESCE(SUM(b.co2_g), 0) AS co2_g
      FROM brews b
      LEFT JOIN products p ON p.machine_id = b.machine_id AND p.product_key = b.product_key
      WHERE b.local_month = ?
      GROUP BY COALESCE(p.name, b.drink_type)
      ORDER BY co2_g DESC, cups DESC
    `).all(localMonth) as Array<{ drinkType: string; productName: string | null; cups: number; co2_g: number }>;

    const map = new Map<string, { key: string; displayName: string; drinkType: string; cups: number; co2_g: number }>();
    for (const r of rows) {
      const key = r.productName ?? r.drinkType;
      map.set(key, { key, displayName: r.productName ?? r.drinkType, drinkType: r.drinkType, cups: r.cups, co2_g: r.co2_g });
    }
    // Fold in pending brews
    for (const p of this.getAllPending()) {
      if (p.localMonth !== localMonth) continue;
      const name = this.getProductName(p.machineId, p.productKey) ?? p.drinkType;
      const cur = map.get(name);
      if (cur) { cur.cups += 1; cur.co2_g += p.co2G; }
      else map.set(name, { key: name, displayName: name, drinkType: p.drinkType, cups: 1, co2_g: p.co2G });
    }
    return Array.from(map.values()).sort((a, b) => b.co2_g - a.co2_g || b.cups - a.cups);
  }

  getMonthTotals(localMonth: string): Totals {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cups, COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews WHERE local_month = ?
    `).get(localMonth) as { cups: number; co2_g: number };
    return this.addPendingIfMatches(row, p => p.localMonth === localMonth);
  }

  // Each machine's pending brew counts at most once toward totals.
  private addPendingIfMatches(row: Totals, predicate: (p: PendingBrew) => boolean): Totals {
    const matched = this.getAllPending().filter(predicate);
    if (matched.length === 0) return row;
    return {
      cups: row.cups + matched.length,
      co2_g: row.co2_g + matched.reduce((s, p) => s + p.co2G, 0),
    };
  }

  setPending(p: PendingBrew): void {
    this.db.prepare(`
      INSERT INTO pending_brew (machine_id, brew_json) VALUES (?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET brew_json = excluded.brew_json
    `).run(p.machineId, JSON.stringify(p));
  }

  getPending(machineId: number): PendingBrew | null {
    const row = this.db.prepare(
      `SELECT brew_json FROM pending_brew WHERE machine_id = ?`
    ).get(machineId) as { brew_json: string } | undefined;
    return row ? JSON.parse(row.brew_json) as PendingBrew : null;
  }

  getAllPending(): PendingBrew[] {
    const rows = this.db.prepare(`SELECT brew_json FROM pending_brew`).all() as { brew_json: string }[];
    return rows.map(r => JSON.parse(r.brew_json) as PendingBrew);
  }

  clearPending(machineId: number): void {
    this.db.prepare(`DELETE FROM pending_brew WHERE machine_id = ?`).run(machineId);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private rowToBrew(r: any): Brew {
    return {
      id: r.id,
      machineId: r.machine_id,
      productKey: r.product_key ?? null,
      machineTs: r.machine_ts,
      localDate: r.local_date,
      localMonth: r.local_month,
      drinkType: r.drink_type,
      isDouble: r.is_double as 0 | 1,
      beansG: r.beans_g,
      milkMl: r.milk_ml,
      co2G: r.co2_g,
      splashIds: r.splash_ids ? JSON.parse(r.splash_ids) : [],
      rawJson: r.raw_json,
    };
  }
}
