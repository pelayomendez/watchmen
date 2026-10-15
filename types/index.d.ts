export type Watch = { handoff?: string; skill?: string; startedAt: number; warned: boolean }

declare module 'claude-code' {
  interface PluginState {
    watchmen: { watch: Watch }
  }
}
