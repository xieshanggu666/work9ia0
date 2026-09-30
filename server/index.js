import express from 'express'
import { db, run, all, get } from './db.js'

const app = express()
app.use(express.json())
const PORT = 4180
const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
const WEATHER = { '晴': 1.0, '风': 0.96, '雨': 0.9, '雾': 0.84, '雷暴': 0.78 }
const SEGMENT_BASE_MS = 1850
const nowText = () => new Date().toLocaleString('zh-CN')
const nowMs = () => Date.now()
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
const round1 = n => Math.round(n * 10) / 10

// 四个分段分别考验不同改装属性；天气与人员状态在各段产生不同影响。
const SEGMENTS = [
  {
    key: 'launch', name: '起飞加速', stat: 'acc', statName: '加速', statWeight: 0.86,
    weather: { '晴': 1, '风': 0.95, '雨': 0.91, '雾': 0.9, '雷暴': 0.84 },
    pilot: 0.78, mech: 0.42
  },
  {
    key: 'crosswind', name: '穿云转向', stat: 'turn', statName: '转向', statWeight: 0.82,
    weather: { '晴': 1, '风': 0.88, '雨': 0.92, '雾': 0.86, '雷暴': 0.83 },
    pilot: 0.84, mech: 0.38
  },
  {
    key: 'jetline', name: '云脊冲刺', stat: 'speed', statName: '速度', statWeight: 0.9,
    weather: { '晴': 1.02, '风': 0.94, '雨': 0.9, '雾': 0.93, '雷暴': 0.79 },
    pilot: 0.72, mech: 0.48
  },
  {
    key: 'gauntlet', name: '风暴冲线', stat: 'dur', statName: '耐久', statWeight: 0.76,
    weather: { '晴': 1, '风': 0.96, '雨': 0.88, '雾': 0.91, '雷暴': 0.76 },
    pilot: 0.7, mech: 0.62
  }
]
const OPPONENT_NAMES = ['苍穹极光', '翡翠之翼', '雷鸣环驾', '暮色猎手', '星尘漂流']
const OPPONENT_COLORS = ['#7ecbff', '#b19cff', '#6fe7d0', '#ff9fb0', '#ffb85c']

function seed() {
  if (get('SELECT COUNT(*) c FROM team').c > 0) return
  run('INSERT INTO team (name) VALUES (?)', '苍穹疾风战队')
  run('INSERT INTO airships (name) VALUES (?)', '云雀·I')
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '奥罗·晨曦', 62, 58, 20, 80, 75)
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '莉娜·云涛', 55, 65, 8, 55, 82)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', '格蕾丝·铆钉', 58, 45, 78)
  const ups = [['竞速涡轮','引擎','speed',14,2600],['流线翼板','翼板','speed',9,1800],['氮气助推','氮气','acc',16,2200],
    ['回旋舵','龙骨','turn',12,2000],['云母护甲','护甲','dur',15,2400],['轻量合金','翼板','acc',11,1900],
    ['蓝纹喷射引擎','引擎','speed',20,3200],['硬壳鳞甲','护甲','dur',22,3400]]
  ups.forEach(([n, slot, stat, bonus, price]) => run('INSERT INTO upgrades (name,slot,stat,bonus,price) VALUES (?,?,?,?,?)', n, slot, stat, bonus, price))
  const cir = [['晨雾浮岛','1','雾'],['雷鸣云谷','2','雷暴'],['翡翠群岛','3','晴'],['风暴裂谷','3','雨'],['极光穹顶','4','风'],['星界之巅','5','雾']]
  cir.forEach(([n, d, w]) => run('INSERT INTO circuits (name,diff,weather,bonus_pts) VALUES (?,?,?,?)', n, Number(d), w, Number(d) * 4))
  const spo = [['云帆工坊', 12, 4000, 8], ['星罗航空', 22, 8000, 15], ['流风动力', 32, 14000, 22], ['苍穹商会', 45, 22000, 32]]
  spo.forEach(([n, t, r, rep]) => run('INSERT INTO sponsors (name,target,reward,rep) VALUES (?,?,?,?)', n, t, r, rep))
}
export function teamCore() { return get('SELECT * FROM team WHERE id=1') }
export function airship() { return all('SELECT * FROM airships')[0] || { speed: 60, dur: 80, turn: 55, acc: 60, parts_dur: 100, hp: 100, name: '云雀·I', id: 1 } }
export function fleetStats() {
  const a = airship()
  const up = all('SELECT * FROM upgrades WHERE equipped=1')
  const s = { speed: a.speed, dur: a.dur, turn: a.turn, acc: a.acc, name: a.name, id: a.id, parts_dur: a.parts_dur, hp: a.hp }
  up.forEach(u => { s[u.stat] = (s[u.stat] || 0) + u.bonus })
  return s
}
function bestPilot() {
  return all('SELECT * FROM pilots ORDER BY (skill * 0.58 + courage * 0.24 + exp * 0.12 + mood * 0.06) DESC')[0] || null
}
function bestMechanic() {
  return all('SELECT * FROM mechanics ORDER BY (skill * 0.82 + mood * 0.18) DESC')[0] || null
}
function pilotSegmentScore(p, seg) {
  if (!p) return 3.5
  const courageBoost = seg.weatherKey === '雷暴' ? 0.34 : 0.22
  return (p.skill * 0.58 + p.courage * courageBoost + p.exp * 0.16 + (p.mood - 50) * 0.14) * seg.pilot * 0.19
}
function mechanicSegmentScore(m, seg) {
  if (!m) return 1.8
  return (m.skill * 0.86 + (m.mood - 50) * 0.16) * seg.mech * 0.17
}
function orderedCircuits() { return all('SELECT * FROM circuits ORDER BY id ASC') }
function nextCircuit() { return orderedCircuits().find(c => !c.finished) || null }

function buildRace(circuit) {
  const team = teamCore()
  const ship = fleetStats()
  const pilot = bestPilot()
  const mechanic = bestMechanic()
  const upgrades = all('SELECT * FROM upgrades WHERE equipped=1')
  const partsFactor = clamp(ship.parts_dur / 100, 0.55, 1.1)
  const circuitIndex = orderedCircuits().findIndex(c => c.id === circuit.id)

  const factorSegments = SEGMENTS.map(seg => ({
    ...seg,
    weatherKey: circuit.weather,
    weatherFactor: seg.weather[circuit.weather] ?? 1,
    statValue: ship[seg.stat] || 0,
    upgradeBonus: upgrades.filter(u => u.stat === seg.stat).reduce((sum, u) => sum + u.bonus, 0),
    partsFactor: round1(partsFactor),
    pilotContribution: round1(pilotSegmentScore(pilot, { ...seg, weatherKey: circuit.weather })),
    mechanicContribution: round1(mechanicSegmentScore(mechanic, seg))
  }))

  const playerEntrant = {
    id: 0,
    name: team.name,
    shipName: ship.name,
    color: '#ffcf5c',
    isPlayer: true,
    pilotName: pilot?.name || '无人驾驶',
    mechanicName: mechanic?.name || '无技工',
    segments: []
  }
  const opponents = OPPONENT_NAMES.map((name, i) => ({
    id: i + 1,
    name,
    color: OPPONENT_COLORS[i],
    isPlayer: false,
    skill: 57 + circuit.diff * 6.5 + Math.random() * 16 - 6,
    crew: 6.4 + Math.random() * 2.8,
    segments: []
  }))
  const entrants = [playerEntrant, ...opponents]

  factorSegments.forEach(seg => {
    const playerPace = Math.max(5,
      ship[seg.stat] * 0.16 * seg.statWeight * partsFactor * seg.weatherFactor
      + seg.pilotContribution + seg.mechanicContribution + circuit.diff * 0.55
    ) * (1 + Math.random() * 0.13 - 0.065)
    const playerDuration = Math.round(clamp(SEGMENT_BASE_MS * 22 / playerPace, 1550, 3300))
    playerEntrant.segments.push({
      key: seg.key, name: seg.name, score: round1(playerPace), durationMs: playerDuration,
      event: playerPace > 23 ? '状态火热' : circuit.weather === '雷暴' ? '稳住气流' : '正常通过'
    })

    opponents.forEach((o, idx) => {
      const specialty = 0.92 + ((idx * 17 + seg.key.length * 11) % 17) / 100
      const oppPace = Math.max(5,
        o.skill * 0.16 * seg.statWeight * seg.weatherFactor * specialty
        + o.crew + circuit.diff * 0.45
      ) * (1 + Math.random() * 0.15 - 0.075)
      const duration = Math.round(clamp(SEGMENT_BASE_MS * 22 / oppPace, 1550, 3300))
      o.segments.push({
        key: seg.key, name: seg.name, score: round1(oppPace), durationMs: duration,
        event: oppPace > 22.5 ? '抓住尾流' : seg.weatherFactor < 0.88 ? '天气干扰' : '正常通过'
      })
    })
  })

  entrants.forEach((e, idx) => {
    e.totalMs = e.segments.reduce((sum, s) => sum + s.durationMs, 0) + idx * 3
  })
  entrants.sort((a, b) => a.totalMs - b.totalMs)
  entrants.forEach((e, i) => { e.rank = i + 1 })

  const playerRank = entrants.find(e => e.isPlayer).rank
  const pts = PTS[playerRank - 1] || 1
  const money = Math.round((600 + (7 - playerRank) * 180) * (1 + circuit.diff * 0.05))
  const wear = 5 + circuit.diff * 3 + (WEATHER[circuit.weather] < 0.9 ? 4 : 0)
  const repGain = Math.max(1, 5 - playerRank + circuit.diff)
  const durationMs = Math.max(...entrants.map(e => e.totalMs)) + 650
  const startedAt = nowMs()

  // 排序后的 entrants 用于固定名次，动画仍可通过 isPlayer 找到玩家艇。
  const data = {
    version: 2,
    circuit: {
      id: circuit.id,
      name: circuit.name,
      diff: circuit.diff,
      weather: circuit.weather,
      bonusPts: circuit.bonus_pts,
      index: circuitIndex
    },
    factors: {
      weather: circuit.weather,
      globalWeatherFactor: WEATHER[circuit.weather] || 1,
      partsFactor: round1(partsFactor),
      upgrades: upgrades.map(u => ({ id: u.id, name: u.name, slot: u.slot, stat: u.stat, bonus: u.bonus })),
      pilot: pilot ? { id: pilot.id, name: pilot.name, skill: pilot.skill, courage: pilot.courage, exp: pilot.exp, mood: pilot.mood } : null,
      mechanic: mechanic ? { id: mechanic.id, name: mechanic.name, skill: mechanic.skill, mood: mechanic.mood } : null,
      segments: factorSegments
    },
    entrants
  }

  return {
    startedAt,
    durationMs,
    rank: playerRank,
    pts,
    money,
    wear,
    partsDurAfter: Math.max(10, ship.parts_dur - wear),
    repGain,
    data
  }
}

function serializeRecord(row) {
  if (!row) return null
  let data = {}
  try { data = JSON.parse(row.data || '{}') } catch { data = {} }
  return {
    id: row.id,
    circuit_id: row.circuit_id,
    season: row.season,
    status: row.status,
    started_at: row.started_at,
    duration_ms: row.duration_ms,
    settled_at: row.settled_at,
    viewed: !!row.viewed,
    rank: row.rank,
    pts: row.pts,
    money: row.money,
    wear: row.wear,
    parts_dur: row.parts_dur,
    repGain: row.rep_gain,
    data
  }
}
function getRecordRow(id) { return get('SELECT * FROM race_records WHERE id=?', Number(id)) }
function getActiveRecordRow() { return get("SELECT * FROM race_records WHERE status='running' ORDER BY id DESC LIMIT 1") }
function getCircuitRecordRow(cid, season = teamCore().season) {
  return get('SELECT * FROM race_records WHERE circuit_id=? AND season=? ORDER BY id DESC LIMIT 1', Number(cid), season)
}

function reconcileSponsors() {
  const pts = teamCore().season_pts
  all('SELECT * FROM sponsors').forEach(s => {
    if (!s.reward) return
    const reached = pts >= s.target
    if (reached && !s.earned) {
      run('UPDATE team SET money=money+?, rep=rep+? WHERE id=1', s.reward, s.rep)
      run('UPDATE sponsors SET earned=1, affinity=affinity+10 WHERE id=?', s.id)
    } else if (!reached && s.earned) {
      run('UPDATE team SET money=money-?, rep=rep-? WHERE id=1', s.reward, s.rep)
      run('UPDATE sponsors SET earned=0, affinity=affinity-10 WHERE id=?', s.id)
    }
  })
}

function finalizeRecord(row, { force = false } = {}) {
  if (!row || row.status === 'completed') return { record: serializeRecord(row), already: true }
  const serverNow = nowMs()
  if (!force && serverNow < row.started_at + row.duration_ms) {
    return { tooEarly: true, remaining: row.started_at + row.duration_ms - serverNow }
  }

  try {
    run('BEGIN IMMEDIATE')
    const fresh = getRecordRow(row.id)
    if (!fresh) { run('ROLLBACK'); return { error: '比赛记录不存在' } }
    if (fresh.status === 'completed') { run('COMMIT'); return { record: serializeRecord(fresh), already: true } }

    const rec = serializeRecord(fresh)
    const ship = airship()
    const nextParts = Math.max(10, ship.parts_dur - rec.wear)
    run('UPDATE airships SET parts_dur=?, hp=? WHERE id=?', nextParts, Math.max(20, ship.hp - rec.wear), ship.id)

    const pilot = rec.data?.factors?.pilot
    if (pilot?.id && get('SELECT id FROM pilots WHERE id=?', pilot.id)) {
      run('UPDATE pilots SET exp=exp+?, mood=MAX(0,MIN(100,mood+?)) WHERE id=?',
        rec.rank <= 4 ? 3 : 1, rec.rank <= 3 ? 3 : rec.rank <= 5 ? -1 : -4, pilot.id)
    }
    const mechanic = rec.data?.factors?.mechanic
    if (mechanic?.id && get('SELECT id FROM mechanics WHERE id=?', mechanic.id)) {
      run('UPDATE mechanics SET mood=MAX(0,MIN(100,mood+?)) WHERE id=?', rec.rank <= 3 ? 2 : -2, mechanic.id)
    }

    run('UPDATE team SET money=money+?, rep=rep+?, season_pts=season_pts+? WHERE id=1', rec.money, rec.repGain, rec.pts)
    const ranksDone = all('SELECT rank FROM circuits WHERE finished=1 AND rank IS NOT NULL').map(x => x.rank)
    run('UPDATE team SET season_pos=? WHERE id=1', Math.max(1, Math.min(rec.rank, ...ranksDone)))
    run('UPDATE circuits SET finished=1, rank=? WHERE id=?', rec.rank, rec.circuit_id)
    run(`UPDATE race_records
      SET status='completed', settled_at=?, rank=?, pts=?, money=?, wear=?, parts_dur=?, rep_gain=?
      WHERE id=?`, nowMs(), rec.rank, rec.pts, rec.money, rec.wear, nextParts, rec.repGain, rec.id)
    reconcileSponsors()
    run('COMMIT')
    return { record: serializeRecord(getRecordRow(rec.id)), already: false }
  } catch (e) {
    try { run('ROLLBACK') } catch {}
    throw e
  }
}

// 兼容旧版 race_log：先沿用原有序校验清理越站流水，再把剩余唯一流水补成可回放的 v2 记录。
function reconcileLegacySkips() {
  const cs = orderedCircuits()
  const firstOpen = cs.findIndex(c => !c.finished)
  if (firstOpen !== -1) {
    const skipped = cs.slice(firstOpen + 1).filter(c => c.finished)
    if (skipped.length) {
      let ptsBack = 0, moneyBack = 0, repBack = 0
      skipped.forEach(c => {
        all('SELECT * FROM race_log WHERE circuit_id=?', c.id).forEach(l => {
          ptsBack += l.pts || 0
          moneyBack += l.money || 0
          run('DELETE FROM race_log WHERE id=?', l.id)
        })
        repBack += Math.max(1, 5 - (c.rank || 6) + c.diff)
        run('UPDATE circuits SET finished=0, rank=NULL WHERE id=?', c.id)
      })
      if (ptsBack || moneyBack || repBack) {
        run('UPDATE team SET season_pts=MAX(0,season_pts-?), money=money-?, rep=rep-? WHERE id=1', ptsBack, moneyBack, repBack)
      }
      reconcileSponsors()
      const ranks = orderedCircuits().filter(x => x.finished && x.rank).map(x => x.rank)
      run('UPDATE team SET season_pos=? WHERE id=1', ranks.length ? Math.max(1, Math.min(...ranks)) : 1)
    }
  }
}

function legacyReplayData(circuit, log) {
  const rank = log.rank || 6
  const entrants = Array.from({ length: 6 }, (_, i) => {
    const isPlayer = i === rank - 1
    const segments = SEGMENTS.map(seg => {
      const duration = 2200 + i * 90 + (seg.key.length % 4) * 35
      return { key: seg.key, name: seg.name, score: round1(22 - i * 0.7), durationMs: duration, event: '历史记录' }
    })
    return {
      id: isPlayer ? 0 : i < rank - 1 ? i + 1 : i,
      name: isPlayer ? teamCore().name : OPPONENT_NAMES[i >= rank ? i - 1 : i] || `对手 ${i + 1}`,
      color: isPlayer ? '#ffcf5c' : OPPONENT_COLORS[i % OPPONENT_COLORS.length],
      isPlayer,
      rank: i + 1,
      segments,
      totalMs: segments.reduce((s, x) => s + x.durationMs, 0)
    }
  }).sort((a, b) => a.rank - b.rank)
  return {
    version: 2,
    legacy: true,
    circuit: { id: circuit.id, name: circuit.name, diff: circuit.diff, weather: circuit.weather, bonusPts: circuit.bonus_pts },
    factors: {
      weather: circuit.weather,
      globalWeatherFactor: WEATHER[circuit.weather] || 1,
      partsFactor: 1,
      upgrades: [],
      pilot: null,
      mechanic: null,
      segments: SEGMENTS.map(seg => ({
        ...seg, weatherKey: circuit.weather, weatherFactor: seg.weather[circuit.weather] || 1,
        statValue: 0, upgradeBonus: 0, partsFactor: 1, pilotContribution: 0, mechanicContribution: 0
      }))
    },
    entrants
  }
}
function migrateLegacyLogs() {
  const logs = all('SELECT * FROM race_log ORDER BY id ASC')
  logs.forEach((l, idx) => {
    const circuit = get('SELECT * FROM circuits WHERE id=?', l.circuit_id)
    if (!circuit) return
    const exists = get('SELECT id FROM race_records WHERE circuit_id=? AND season=?', l.circuit_id, l.season || teamCore().season)
    if (exists) return
    const durationMs = 4 * 2300 + 650
    const ts = Date.parse(l.ts)
    const startedAt = Number.isFinite(ts) ? ts : nowMs() - (logs.length - idx) * 60000
    const data = legacyReplayData(circuit, l)
    run(`INSERT INTO race_records
      (circuit_id,season,status,started_at,duration_ms,settled_at,viewed,rank,pts,money,wear,parts_dur,rep_gain,data)
      VALUES (?,?, 'completed', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      l.circuit_id, l.season || teamCore().season, startedAt - durationMs, durationMs, startedAt,
      l.rank, l.pts, l.money, 0, 100, Math.max(1, 5 - (l.rank || 6) + circuit.diff), JSON.stringify(data))
  })
}

seed()
reconcileLegacySkips()
migrateLegacyLogs()

const payload = () => {
  const t = teamCore()
  const st = fleetStats()
  const upgrades = all('SELECT * FROM upgrades')
  const pilots = all('SELECT * FROM pilots')
  const mechanics = all('SELECT * FROM mechanics')
  const circuits = orderedCircuits()
  const sponsors = all('SELECT * FROM sponsors')
  const records = all('SELECT * FROM race_records ORDER BY id DESC').map(serializeRecord)
  const activeRace = records.find(r => r.status === 'running') || null
  const log = records
    .filter(r => r.status === 'completed')
    .map(r => ({
      id: r.id,
      race_id: r.id,
      circuit_id: r.circuit_id,
      season: r.season,
      rank: r.rank,
      pts: r.pts,
      money: r.money,
      note: `${r.data?.circuit?.weather || ''}天，${r.data?.circuit?.name || ''}`,
      ts: r.settled_at ? new Date(r.settled_at).toLocaleString('zh-CN') : ''
    }))
  const done = circuits.filter(c => c.finished).length
  return {
    team: t, airship: st, upgrades, pilots, mechanics, circuits, sponsors, log,
    races: records, activeRace, serverNow: nowMs(),
    seasonDone: done, seasonTotal: circuits.length
  }
}

app.get('/api/state', (_, res) => res.json(payload()))
app.get('/api/overview', (_, res) => res.json(payload()))
app.get('/api/time', (_, res) => res.json({ serverNow: nowMs() }))

// 购买新升级件
app.post('/api/shop', (req, res) => {
  const { slot, stat, name, price, bonus } = req.body
  const t = teamCore()
  if (t.money < price) return res.json({ ok: false, msg: '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', price)
  const r = run('INSERT INTO upgrades (name,slot,stat,bonus,price,level) VALUES (?,?,?,?,?,1)', name || '神秘部件', slot, stat, bonus, price)
  res.json({ ok: true, msg: '已购入新部件', id: Number(r.lastInsertRowid) })
})
app.post('/api/equip/:id', (req, res) => {
  const up = get('SELECT * FROM upgrades WHERE id=?', Number(req.params.id))
  if (!up) return res.json({ ok: false, msg: '部件不存在' })
  all('SELECT id FROM upgrades WHERE slot=? AND equipped=1 AND id!=?', up.slot, up.id).forEach(u => run('UPDATE upgrades SET equipped=0 WHERE id=?', u.id))
  run('UPDATE upgrades SET equipped=1 WHERE id=?', up.id)
  res.json({ ok: true })
})
app.post('/api/unequip/:id', (req, res) => {
  run('UPDATE upgrades SET equipped=0 WHERE id=?', Number(req.params.id))
  res.json({ ok: true })
})

app.post('/api/hire_pilot', (req, res) => {
  const t = teamCore(); const cost = 1500
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const names = ['鹰眼·鸦', '风歌·岚', '铁羽·矶', '晨星·曦']
  const n = names[Math.floor(Math.random() * names.length)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO pilots (name,skill,courage,wage,mood) VALUES (?,?,?,?,?)', n, 45 + Math.floor(Math.random() * 20), 48 + Math.floor(Math.random() * 18), 60, 72)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/hire_mech', (req, res) => {
  const t = teamCore(); const cost = 1000
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const n = '工匠·' + ['铁锤', '螺丝', '风箱', '砧台'][Math.floor(Math.random() * 4)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', n, 40 + Math.floor(Math.random() * 20), 40, 74)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/train', (req, res) => {
  const t = teamCore(); const cost = 800
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const fallback = all('SELECT id FROM pilots LIMIT 1')[0]
  const id = Number(req.body.id) || fallback?.id
  if (!id) return res.json({ ok: false, msg: '暂无机师' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE pilots SET skill=skill+2, mood=mood+2 WHERE id=?', id)
  res.json({ ok: true, msg: '完成特训，技巧+2' })
})

app.post('/api/maintain', (req, res) => {
  const t = teamCore(); const a = airship()
  const cost = Math.round((100 - a.parts_dur) * 25)
  if (cost < 200 || t.money < 200) return res.status(200).json({ ok: false, cost, msg: cost < 200 ? '部件状态良好，无需维护' : '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE airships SET parts_dur=100, hp=100 WHERE id=?', a.id)
  res.json({ ok: true, cost })
})

// 创建比赛：只生成唯一比赛记录，此时不发奖；动画结束后由 /finish 原子结算。
app.post('/api/races/:cid/start', (req, res) => {
  const cid = Number(req.params.cid)
  const active = getActiveRecordRow()
  if (active) {
    const activeCircuit = get('SELECT * FROM circuits WHERE id=?', active.circuit_id)
    if (activeCircuit && activeCircuit.id !== cid) {
      return res.json({ ok: false, msg: `请先续看《${activeCircuit.name}》的进行中比赛` })
    }
    return res.json({ ok: true, resumed: true, record: serializeRecord(active), serverNow: nowMs() })
  }

  const c = get('SELECT * FROM circuits WHERE id=?', cid)
  if (!c) return res.json({ ok: false, msg: '该赛站不存在' })
  const cur = nextCircuit()
  if (!cur) return res.json({ ok: false, msg: '本赛季已全部完赛' })
  if (cur.id !== cid) return res.json({ ok: false, msg: '请按航线顺序参赛' })
  const existing = getCircuitRecordRow(cid)
  if (existing?.status === 'completed') return res.json({ ok: false, msg: '该站已完赛，可查看历史回放' })

  const race = buildRace(c)
  const r = run(`INSERT INTO race_records
    (circuit_id,season,status,started_at,duration_ms,rank,pts,money,wear,parts_dur,rep_gain,data)
    VALUES (?,?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id, teamCore().season, race.startedAt, race.durationMs,
    race.rank, race.pts, race.money, race.wear, race.partsDurAfter, race.repGain, JSON.stringify(race.data))
  const record = serializeRecord(getRecordRow(Number(r.lastInsertRowid)))
  res.json({ ok: true, record, serverNow: nowMs() })
})

app.get('/api/races/active', (_, res) => {
  res.json({ ok: true, record: serializeRecord(getActiveRecordRow()), serverNow: nowMs() })
})
app.get('/api/races/:id', (req, res) => {
  const row = getRecordRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  res.json({ ok: true, record: serializeRecord(row), serverNow: nowMs() })
})
app.post('/api/races/:id/finish', (req, res) => {
  const row = getRecordRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  const result = finalizeRecord(row, { force: !!req.body?.force })
  if (result.error) return res.status(400).json({ ok: false, msg: result.error })
  if (result.tooEarly) return res.status(409).json({ ok: false, msg: '比赛尚未结束', remaining: result.remaining })
  res.json({ ok: true, ...result, serverNow: nowMs() })
})
app.post('/api/races/:id/view', (req, res) => {
  const row = getRecordRow(req.params.id)
  if (!row) return res.json({ ok: false })
  run('UPDATE race_records SET viewed=1 WHERE id=?', row.id)
  res.json({ ok: true })
})

// 兼容旧入口：新客户端不再直接使用，避免动画开始前就结算。
app.post('/api/race/:cid', (_, res) => {
  res.status(410).json({ ok: false, msg: '竞速已升级为分段比赛，请使用新的开赛接口' })
})

app.post('/api/reset', (_, res) => {
  ['race_records', 'race_log', 'sponsors', 'circuits', 'upgrades', 'mechanics', 'pilots', 'airships', 'team'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
  try { run('DELETE FROM sqlite_sequence') } catch (e) {}
  seed()
  res.json({ ok: true })
})

app.use((err, req, res, next) => {
  console.error('[SKY]', err)
  res.status(500).json({ ok: false, msg: err.message || '服务器错误' })
})

app.listen(PORT, () => console.log(`[SKY] API running at http://localhost:${PORT}`))
