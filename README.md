# Codex Status for Stream Deck

Stream Deck plugin prototype that displays recent local Codex sessions on individual keys.

## What It Shows

- One Stream Deck action instance maps to one Codex session rank.
- On Stream Deck Mini, place the action on all 6 keys to show the latest 6 sessions from top-left to bottom-right.
- Session order is dynamic. When Codex activity changes, each key refreshes to the current session for that rank.
- Each key renders a dynamic status image:
  - `진행중`: recent Codex log activity
  - `최근`: recently updated thread
  - `대기`: no recent activity
- The key also shows the thread title, workspace folder, last activity age, and slot number.

The plugin reads local Codex state from:

- `~/.codex/state_5.sqlite`
- `~/.codex/logs_2.sqlite`
- `~/.codex/session_index.jsonl` as fallback

This uses local files only. It does not call OpenAI or any external API.

## Install For Local Testing

1. Copy or symlink `com.local.codex-status.sdPlugin` into Stream Deck's plugin folder.

   macOS:

   ```sh
   mkdir -p "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
   ln -s "$PWD/com.local.codex-status.sdPlugin" "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.local.codex-status.sdPlugin"
   ```

2. Restart Stream Deck.

3. Add the `Codex Session` action to all 6 Stream Deck Mini keys.

   The default layout uses 3 columns:

   ```text
   #1 #2 #3
   #4 #5 #6
   ```

   Each rank always points to the current latest session list, so a newly active session can move to `#1` and the other keys will shift on the next refresh. You can still override a key with `Session slot` in the property inspector if needed.

## Local Checks

```sh
npm run check
npm run preview
```

`npm run preview` prints the same session snapshot the plugin will use.

## Notes

Codex does not currently expose a documented public Stream Deck API. This plugin reads the local Codex Desktop state database and log database, so future Codex storage changes may require updating the reader.
