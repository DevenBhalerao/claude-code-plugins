export type Phase = 'idle' | 'writing' | 'compacting'

declare module 'claude-code' {
  interface PluginState {
    handoff: { tokens: number | null; phase: Phase; snoozeUntil: number }
  }
}
