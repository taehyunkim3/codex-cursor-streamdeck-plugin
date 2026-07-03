# Agent Status for Stream Deck

Stream Deck plugin prototype that displays recent local Codex and Cursor agent sessions on individual keys.

## What It Shows

- One Stream Deck action instance maps to one session rank for the selected provider.
- Each key can use `Provider = Codex` or `Provider = Cursor Agent`.
- Add as many keys as your Stream Deck model has, then choose the provider per key.
- Provider split is not fixed. You can use any mix, such as all Codex, all Cursor, 3 + 3, 6 + 9, or one page per provider.
- Session order is dynamic within each provider. When activity changes, each key refreshes to the current session for that rank.
- Press a Codex key to open that ranked session in the Codex desktop app. Press a Cursor key to focus Cursor.
- Each key renders a dynamic status image:
  - spinning icon: task is currently open
  - filled icon: recently updated thread
  - outlined icon: no recent activity
- Subagent and internal approval sessions are hidden from the latest-session list.
- Completed tasks stop showing the spinning in-progress state as soon as the session writes `task_complete`.
- The first line shows the status icon and project folder name.
- Idle/recent keys show the thread title plus the latest conversation text at the bottom.
- Active keys omit the title and keep the latest conversation text updating in the main area.
- Text sizes can be tuned per key in the property inspector:
  - overall text scale
  - project name
  - title
  - active conversation text
  - bottom conversation text
- Optional bottom labels can be added per key, with a separate label font size. This is useful for labels like `CODEX` or `CURSOR`.

The plugin reads local Codex state from:

- `~/.codex/state_5.sqlite`
- `~/.codex/logs_2.sqlite`
- `~/.codex/session_index.jsonl` as fallback

The plugin reads local Cursor state from:

- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`

This uses local files only. It does not call OpenAI or any external API.

## Install For Local Testing

1. Copy or symlink `com.local.codex-status.sdPlugin` into Stream Deck's plugin folder.

   macOS:

   ```sh
   mkdir -p "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
   ln -s "$PWD/com.local.codex-status.sdPlugin" "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.local.codex-status.sdPlugin"
   ```

2. Restart Stream Deck.

3. Add the `Agent Session` action to as many keys as you want to monitor.

   `Deck columns` controls how automatic rank mapping follows the physical layout. For example, Stream Deck Mini uses 3 columns:

   ```text
   #1 #2 #3
   #4 #5 #6
   ```

   Larger models can use their own column count, or you can override every key with `Session slot`.

   Each rank always points to the current latest session list for that key's provider, so a newly active Codex session can move to Codex slot `#1`, while Cursor slots are ranked separately.

   Example splits:

   ```text
   Mini:       3 Codex + 3 Cursor
   15-key:     9 Codex + 6 Cursor
   XL/Page:   one page for Codex, one page for Cursor
   ```

   For mixed-provider layouts, set each key's `Provider` and `Session slot` explicitly. Example: the first Cursor key should usually be `Provider = Cursor Agent` and `Session slot = 1`, regardless of where it sits physically.

   Pressing a Codex key opens the current session for that rank using Codex's `codex://threads/<session-id>` desktop deeplink. Cursor keys currently focus the Cursor app because Cursor session deeplinks are not exposed in the local state this plugin reads.

## Local Checks

```sh
npm run check
npm run preview
node com.local.codex-status.sdPlugin/bin/plugin.js --preview --provider cursor
```

`npm run preview` prints the same session snapshot the plugin will use.

## Notes

Codex and Cursor do not currently expose documented public Stream Deck APIs for this workflow. This plugin reads local desktop state databases, so future storage changes may require updating the readers.
