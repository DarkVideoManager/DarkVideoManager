import type { Database } from 'better-sqlite3'

export class SettingsRepository {
  constructor(private db: Database) {}

  get<T>(key: string, defaultValue: T): T {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined
    if (!row) return defaultValue
    try {
      return JSON.parse(row.value) as T
    } catch {
      return defaultValue
    }
  }

  set<T>(key: string, value: T): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value))
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }
}
