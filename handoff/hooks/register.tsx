import { atom, read, update } from 'claude-code'
import type { Engine, Register } from 'claude-code'

import type { Phase } from '../types'

// Compactions whose instructions start with this word swap the conversation for the
// handoff note. Every other compaction, automatic ones included, runs as normal.
const MARKER = 'handoff'
const DIR = '.claude/handoffs'
const LATEST = `${DIR}/latest.md`

const HANDOFF_PROMPT = `Write a handoff note so that a fresh context, with no memory of this conversation, can continue the work.
Reply with only the note, in Markdown, under 800 words, using these sections:

## Goal
## Current state
## Decisions and why
## Tried and failed (and why)
## Files that matter
(paths with one line each; do not paste code)
## Next steps
(numbered)
## Open questions for the user

Leave out secrets such as API keys, tokens or passwords.`

const tokens = atom({ plugin: 'handoff', key: 'tokens' } as const, null)
const phase = atom({ plugin: 'handoff', key: 'phase' } as const, 'idle' as Phase)
const snoozeUntil = atom({ plugin: 'handoff', key: 'snoozeUntil' } as const, 0)

const formatTokens = (count: number | null | undefined) =>
  count === null || count === undefined ? '?' : `${Math.round(count / 1000)}k`

async function refreshTokens($: Engine) {
  const used = (await $.session.usage()).context.tokens ?? null
  await update($, tokens, () => used)

  return used
}

// After a compaction the old count is wrong, and the real one only exists after the
// next response. Clear it so the bar hides until turn.complete measures again.
async function forgetTokens($: Engine) {
  await update($, tokens, () => null)
  await update($, snoozeUntil, () => 0)
}

// The whole handoff: ask Claude for the note, save it, then swap the conversation for it.
async function runHandoff($: Engine): Promise<string> {
  if ((await read($, phase)) !== 'idle') {
    return 'A handoff is already running.'
  }

  await update($, phase, () => 'writing')
  try {
    const before = (await $.session.usage()).context.tokens

    // A fork reuses this conversation's cache, so writing the note is cheap and
    // nothing appears in the transcript.
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!reply.isAnswered) {
      if (reply.reason === 'nothing-to-fork') {
        // The fork re-sends the main thread's last request, which lives only in the
        // running app: none exists in a new chat, after /clear, or in an old chat
        // reopened after a restart, until Claude replies once.
        return 'Nothing to hand off yet: Claude has not replied since this chat was opened. Send any message, wait for the reply, then try again.'
      }

      return `Handoff stopped: the note could not be written (${reply.reason}). Nothing was changed.`
    }

    const root = await $.session.root()
    const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
    const note = reply.text.trim()
    await $.fs.write(`${root}/${DIR}/${stamp}.md`, note)
    await $.fs.write(`${root}/${LATEST}`, note)
    // Keep handoff notes out of git: they may quote things from the chat.
    await $.fs.write(`${root}/${DIR}/.gitignore`, '*\n')

    await update($, phase, () => 'compacting')
    let result
    try {
      result = await $.session.compact({ instructions: MARKER })
    } catch {
      // The desktop app (an SDK session) can't compact from a plugin directly; it
      // only compacts through a /compact prompt. Queue `/compact handoff` instead:
      // the session.compact hook below still swaps in the note when it runs.
      await $.command.run({ command: 'compact', args: MARKER })

      return `Handoff note saved to ${DIR}/${stamp}.md. Swapping it in now...`
    }
    if (result.skip !== undefined) {
      return `Handoff skipped: ${result.skip}`
    }

    const after = await refreshTokens($)
    await update($, snoozeUntil, () => 0)

    return `Handed off: ${formatTokens(before)} -> ${formatTokens(after)} tokens. Note saved to ${DIR}/${stamp}.md`
  } catch (error) {
    return `Handoff failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    await update($, phase, () => 'idle')
  }
}

// Runs the handoff outside whatever event asked for it, so it never waits on itself.
function startHandoff($: Engine) {
  $.clock.after(50, () => {
    void runHandoff($).then(text => $.ui.toast(text))
  })
}

export const register: Register = (on, options) => {
  const threshold = Number(options.threshold ?? 150000)
  const isAuto = options.mode === 'auto'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff note and swap the conversation for it',
    })
    await refreshTokens($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      return result
    }

    const used = await refreshTokens($)
    const isOver = used !== null && used >= threshold
    if (isAuto && isOver && !e.isAborted && (await read($, phase)) === 'idle') {
      startHandoff($)
    }

    return result
  })

  on('command.run', { command: 'handoff' }, async $ => {
    startHandoff($)

    return { text: 'Writing a handoff note. The conversation will be swapped for it in a moment.' }
  })

  on('session.compact', async ($, e, next) => {
    const isOurs = e.agentId === undefined && (e.instructions ?? '').trim().toLowerCase().startsWith(MARKER)
    if (!isOurs) {
      const result = await next(e)
      // Any compaction of the main conversation (manual or automatic) leaves the bar's
      // count stale. `precompute` is only a dry run ahead of time, so it changes nothing.
      if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in result)) {
        await forgetTokens($)
      }

      return result
    }

    const path = `${await $.session.root()}/${LATEST}`
    if (!(await $.fs.exists(path))) {
      // Never wipe the conversation with nothing to replace it.
      return { skip: `No handoff note at ${path}. Conversation left as it was.` }
    }

    const note = await $.fs.read(path)
    await forgetTokens($)
    $.ui.toast('Conversation swapped for the handoff note.')

    return {
      messages: [
        {
          role: 'user',
          text:
            'This conversation was reset to save context. Everything you need from the earlier work is in ' +
            `the handoff note below (saved at ${LATEST}). Treat it as the full context.\n\n${note}`,
          toolUses: [],
        },
        {
          role: 'assistant',
          text: 'Understood. I have read the handoff note and will continue from it.',
          toolUses: [],
        },
      ],
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, phase)
    if (now !== 'idle') {
      return (
        <Box>
          <Text dimColor>{now === 'writing' ? 'Writing handoff note...' : 'Swapping in the handoff note...'}</Text>
        </Box>
      )
    }

    const used = await read($, tokens)
    const showAt = Math.max(threshold, await read($, snoozeUntil))
    if (used === null || used < showAt) {
      return next(e)
    }

    return (
      <Box>
        <Text>Context is at {formatTokens(used)} tokens. </Text>
        <Button key="handoff" label="Hand off now" variant="primary" onPress={() => startHandoff($)} />
        <Text> </Text>
        <Button key="snooze" label="Later (+50k)" dimColor onPress={() => update($, snoozeUntil, () => used + 50000)} />
      </Box>
    )
  })
}
