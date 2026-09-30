import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'sky.db'))

db.exec(`
CREATE TABLE IF NOT EXISTS team (
  id INTEGER PRIMARY KEY,
  name TEXT,
  money REAL DEFAULT 20000,
  rep INTEGER DEFAULT 50,
  level INTEGER DEFAULT 1,
  season INTEGER DEFAULT 1,
  season_pts INTEGER DEFAULT 0,
  season_pos INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS airships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  speed INTEGER DEFAULT 60,
  dur INTEGER DEFAULT 80,
  turn INTEGER DEFAULT 55,
  acc INTEGER DEFAULT 60,
  parts_dur INTEGER DEFAULT 100,
  hp INTEGER DEFAULT 100
);
CREATE TABLE IF NOT EXISTS pilots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  skill INTEGER DEFAULT 50,
  courage INTEGER DEFAULT 50,
  exp INTEGER DEFAULT 0,
  wage INTEGER DEFAULT 60,
  mood INTEGER DEFAULT 70
);
CREATE TABLE IF NOT EXISTS mechanics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  skill INTEGER DEFAULT 50,
  wage INTEGER DEFAULT 40,
  mood INTEGER DEFAULT 70
);
CREATE TABLE IF NOT EXISTS upgrades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slot TEXT NOT NULL,          -- 引擎/护甲/氮气/翼板/龙骨
  stat TEXT NOT NULL,          -- speed/dur/turn/acc 加成项
  bonus INTEGER NOT NULL,
  price INTEGER NOT NULL,
  level INTEGER DEFAULT 1,
  equipped INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS circuits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  diff INTEGER NOT NULL,       -- 1..5 难度
  weather TEXT NOT NULL,       -- 晴/风/雨/雾/雷暴
  bonus_pts INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  rank INTEGER,
  finished INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sponsors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target INTEGER DEFAULT 0,
  earned INTEGER DEFAULT 0,
  reward INTEGER DEFAULT 0,
  rep INTEGER DEFAULT 0,
  affinity INTEGER DEFAULT 60
);
CREATE TABLE IF NOT EXISTS race_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circuit_id INTEGER,
  season INTEGER,
  rank INTEGER,
  pts INTEGER,
  money REAL,
  note TEXT,
  ts TEXT
);
-- 唯一比赛记录：动画、实时排名、断点续看、历史回放和结算都以它为准。
-- running -> completed 的一次性迁移就是结算闸门，避免重复发奖。
CREATE TABLE IF NOT EXISTS race_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circuit_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | completed
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  settled_at INTEGER,
  viewed INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  pts INTEGER,
  money REAL,
  wear INTEGER,
  parts_dur INTEGER,
  rep_gain INTEGER,
  data TEXT NOT NULL,
  UNIQUE(circuit_id, season)
);
CREATE INDEX IF NOT EXISTS idx_race_records_status ON race_records(status);
CREATE INDEX IF NOT EXISTS idx_race_records_circuit ON race_records(circuit_id, season);
`)

export function run(sql, ...p) { return db.prepare(sql).run(...p) }
export function all(sql, ...p) { return db.prepare(sql).all(...p) }
export function get(sql, ...p) { return db.prepare(sql).get(...p) }