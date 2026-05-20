import Database from "better-sqlite3";
import type { Brew, PendingBrew } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brews (
  id              INTEGER PRIMARY KEY,
  machine_ts      TEXT NOT NULL,
  local_date      TEXT NOT NULL,
  local_month     TEXT NOT NULL,
  drink_type      TEXT NOT NULL,
  is_double       INTEGER NOT NULL,
  beans_g         REAL NOT NULL,
  milk_ml         REAL NOT NULL,
  co2_g           REAL NOT NULL,
  splash_ids      TEXT,
  raw_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brews_local_date  ON brews(local_date);
CREATE INDEX IF NOT EXISTS idx_brews_local_month ON brews(local_month);

CREATE TABLE IF NOT EXISTS pending_brew (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  brew_json TEXT NOT NULL
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
    if (this.getMeta("schema_version") == null) {
      this.setMeta("schema_version", "1");
    }
  }

  close() { this.db.close(); }

  insertBrew(b: Brew): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO brews
        (id, machine_ts, local_date, local_month, drink_type, is_double,
         beans_g, milk_ml, co2_g, splash_ids, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.id, b.machineTs, b.localDate, b.localMonth, b.drinkType, b.isDouble,
      b.beansG, b.milkMl, b.co2G,
      b.splashIds.length ? JSON.stringify(b.splashIds) : null,
      b.rawJson,
    );
  }

  getLastBrew(): Brew | PendingBrew | null {
    const pending = this.getPending();
    const row = this.db.prepare(`SELECT * FROM brews ORDER BY machine_ts DESC, id DESC LIMIT 1`).get() as any;
    const committed = row ? this.rowToBrew(row) : null;
    if (pending && committed) {
      return pending.machineTs > committed.machineTs ? pending : committed;
    }
    return pending ?? committed;
  }

  getTodayTotals(localDate: string): Totals {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cups, COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews WHERE local_date = ?
    `).get(localDate) as { cups: number; co2_g: number };
    return this.addPendingIfMatches(row, p => p.localDate === localDate);
  }

  getMonthTotals(localMonth: string): Totals {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cups, COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews WHERE local_month = ?
    `).get(localMonth) as { cups: number; co2_g: number };
    return this.addPendingIfMatches(row, p => p.localMonth === localMonth);
  }

  private addPendingIfMatches(row: Totals, predicate: (p: PendingBrew) => boolean): Totals {
    const p = this.getPending();
    if (p && predicate(p)) return { cups: row.cups + 1, co2_g: row.co2_g + p.co2G };
    return row;
  }

  setPending(p: PendingBrew): void {
    this.db.prepare(`
      INSERT INTO pending_brew (id, brew_json) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET brew_json = excluded.brew_json
    `).run(JSON.stringify(p));
  }

  getPending(): PendingBrew | null {
    const row = this.db.prepare(`SELECT brew_json FROM pending_brew WHERE id = 1`).get() as { brew_json: string } | undefined;
    return row ? JSON.parse(row.brew_json) as PendingBrew : null;
  }

  clearPending(): void {
    this.db.prepare(`DELETE FROM pending_brew WHERE id = 1`).run();
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
