import { defineStore } from 'pinia'

const j = (p, o) => fetch(p, o).then(r => r.json())
const post = (p, b) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })

export const useSkyStore = defineStore('sky', {
  state: () => ({ state: null, loaded: false, toast: '', activeRace: null }),
  getters: {
    team: s => s.state?.team || {},
    airship: s => s.state?.airship || {},
    circuits: s => s.state?.circuits || [],
    upgrades: s => s.state?.upgrades || [],
    serverNow: s => s.state?.serverNow || Date.now()
  },
  actions: {
    async init() { await this.refresh(); this.loaded = true },
    async refresh() {
      this.state = await j('/api/state')
      this.activeRace = this.state?.activeRace || null
    },
    tip(msg) { this.toast = msg; setTimeout(() => this.toast = '', 2600) },
    async shop(b) { const r = await post('/api/shop', b); await this.refresh(); if (!r.ok) this.tip(r.msg); return r },
    async equip(id) { await post('/api/equip/' + id); await this.refresh() },
    async unequip(id) { await post('/api/unequip/' + id); await this.refresh() },
    async hirePilot() { const r = await post('/api/hire_pilot'); await this.refresh(); this.tip(r.msg); return r },
    async hireMech() { const r = await post('/api/hire_mech'); await this.refresh(); this.tip(r.msg); return r },
    async train(id) { const r = await post('/api/train', { id }); await this.refresh(); if (r.ok) this.tip(r.msg); else this.tip(r.msg); return r },
    async maintain() { const r = await post('/api/maintain'); await this.refresh(); if (r.ok) this.tip('维护完成，耗资 ' + r.cost); else this.tip(r.msg); return r },
    async startRace(cid) {
      const r = await post('/api/races/' + cid + '/start')
      if (r.ok) this.activeRace = r.record
      return r
    },
    async fetchRace(id) { return await j('/api/races/' + id) },
    async fetchActiveRace() {
      const r = await j('/api/races/active')
      this.activeRace = r.record || null
      return r
    },
    async finishRace(id, force = false) {
      const r = await post('/api/races/' + id + '/finish', { force })
      if (r.ok) this.activeRace = null
      return r
    },
    async markRaceViewed(id) { return await post('/api/races/' + id + '/view') },
    async reset() { await post('/api/reset'); await this.init() }
  }
})
