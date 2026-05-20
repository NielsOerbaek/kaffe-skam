import Database from "better-sqlite3";
import type { Brew, PendingBrew } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS brews (
  id              INTEGER NOT NULL,           -- Eversys product-history id (unique within a machine)
  machine_id      INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS pending_brew (
  machine_id INTEGER PRIMARY KEY,
  brew_json  TEXT NOT NULL
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
      this.setMeta("schema_version", "2");
    }
  }

  close() { this.db.close(); }

  insertBrew(b: Brew): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO brews
        (id, machine_id, machine_ts, local_date, local_month, drink_type, is_double,
         beans_g, milk_ml, co2_g, splash_ids, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.id, b.machineId, b.machineTs, b.localDate, b.localMonth, b.drinkType, b.isDouble,
      b.beansG, b.milkMl, b.co2G,
      b.splashIds.length ? JSON.stringify(b.splashIds) : null,
      b.rawJson,
    );
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

  // Per-drink-type rollup for a given month. Sorted by CO2 contribution DESC.
  getByDrinkType(localMonth: string): Array<{ drinkType: string; cups: number; co2_g: number }> {
    const rows = this.db.prepare(`
      SELECT drink_type AS drinkType,
             COUNT(*)   AS cups,
             COALESCE(SUM(co2_g), 0) AS co2_g
      FROM brews
      WHERE local_month = ?
      GROUP BY drink_type
      ORDER BY co2_g DESC, cups DESC
    `).all(localMonth) as Array<{ drinkType: string; cups: number; co2_g: number }>;

    const map = new Map(rows.map(r => [r.drinkType, r]));
    for (const p of this.getAllPending()) {
      if (p.localMonth !== localMonth) continue;
      const cur = map.get(p.drinkType);
      if (cur) { cur.cups += 1; cur.co2_g += p.co2G; }
      else map.set(p.drinkType, { drinkType: p.drinkType, cups: 1, co2_g: p.co2G });
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
