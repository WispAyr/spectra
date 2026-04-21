/**
 * signal-log.js — Signal event log (sql.js pure-JS SQLite)
 */

const fs = require('fs');
const path = require('path');

class SignalLog {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.SQL = null;
    this.memLog = [];
    this._init();
  }

  async _init() {
    try {
      const initSqlJs = require('sql.js');
      this.SQL = await initSqlJs();
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Load existing DB or create new
      if (fs.existsSync(this.dbPath)) {
        const buf = fs.readFileSync(this.dbPath);
        this.db = new this.SQL.Database(buf);
      } else {
        this.db = new this.SQL.Database();
      }

      this.db.run(`CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )`);

      // Persist to disk every 30s
      this._saveTimer = setInterval(() => this._persist(), 30000);
      console.log('[SignalLog] sql.js database initialised:', this.dbPath);
    } catch (e) {
      console.warn('[SignalLog] sql.js unavailable — using in-memory log:', e.message);
      this.db = null;
    }
  }

  _persist() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (e) { /* ignore */ }
  }

  log(type, data) {
    const entry = {
      type,
      data: typeof data === 'string' ? data : JSON.stringify(data),
      timestamp: Date.now()
    };
    if (this.db) {
      try {
        this.db.run('INSERT INTO signals (type,data,timestamp) VALUES (?,?,?)',
          [entry.type, entry.data, entry.timestamp]);
      } catch (e) {
        this.memLog.push(entry);
      }
    } else {
      this.memLog.push(entry);
      if (this.memLog.length > 5000) this.memLog.shift();
    }
  }

  query(type, limit = 200) {
    if (this.db) {
      try {
        const sql = type
          ? 'SELECT * FROM signals WHERE type=? ORDER BY timestamp DESC LIMIT ?'
          : 'SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?';
        const stmt = this.db.prepare(sql);
        const rows = [];
        stmt.bind(type ? [type, limit] : [limit]);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows.map(r => ({ ...r, data: this._tryParse(r.data) }));
      } catch (e) { return []; }
    }
    const filtered = type ? this.memLog.filter(e => e.type === type) : this.memLog;
    return filtered.slice(-limit).reverse().map(e => ({ ...e, data: this._tryParse(e.data) }));
  }

  _tryParse(str) {
    try { return JSON.parse(str); } catch { return str; }
  }

  stats() {
    return { count: this.memLog.length, backend: this.db ? 'sql.js' : 'memory' };
  }
}

module.exports = SignalLog;
