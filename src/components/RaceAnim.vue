<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSkyStore } from '@/store/sky'

const store = useSkyStore()
const props = defineProps({
  record: { type: Object, required: true },
  mode: { type: String, default: 'live' }, // live：实时/续看；replay：历史回放
  initialNow: { type: Number, default: 0 }
})
const emit = defineEmits(['back', 'finished'])

const wIco = { '晴': '🌤️', '风': '🌬️', '雨': '🌧️', '雾': '🌫️', '雷暴': '⛈️' }
const race = ref(props.record)
const isReplay = computed(() => props.mode === 'replay')
const circuit = computed(() => race.value.data?.circuit || {})
const factors = computed(() => race.value.data?.factors || {})
const entrants = computed(() => race.value.data?.entrants || [])
const segments = computed(() => factors.value.segments || [])
const player = computed(() => entrants.value.find(e => e.isPlayer) || {})

const clockOffset = ref((props.initialNow || store.serverNow || Date.now()) - Date.now())
const elapsed = ref(0)
const showSettle = ref(false)
const finishing = ref(false)
let raf = null
let finishSent = false

const serverNow = () => Date.now() + clockOffset.value
const duration = computed(() => race.value.duration_ms || 0)
const liveElapsed = computed(() => {
  if (race.value.status === 'completed') return duration.value
  return Math.min(duration.value, Math.max(0, serverNow() - (race.value.started_at || 0)))
})

function segmentState(e) {
  let before = 0
  for (let i = 0; i < (e.segments || []).length; i++) {
    const s = e.segments[i]
    if (elapsed.value < before + s.durationMs) {
      const p = Math.min(1, Math.max(0, (elapsed.value - before) / s.durationMs))
      return { index: i, progress: p, segment: s, before }
    }
    before += s.durationMs
  }
  return { index: e.segments?.length || 0, progress: 1, segment: e.segments?.at(-1), before }
}
function racerView(e) {
  const st = segmentState(e)
  const finished = elapsed.value >= (e.totalMs || duration.value)
  const x = finished ? 94 : 5 + ((st.index + st.progress) / Math.max(1, e.segments?.length || 4)) * 89
  return { ...e, x, segmentIndex: st.index, segmentProgress: st.progress, finished, current: st.segment }
}
const live = computed(() => entrants.value.map(racerView))
const rankLive = computed(() => [...live.value].sort((a, b) => {
  if (a.finished !== b.finished) return a.finished ? -1 : 1
  const ap = a.segmentIndex + a.segmentProgress
  const bp = b.segmentIndex + b.segmentProgress
  return bp - ap || a.rank - b.rank
}))
const currentSegmentIndex = computed(() => segmentState(player.value).index)
const currentSegment = computed(() => segments.value[currentSegmentIndex.value] || segments.value.at(-1))

async function settleAtFinish() {
  if (finishSent || finishing.value || isReplay.value || race.value.status === 'completed') return
  finishSent = true
  finishing.value = true
  const r = await store.finishRace(race.value.id, true).catch(() => ({ ok: false, msg: '网络异常，正在重试…' }))
  finishing.value = false
  if (r.ok) {
    if (r.record) race.value = r.record
    await store.refresh()
    if (r.record) race.value = r.record
    showSettle.value = true
    emit('finished', r.record)
  } else {
    // 结算失败不能吞掉：放开闸门并继续轮询，下一拍重试，保证奖励最终入账且只入一次
    finishSent = false
    store.tip(r.msg || '结算失败，正在重试…')
    raf = requestAnimationFrame(tick)
  }
}

function tick() {
  if (isReplay.value) {
    elapsed.value = Math.min(duration.value, elapsed.value + 16.7)
  } else {
    elapsed.value = liveElapsed.value
  }
  if (elapsed.value >= duration.value) {
    cancelAnimationFrame(raf)
    if (isReplay.value || race.value.status === 'completed') showSettle.value = true
    else settleAtFinish()
    return
  }
  raf = requestAnimationFrame(tick)
}
function restartReplay() {
  cancelAnimationFrame(raf)
  elapsed.value = 0
  showSettle.value = false
  raf = requestAnimationFrame(tick)
}
function goBack() { emit('back') }

onMounted(async () => {
  if (race.value.status === 'completed') await store.markRaceViewed(race.value.id)
  elapsed.value = isReplay.value ? 0 : liveElapsed.value
  if (!isReplay.value && race.value.status === 'running' && elapsed.value >= duration.value) {
    await settleAtFinish()
  }
  if (!showSettle.value || isReplay.value) raf = requestAnimationFrame(tick)
})
onUnmounted(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="race-ov">
    <div class="race-sky">
      <button class="race-close" @click="goBack">{{ race.status === 'running' && !isReplay ? '中断保存' : '返回' }}</button>
      <div class="race-title">
        <h3>🏁 {{ circuit.name }} · {{ isReplay ? '历史回放' : '分段竞速' }}</h3>
        <div class="sub2">
          {{ wIco[circuit.weather] }} {{ circuit.weather }} · 难度 {{ '★'.repeat(circuit.diff) }}
          · {{ isReplay ? '回放记录' : elapsed >= duration ? '冲线结算中' : 'LIVE 续看不会重赛' }}
        </div>
      </div>

      <!-- 同一份记录中的天气、改装、人员状态快照 -->
      <div class="factor-strip">
        <span><b>天气</b>{{ wIco[factors.weather] }} {{ factors.weather }} ×{{ factors.globalWeatherFactor }}</span>
        <span><b>部件</b>🔧 {{ Math.round(factors.partsFactor * 100) }}%</span>
        <span><b>改装</b>🧩 {{ factors.upgrades?.length ? factors.upgrades.map(u => u.name).join(' / ') : '原厂配置' }}</span>
        <span><b>机师</b>🧑‍✈️ {{ factors.pilot?.name || '无机师' }} · 心情{{ factors.pilot?.mood ?? '--' }}</span>
        <span><b>技工</b>🔧 {{ factors.mechanic?.name || '无技工' }} · 技能{{ factors.mechanic?.skill ?? '--' }}</span>
      </div>

      <div class="segment-progress">
        <div v-for="(s, i) in segments" :key="s.key" class="seg-chip" :class="{ on: i === currentSegmentIndex, done: i < currentSegmentIndex }">
          <em>{{ i + 1 }}</em>
          <div><b>{{ s.name }}</b><small>{{ s.statName }} ×{{ s.weatherFactor }} / 改装+{{ s.upgradeBonus }}</small></div>
        </div>
      </div>

      <!-- 赛道 + 实时榜（同一记录数据驱动） -->
      <div class="race-body">
        <div class="track">
          <div class="startline">起</div>
          <div class="finishline">冲线</div>
          <div v-for="(r, i) in live" :key="r.id" class="lane" :style="{ top: (8 + i * 14.7) + '%' }">
            <div class="lane-ratio">
              <div class="ship" :class="{ player: r.isPlayer, done: r.finished }"
                :style="{ left: `calc(${r.x}% - ${r.isPlayer ? 58 : 48}px)`, background: 'linear-gradient(120deg,' + r.color + ',' + r.color + 'cc)' }">
                <span class="s-icon">✈️</span>{{ r.name }}
              </div>
            </div>
            <div class="seg-event">{{ r.finished ? '🏁 完赛' : r.current?.name }}</div>
            <div class="pos" :class="{ 'pos-p': r.isPlayer }">{{ rankLive.findIndex(x => x.id === r.id) + 1 }}</div>
          </div>
        </div>

        <!-- 实时排位榜 -->
        <div class="board">
          <div class="board-h">{{ isReplay ? 'REPLAY' : 'LIVE' }}</div>
          <div v-for="(r, k) in rankLive" :key="r.id" class="board-row" :class="{ 'board-p': r.isPlayer }">
            <span class="bpos">{{ k + 1 }}</span>
            <span class="bname">{{ r.name }}<small v-if="!r.isPlayer">{{ (r.totalMs / 1000).toFixed(1) }}s</small></span>
            <span v-if="r.isPlayer" class="you">你</span>
          </div>
          <div class="board-seg" v-if="currentSegment">
            当前分段：{{ currentSegment.name }} · {{ currentSegment.statName }}×{{ currentSegment.weatherFactor }}<br />
            机师 {{ currentSegment.pilotContribution }} · 技工 {{ currentSegment.mechanicContribution }}
          </div>
        </div>
      </div>

      <!-- 结算卡：只读取比赛记录中已经锁定的奖励 -->
      <transition name="pop">
        <div v-if="showSettle" class="settle">
          <div class="medal">{{ race.rank <= 3 ? ['🥇', '🥈', '🥉'][race.rank - 1] : '🌊' }}</div>
          <div class="s-title">第 {{ race.rank }} 名</div>
          <div class="s-row"><span>积分</span><b>+{{ race.pts }}</b></div>
          <div class="s-row"><span>奖金</span><b>+¥{{ race.money }}</b></div>
          <div class="s-row"><span>部件磨损</span><b style="color:#ff9fb0">-{{ race.wear }}</b></div>
          <div class="s-row"><span>声望</span><b>+{{ race.repGain }}</b></div>
          <div class="s-note">{{ isReplay ? '历史回放不会重复结算' : '奖励已由唯一比赛记录一次性入账' }}</div>
          <button v-if="isReplay" class="btn ghost s-btn" @click="restartReplay">↻ 重新回放</button>
          <button class="btn primary s-btn" @click="goBack">返回航线 ▶</button>
        </div>
      </transition>
    </div>
  </div>
</template>
