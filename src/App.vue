<script setup>
import { ref } from 'vue'
import { useSkyStore } from '@/store/sky'
import MainScene from '@/components/MainScene.vue'
import RaceAnim from '@/components/RaceAnim.vue'
import HangarDrawer from '@/components/HangarDrawer.vue'
import TrophyDrawer from '@/components/TrophyDrawer.vue'

const store = useSkyStore()
const drawer = ref('')
const raceView = ref(null) // { mode: 'live' | 'replay', record, initialNow }

async function openRecord(record, mode = 'live', initialNow = Date.now()) {
  raceView.value = { record, mode, initialNow }
}
async function startRace(cid) {
  const r = await store.startRace(cid)
  if (r.ok) openRecord(r.record, 'live', r.serverNow)
  else store.tip(r.msg || '当前还不能参加该站')
}
async function resumeRace() {
  if (!store.activeRace) return
  const r = await store.fetchActiveRace()
  if (r.ok && r.record) openRecord(r.record, 'live', r.serverNow)
  else store.tip('比赛记录已不存在')
}
async function replayRace(raceId) {
  const r = await store.fetchRace(raceId)
  if (r.ok && r.record) openRecord(r.record, 'replay', r.serverNow)
  else store.tip(r.msg || '暂无回放记录')
}
async function onRaceFinished(record) {
  if (record) raceView.value = { ...raceView.value, record }
}
async function goBackFromRace() {
  raceView.value = null
  await store.refresh()
}
function openHangar() { drawer.value = drawer.value === 'hangar' ? '' : 'hangar' }
function openTrophy() { drawer.value = drawer.value === 'trophy' ? '' : 'trophy' }

store.init().then(async () => {
  const s = store.state
  const active = s?.activeRace
  const unseenCompleted = s?.races?.find(r => r.status === 'completed' && !r.viewed)
  // 进行中比赛按真实时钟续看；上局已完赛但未看结算，以回放模式重放动画（不会再结算）
  if (active) openRecord(active, 'live', s.serverNow)
  else if (unseenCompleted) openRecord(unseenCompleted, 'replay', s.serverNow)
})
</script>

<template>
  <div class="game">
    <div v-if="store.toast" class="toast">✨ {{ store.toast }}</div>

    <!-- 顶栏状态条 -->
    <header class="topbar">
      <div class="brand">
        <div class="logo">🛸</div>
        <div class="t">天空之城<small>AIRWAVE RACING · S{{ store.team.season }}</small></div>
      </div>
      <div class="stat-chips">
        <span class="chipx"><b class="ic">🪙</b> ¥{{ store.team.money?.toLocaleString() }}</span>
        <span class="chipx"><b class="ic">✨</b> 声望 {{ store.team.rep }}</span>
        <span class="chipx gold"><b class="ic">🏅</b> 积分 {{ store.team.season_pts }}</span>
        <span class="chipx"><b class="ic">🗼</b> {{ store.state ? store.state.seasonDone + ' / ' + store.state.seasonTotal + ' 站' : '' }}</span>
      </div>
    </header>

    <!-- 主游戏场景：云海浮岛航线图 -->
    <MainScene class="scene" @start="startRace" @resume="resumeRace" @replay="replayRace" />

    <!-- 竞速镜头：实时比赛、断点续看、历史回放共用同一记录 -->
    <RaceAnim
      v-if="raceView"
      :key="raceView.record.id + '-' + raceView.mode"
      :record="raceView.record"
      :mode="raceView.mode"
      :initial-now="raceView.initialNow"
      @back="goBackFromRace"
      @finished="onRaceFinished"
    />

    <!-- 右下操作钮 -->
    <div class="fab-col">
      <button class="fab" :class="{ on: drawer === 'trophy' }" @click="openTrophy">🏆<span>赛季之巅</span></button>
      <button class="fab" :class="{ on: drawer === 'hangar' }" @click="openHangar">✈️<span>机库</span></button>
    </div>

    <!-- 抽屉 -->
    <transition name="slide">
      <div v-if="drawer === 'hangar'"><HangarDrawer @close="drawer = ''" /></div>
    </transition>
    <transition name="slide">
      <div v-if="drawer === 'trophy'"><TrophyDrawer @close="drawer = ''" @replay="replayRace" /></div>
    </transition>
  </div>
</template>
