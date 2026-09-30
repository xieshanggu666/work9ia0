import express from 'express'
import { db, run, all, get } from './db.js'

const app = express()
app.use(express.json())
const PORT = 4180
const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
// 天气对整场比赛的总体系数（用于部件磨损判定等）
const WEATHER = { '晴': 1.0, '风': 0.96, '雨': 0.9, '雾': 0.84, '雷暴': 0.78 }
// 天气对三个分段的发挥系数：雾/雷暴在「中段云流」「冲线段」压制更大
const SEG_WEATHER = {
  '晴':   [1.00, 1.00, 1.00],
  '风':   [0.99, 0.94, 0.96],
  '雨':   [0.94, 0.89, 0.91],
  '雾':   [0.92, 0.80, 0.85],
  '雷暴': [0.88, 0.72, 0.78]
}
// 三个分段：名称 + 四项性能在该段的权重（启航拼加速、中段拼极速转向、冲线拼极速爆发）
const SEGMENTS = [
  { key: 'start', name: '启航段', w: { speed: 0.28, turn: 0.14, acc: 0.30, dur: 0.10 } },
  { key: 'mid', name: '中段云流', w: { speed: 0.38, turn: 0.20, acc: 0.16, dur: 0.14 } },
  { key: 'finish', name: '冲线段', w: { speed: 0.40, turn: 0.14, acc: 0.20, dur: 0.14 } }
]
const SEG_K = 260           // 分段用时换算系数：t = SEG_K / pace（秒）
const AI_NAMES = ['苍穹极光', '翡翠之翼', '雷鸣环驾', '暮色猎手', '星尘漂流']
const AI_COLORS = ['#7ecbff', '#b19cff', '#6fe7d0', '#ff9fb0', '#ffb85c']
const PLAYER_COLOR = '#ffcf5c'
const FLAVOR = {
  '晴': ['晴空暖流，各艇全速巡航', '上升气流托举艇身，编队顺畅通航', '云絮拂面，引擎工况极佳'],
  '风': ['侧风突袭，舵面负荷加大！', '一阵横切气流扫过航线，队形被打乱', '逆风段来临，飞艇纷纷压低航向'],
  '雨': ['雨幕遮蔽视野，编队整体减速', '冰晶打在护甲上噼啪作响', '积雨云边缘湿滑，过弯需格外谨慎'],
  '雾': ['浓雾中能见度骤降，只能凭仪表飞行', '乳白雾气吞没了半个编队', '领航员紧盯着罗盘穿出雾团'],
  '雷暴': ['一道惊雷掠过，护甲承受冲击！', '雷暴电场干扰仪表，航向微微偏移', '闪电点亮云谷，众艇冒死突进']
}
const now = () => new Date().toLocaleString('zh-CN')
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// 确定性伪随机：同一场比赛的分段过程与事件只生成一次，之后回放永远一致
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seed() {
  if (get('SELECT COUNT(*) c FROM team').c > 0) return
  run('INSERT INTO team (name) VALUES (?)', '苍穹疾风战队')
  run('INSERT INTO airships (name) VALUES (?)', '云雀·I').lastInsertRowid
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
function leadPilot() { return all('SELECT * FROM pilots ORDER BY (skill+courage) DESC')[0] || null }
function topMech() { return all('SELECT * FROM mechanics ORDER BY skill DESC')[0] || null }
function leadership(p) {
  if (!p) return 20
  return (p.skill + p.courage) / 2 * 0.4 + p.exp * 0.15 + (p.mood - 50) * 0.08
}
function mechBonus(m) {
  if (!m) return 10
  return m.skill * 0.12 + (m.mood - 50) * 0.06
}
// 赛站必须按 id（航线下行→上行）顺序参赛，前一站未完赛前后续赛站一律锁定
function orderedCircuits() { return all('SELECT * FROM circuits ORDER BY id ASC') }
// 当前唯一允许参赛的赛站：航线上第一个未完成的赛站；全部完赛时为 null
function nextCircuit() { return orderedCircuits().find(c => !c.finished) || null }

/* ================= 比赛记录：动画 / 实时排名 / 最终奖励共用的唯一事实来源 ================= */

// 某分段内「性能发挥」→ pace：受天气、改装（已含在 st）、部件健康、机师/技工状态共同影响
function playerPace(st, seg, wF, lead, mech, grit, rng) {
  const statPts = st.speed * seg.w.speed + st.turn * seg.w.turn + st.acc * seg.w.acc + st.dur * seg.w.dur
  const parts = clamp(st.parts_dur / 100, 0.62, 1.12)
  const wEff = 1 - (1 - wF) * grit                    // 机师胆识越高，越能扛住坏天气
  const raw = (statPts * parts * wEff + lead + mech)
  return raw * (1 + (rng() * 0.22 - 0.11))
}
function aiPace(ai, seg, wF, rng) {
  const grit = 0.5 + ai.courage / 200                // 对手机师的天气抗性（与玩家同口径）
  const wEff = 1 - (1 - wF) * grit
  const statPts = 57 + 6 * ai.diff + ai.skill * 0.07
  const crew = ai.skill * 0.17 + ai.courage * 0.06 + (ai.mood - 50) * 0.04
  const profile = ai.profile[SEGMENTS.indexOf(seg)]  // 每艘 AI 艇的分段特长
  return (statPts + crew) * wEff * profile * (1 + (rng() * 0.18 - 0.09))
}

// 生成完整比赛记录（结果在开赛瞬间即确定，后续只是对这份记录的播放与结算）
function buildRace(c) {
  const t = teamCore()
  const st = fleetStats()
  const pilot = leadPilot()
  const mech = topMech()
  const mods = all('SELECT * FROM upgrades WHERE equipped=1').map(u => ({ id: u.id, name: u.name, slot: u.slot, stat: u.stat, bonus: u.bonus }))
  const lead = leadership(pilot)
  const mechB = mechBonus(mech)
  const grit = 0.5 + (pilot?.courage || 50) / 200
  const segW = SEG_WEATHER[c.weather] || [1, 1, 1]
  const rng = mulberry32((Date.now() & 0xffffffff) ^ (c.id * 2654435761))

  // 5 名对手，共 6 艇竞技；各自带机师状态与分段特长，档位参差保证每场有慢艇也有快车
  const ais = AI_NAMES.map((name, i) => ({
    name, color: AI_COLORS[i], diff: c.diff,
    skill: 48 + c.diff * 4 + Math.floor(rng() * 10) + (-17 + Math.floor(rng() * 40)),
    courage: 40 + Math.floor(rng() * 40),
    mood: 58 + Math.floor(rng() * 38),
    profile: [0.97 + rng() * 0.06, 0.97 + rng() * 0.06, 0.97 + rng() * 0.06]
  }))

  const racers = [{ id: 'p', name: t.name, color: PLAYER_COLOR, isPlayer: true, paces: [], segW: [], times: [], entry: [0] }]
  ais.forEach(ai => racers.push({ id: 'ai' + ai.name, name: ai.name, color: ai.color, isPlayer: false, ai, skill: ai.skill, courage: ai.courage, mood: ai.mood, paces: [], segW: [], times: [], entry: [0] }))

  SEGMENTS.forEach((seg, si) => {
    racers.forEach(r => {
      const gritP = r.isPlayer ? grit : (0.5 + r.ai.courage / 200)
      const wF = segW[si]                            // 同一场天气对所有艇一致，差异只在机师抗性
      const wEff = 1 - (1 - wF) * gritP
      const pace = r.isPlayer
        ? playerPace(st, seg, wF, lead, mechB, grit, rng) * (1 + c.diff * 0.006)
        : aiPace(r.ai, seg, wF, rng)
      const time = SEG_K / Math.max(1, pace)
      r.paces.push(Math.round(pace * 100) / 100)
      r.segW.push(Math.round(wEff * 1000) / 1000)
      r.times.push(Math.round(time * 1000) / 1000)
      r.entry.push(Math.round((r.entry[si] + time) * 1000) / 1000)
    })
  })
  racers.forEach(r => { r.total = r.entry[3] })

  // 总用时排序得最终名次（玩家名次），动画、LIVE 榜、奖励全部以此为准
  const order = [...racers].sort((a, b) => a.total - b.total)
  const rank = order.findIndex(r => r.isPlayer) + 1
  const pts = PTS[rank - 1] || 1
  const money = Math.round((600 + (7 - rank) * 180) * (1 + c.diff * 0.05))
  const wear = 5 + c.diff * 3 + (WEATHER[c.weather] < 0.9 ? 4 : 0)
  const repGain = Math.max(1, 5 - rank + c.diff)

  // 分段事件：分段节点的名次变化（超车）+ 天气氛围事件，计时锚点取玩家艇自身时间轴
  const events = []
  const flavors = FLAVOR[c.weather] || FLAVOR['晴']
  let prevRank = null
  SEGMENTS.forEach((seg, si) => {
    const segOrder = [...racers].sort((a, b) => a.entry[si + 1] - b.entry[si + 1])
    const pRank = segOrder.findIndex(r => r.isPlayer) + 1
    const tEnd = racers[0].entry[si + 1]
    if (prevRank && pRank < prevRank) {
      const behind = segOrder[pRank] // segOrder 为 0 基；玩家位于 pRank-1，紧随其后的即索引 pRank
      events.push({ t: +(tEnd - 0.35).toFixed(2), type: 'overtake', text: `你在「${seg.name}」超越 ${behind ? behind.name : '对手'}，升至第 ${pRank} 位！` })
    }
    events.push({ t: +(racers[0].entry[si] + racers[0].times[si] * 0.5).toFixed(2), type: 'flavor', text: flavors[Math.floor(rng() * flavors.length)] })
    prevRank = pRank
  })
  events.sort((a, b) => a.t - b.t)

  racers.forEach(r => { delete r.ai }) // ai 仅引擎内部使用，其字段已展开到记录顶层
  const duration = Math.max(...racers.map(r => r.total)) + 0.15
  return {
    v: 1,
    circuit: { id: c.id, name: c.name, diff: c.diff, weather: c.weather },
    season: t.season,
    segments: SEGMENTS.map(s => ({ key: s.key, name: s.name })),
    factors: {
      weather: c.weather,
      weatherCoeff: WEATHER[c.weather] || 1,
      segWeather: segW,
      base: { speed: st.speed - mods.filter(m => m.stat === 'speed').reduce((a, m) => a + m.bonus, 0),
        turn: st.turn - mods.filter(m => m.stat === 'turn').reduce((a, m) => a + m.bonus, 0),
        acc: st.acc - mods.filter(m => m.stat === 'acc').reduce((a, m) => a + m.bonus, 0),
        dur: st.dur - mods.filter(m => m.stat === 'dur').reduce((a, m) => a + m.bonus, 0) },
      parts_dur: st.parts_dur,
      mods,
      pilot: pilot ? { id: pilot.id, name: pilot.name, skill: pilot.skill, courage: pilot.courage, exp: pilot.exp, mood: pilot.mood } : null,
      mech: mech ? { id: mech.id, name: mech.name, skill: mech.skill, mood: mech.mood } : null,
      detail: { parts: +clamp(st.parts_dur / 100, 0.62, 1.12).toFixed(2), lead: +lead.toFixed(1), mech: +mechB.toFixed(1), grit: +grit.toFixed(2) }
    },
    racers,
    events,
    result: { rank, pts, money, wear, repGain },
    duration: +duration.toFixed(2)
  }
}

// 读取/解析比赛记录
const parseRace = r => (r ? { ...r, settled: !!r.settled, record: JSON.parse(r.record) } : null)
function getRaceRow(id) { return get('SELECT * FROM races WHERE id=?', Number(id)) }
function settleRace(id) {
  const row = getRaceRow(id)
  if (!row) return { ok: false, status: 404, msg: '比赛记录不存在' }
  if (row.settled) return { ok: true, already: true, race: parseRace(row) } // 幂等：重复结算直接返回，不重复发奖

  const rec = JSON.parse(row.record)
  const c = get('SELECT * FROM circuits WHERE id=?', row.circuit_id)
  db.exec('BEGIN')
  try {
    if (c?.finished) { // 极端兜底：赛站已完赛则只补齐记录状态，绝不重复发奖
      run("UPDATE races SET status='settled', settled=1, settled_at=? WHERE id=?", now(), row.id)
    } else {
      const { rank, pts, money, wear, repGain } = rec.result
      const a = airship()
      const newPd = Math.max(10, a.parts_dur - wear)
      run('UPDATE airships SET parts_dur=?, hp=? WHERE id=?', newPd, Math.max(20, a.hp - wear), a.id)
      if (rec.factors.pilot) {
        run('UPDATE pilots SET exp=exp+?, mood=MIN(100,MAX(0,mood-?)) WHERE id=?',
          rank <= 4 ? 3 : 1, rank > 8 ? 6 : 2, rec.factors.pilot.id)
      }
      run('UPDATE team SET money=money+?, rep=rep+?, season_pts=season_pts+? WHERE id=1', money, repGain, pts)
      const ranksDone = all('SELECT rank FROM circuits WHERE finished=1')
      const best = Math.min(rank, ...ranksDone.map(r => r.rank))
      run('UPDATE team SET season_pos=? WHERE id=1', Math.max(1, best))
      run('UPDATE circuits SET finished=1, rank=? WHERE id=?', rank, row.circuit_id)
      const note = rec.factors.weather === '晴' ? `晴空万里，${rec.circuit.name}` : `${rec.factors.weather}天，${rec.circuit.name}`
      run('INSERT INTO race_log (circuit_id, race_id, season, rank, pts, money, note, ts) VALUES (?,?,?,?,?,?,?,?)',
        row.circuit_id, row.id, rec.season, rank, pts, money, note, now())
      run("UPDATE races SET status='settled', settled=1, rank=?, pts=?, money=?, wear=?, rep_gain=?, settled_at=? WHERE id=?",
        rank, pts, money, wear, repGain, now(), row.id)
      reconcileSponsors() // 同一事务内对账赞助商
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { ok: true, already: false, race: parseRace(getRaceRow(id)) }
}
// 赞助商对账：以当前赛季积分为唯一事实来源，earned 与是否达标保持一致
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

// 历史数据兼容：修复「跳站参赛」产生的脏数据——首个未完成赛站之后的完赛记录
// 一律视为越站，回滚其积分/奖金/声望，删除流水并重置赛站，再统一重算赞助与赛季名次。
// 部件磨损是完赛即发生的真实损耗，予以保留。
function reconcileLegacySkips() {
  const cs = orderedCircuits()
  const firstOpen = cs.findIndex(c => !c.finished)
  if (firstOpen === -1) return
  const skipped = cs.slice(firstOpen + 1).filter(c => c.finished)
  if (!skipped.length) return

  let ptsBack = 0, moneyBack = 0, repBack = 0
  skipped.forEach(c => {
    all('SELECT * FROM race_log WHERE circuit_id=?', c.id).forEach(l => {
      ptsBack += l.pts || 0
      moneyBack += l.money || 0
      run('DELETE FROM race_log WHERE id=?', l.id)
    })
    repBack += Math.max(1, 5 - (c.rank || 6) + c.diff)
    console.log(`[SKY] 历史修复：赛站《${c.name}》在前置赛站未完成时已完赛（名次 ${c.rank}），回滚战绩与奖励`)
    run('UPDATE circuits SET finished=0, rank=NULL WHERE id=?', c.id)
  })
  if (ptsBack || moneyBack || repBack) {
    run('UPDATE team SET season_pts=MAX(0,season_pts-?), money=money-?, rep=rep-? WHERE id=1', ptsBack, moneyBack, repBack)
  }

  reconcileSponsors()
  const ranks = orderedCircuits().filter(x => x.finished && x.rank).map(x => x.rank)
  run('UPDATE team SET season_pos=? WHERE id=1', ranks.length ? Math.max(1, Math.min(...ranks)) : 1)
  console.log(`[SKY] 历史修复完成：回滚 ${skipped.length} 个越站赛站，积分 -${ptsBack}，奖金 -${moneyBack}，声望 -${repBack}`)
}
seed()
reconcileLegacySkips()

/* ---------- 共享响应 ---------- */
const payload = () => {
  const t = teamCore()
  const st = fleetStats()
  const upgrades = all('SELECT * FROM upgrades')
  const pilots = all('SELECT * FROM pilots')
  const mechanics = all('SELECT * FROM mechanics')
  const circuits = orderedCircuits()
  const sponsors = all('SELECT * FROM sponsors')
  const log = all('SELECT * FROM race_log ORDER BY id DESC')
  const done = circuits.filter(c => c.finished).length
  // 中断续看：当前未结算的比赛（每场仅一场 running）；history 供历史回放
  const activeRow = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  const raceRows = all("SELECT * FROM races WHERE status='settled' ORDER BY id DESC")
  return {
    team: t, airship: st, upgrades, pilots, mechanics, circuits, sponsors, log,
    activeRace: parseRace(activeRow),
    races: raceRows.map(parseRace),
    seasonDone: done, seasonTotal: circuits.length
  }
}

app.get('/api/state', (_, res) => res.json(payload()))
app.get('/api/overview', (_, res) => res.json(payload()))

// 购买新升级件
app.post('/api/shop', (req, res) => {
  const { slot, stat, name, price, bonus } = req.body
  const t = teamCore()
  if (t.money < price) return res.json({ ok: false, msg: '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', price)
  const r = run('INSERT INTO upgrades (name,slot,stat,bonus,price,level) VALUES (?,?,?,?,?,1)', name || '神秘部件', slot, stat, bonus, price)
  res.json({ ok: true, msg: '已购入新部件', id: Number(r.lastInsertRowid) })
})
// 装备/卸下
app.post('/api/equip/:id', (req, res) => {
  const up = get('SELECT * FROM upgrades WHERE id=?', Number(req.params.id))
  // 同槽位卸下其他
  all('SELECT id FROM upgrades WHERE slot=? AND equipped=1 AND id!=?', up.slot, up.id).forEach(u => run('UPDATE upgrades SET equipped=0 WHERE id=?', u.id))
  run('UPDATE upgrades SET equipped=1 WHERE id=?', up.id)
  res.json({ ok: true })
})
app.post('/api/unequip/:id', (req, res) => {
  run('UPDATE upgrades SET equipped=0 WHERE id=?', Number(req.params.id))
  res.json({ ok: true })
})

// 人员
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
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE pilots SET skill=skill+2, mood=mood+2 WHERE id=?', Number(req.body.id) || all('SELECT id FROM pilots LIMIT 1')[0].id)
  res.json({ ok: true, msg: '完成特训，技巧+2' })
})

// 维护
app.post('/api/maintain', (req, res) => {
  const t = teamCore(); const a = airship()
  const cost = Math.round((100 - a.parts_dur) * 25)
  if (cost < 200 || t.money < 200) return res.status(200).json({ ok: false, cost, msg: cost < 200 ? '部件状态良好，无需维护' : '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE airships SET parts_dur=100, hp=100 WHERE id=?', a.id)
  res.json({ ok: true, cost })
})

/* ---------- 分段比赛：开赛（生成记录）/ 续看 / 进度 / 结算（幂等） ---------- */

// 开赛：仅允许按航线顺序挑战当前未完成的第一站；比赛记录在这一刻完整生成并落库
app.post('/api/races/start/:cid', (req, res) => {
  const cid = Number(req.params.cid)
  // 已有进行中的比赛 → 直接返回原记录用于「中断续看」，绝不重开、不重复结算
  const active = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  if (active) return res.json({ ok: true, resumed: true, race: parseRace(active) })

  const c = get('SELECT * FROM circuits WHERE id=?', cid)
  if (!c) return res.json({ ok: false, msg: '该赛站不存在' })
  if (c.finished) return res.json({ ok: false, msg: '该站已完赛' })
  const cur = nextCircuit()
  if (!cur) return res.json({ ok: false, msg: '本赛季已全部完赛' })
  if (cur.id !== cid) {
    const idx = orderedCircuits().findIndex(x => x.id === cid) + 1
    return res.json({ ok: false, msg: `请先完成第 ${orderedCircuits().findIndex(x => x.id === cur.id) + 1} 站《${cur.name}》，第 ${idx} 站尚未解锁` })
  }

  const record = buildRace(c)
  const r = run('INSERT INTO races (circuit_id, season, status, settled, record, watch_el, created_at) VALUES (?,?,?,?,?,?,?)',
    c.id, record.season, 'running', 0, JSON.stringify(record), 0, now())
  res.json({ ok: true, resumed: false, race: parseRace(getRaceRow(Number(r.lastInsertRowid))) })
})

// 单场比赛记录（历史回放 / 刷新续看进度）
app.get('/api/races/:id', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  res.json({ ok: true, race: parseRace(row) })
})

// 上报观赛进度（中断续看锚点），只影响播放位置，与结算无关
app.post('/api/races/:id/progress', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  if (row.settled) return res.json({ ok: true }) // 已结算无需再记进度
  const el = clamp(Number(req.body?.el) || 0, 0, JSON.parse(row.record).duration)
  run('UPDATE races SET watch_el=? WHERE id=?', el, row.id)
  res.json({ ok: true, watch_el: el })
})

// 结算：以比赛记录为唯一依据；幂等，重复/断线重放都只发一次奖
app.post('/api/races/:id/settle', (req, res) => {
  try {
    const r = settleRace(Number(req.params.id))
    if (r.status === 404) return res.status(404).json(r)
    res.json(r)
  } catch (e) {
    console.error('[SKY] 结算失败', e)
    res.status(500).json({ ok: false, msg: '结算失败，请重试' })
  }
})

// 重置（重置数据到初始种子）
app.post('/api/reset', (_, res) => {
  ['race_log', 'races', 'sponsors', 'circuits', 'upgrades', 'mechanics', 'pilots', 'airships', 'team'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
  try { run('DELETE FROM sqlite_sequence') } catch (e) {}
  seed()
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SKY] API running at http://localhost:${PORT}`))
