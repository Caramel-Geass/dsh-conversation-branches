# conversation-branches

> Read with questions: select any text in the main conversation and ask follow-ups in a side panel without interrupting it.

This directory is the **DeepSeek Harness 0.2.x (currently 0.2.1-rc.3) build** of the plugin. It is a self-contained two-face bundle:
`lib/index.js` (Host: branch storage + model Q&A) and `lib/client.js` (Client: selection popup, right dock panel, IM bubbles, streaming).

## Features

- **Select-to-ask** — select text in the main conversation → a floating input appears next to the selection → ask (Enter to send, Shift+Enter for a newline).
- **Right dock panel** — branches live in a panel docked to the window's right edge; drag its left edge to resize (300–560 px); the width is remembered.
- **IM-style bubbles** — your messages on the right (brand color), model replies on the left; replies stream in and render Markdown.
- **Follow-ups** — ask unlimited follow-ups inside a branch; each answer is grounded in the main conversation, the selection, and the branch's own Q&A history.
- **Jump back** — click a quoted selection and the main conversation scrolls back with a soft yellow highlight of the selected text.
- **Collapse** — collapse a branch to show only the selection + your first question; the state persists.
- **Durable by design** — branches are stored in the Harness storage domain (JSON backend under `$DSH_HOME/storages`), so they survive restarts.

## 0.2.x adaptation (versus the original build)

| Original (0.1 / 0.2.0) | This build (0.2.1-rc.3) |
| --- | --- |
| Branches appended to the session log as `fork/branch` events | Moved to `ctx.storageDomain`, the supported home for plugin data; the session log stays clean |
| Panel registered into the `details` slot + `ctx.layout.openDetails()` | 0.2.x no longer has a `details` slot: the panel is a self-drawn right dock inside `shell.overlay` |
| Remote descriptors carried `codec.schema` | 0.2.x validation requires a `codec.create()` factory |
| Peer requirement `^0.1.0-rc.6` | `engines.dsh >= 0.2.1-rc.3`; otherwise 0.2.1 refuses to mount the plugin as incompatible |

Old data is preserved: the first time a session is read and storage holds no branch for it, the Host replays that session's legacy `fork/branch` events read-only and imports them.

## Install (current Desktop app)

Requires DeepSeek Harness **≥ 0.2.1-rc.3**; older runtimes (0.2.0, 0.1) skip the plugin as incompatible.

```bash
./scripts/install.sh            # default profile: desktop; pass another profile name if needed
./scripts/uninstall.sh          # to remove
```

The script copies this directory into `~/.dsh/profiles/<profile>/node_modules/@caramel-geass/dsh-conversation-branches/`
and adds the package to that profile's `dependencies` and `dsh.profile.bundles`.

**Restart the app (⌘Q, then reopen) to load it.**

> Install as a real directory, not a symlink: the Host's bare imports (`zod`, `@deepseek-ai/*`) resolve relative to the package's location inside the profile.

## Layout

```
conversation-branches/
├── package.json        # bundle patch + dsh.client manifest
├── cordis.patch.yml    # inserts the Host row
├── lib/
│   ├── index.js        # Host: ConversationBranchesService (load/save/ask/askPoll)
│   └── client.js       # Client: selection popup + right dock panel (__ModuleLoader__ artifact)
├── locale/{zh,en}.json # title/description shown in the plugin manager
├── icon.svg
├── scripts/{install,uninstall}.sh
└── src/                # TypeScript source from the 0.1 era, kept for history only; not built
```

> `lib/` is the **hand-maintained release artifact**, not output from `src/`. Edit `lib/` directly and run an install check.
```

## How it works

- **Host** (`lib/index.js`): a `TypertRemoteService` exposing `load` / `save` / `ask` / `askPoll`.
  `ask` reads the main conversation's current model surface via `sessionQuery.readSurface`, assembles a focused prompt,
  and streams an answer with the default model from `agentDefaultModel.currentSelection()` through `llm.stream`.
- **Client** (`lib/client.js`): watches selections inside `[data-conversation-scroll]` and shows the popup;
  the panel is docked on the right by `shell.overlay`; it polls `askPoll` every 200 ms for streamed increments.

## License

MIT
