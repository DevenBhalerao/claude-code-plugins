# Handoff

A Claude Code plugin that swaps a long chat for a short note you can read and edit.

## Why

Claude rereads the whole chat before every reply. A long chat uses more of your plan with each message, and Claude starts to lose track of early details. Claude Code can shrink a chat into a summary by itself, but you can't see or edit that summary.

Handoff gives you a note instead. Claude writes it, saves it as a file, and continues from it in the same window.

## How it works

1. Once the chat reaches 150k tokens, a bar appears above the message box: **Hand off now** or **Later (+50k)**.
2. Click **Hand off now**. Claude writes a note of under 800 words: the goal, the current state, decisions and why, what failed, the files that matter, and the next steps.
3. Claude saves the note to `.claude/handoffs/` in your project and swaps the chat for it.

You can also type `/handoff` at any time.

## Install

You need Claude Code 2.1.286 or later. Run these two commands in a terminal:

```bash
claude plugin marketplace add DevenBhalerao/claude-code-plugins
```

```bash
claude plugin install handoff@deven-plugins
```

Then restart Claude Code.

## Edit a note

1. Open `.claude/handoffs/latest.md` in your project and change it.
2. Type `/compact handoff` in the chat. Claude swaps the chat for your edited note.

If `latest.md` does not exist, nothing happens to the chat.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `threshold` | 150000 | The token count at which the bar appears. |
| `mode` | `button` | `button` waits for you. `auto` hands off by itself after Claude finishes a reply past the threshold. |

To change them:

```bash
echo '{"threshold":"120000","mode":"button"}' | claude plugin configure handoff@deven-plugins --values-stdin
```

Then restart Claude Code.

## Privacy

Notes can quote your chat. Handoff adds a `.gitignore` to the notes folder so git skips them. Check a note before you share it.
