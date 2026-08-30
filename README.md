# Ghostwriter

Inline completion for Obsidian, powered by an LLM you run yourself.

Ghost text appears ahead of your cursor as you type. Press <kbd>Tab</kbd> to take the whole line, or <kbd>Ctrl</kbd>+<kbd>→</kbd> to take one word at a time. There is no cloud service, no API key required, and no telemetry — your notes never leave your own network.

It was built for taking lecture notes at speed: type the first half of a thought and let the model fill in the boilerplate.

```
- A page fault occurs when▏a process accesses memory that is not in physical RAM
                          └─ ghost text · Tab accepts the line · Ctrl+→ a word
```

## Features

- **Streamed ghost text.** Suggestions render token by token, so the first word or two appears almost immediately instead of after the whole sentence.
- **Word-at-a-time accept.** <kbd>Ctrl</kbd>+<kbd>→</kbd> takes a single word and keeps the remainder as a suggestion, for when the model is only half right.
- **Inline edit.** Place the cursor or select text, run *Inline edit at cursor*, and type an instruction — "turn this into inline latex", "make this a bullet list". The rewrite streams into the dialog before being applied.
- **Stays out of the way.** <kbd>Tab</kbd> still indents lists and <kbd>Ctrl</kbd>+<kbd>→</kbd> still jumps by word whenever no suggestion is on screen. <kbd>Esc</kbd> dismisses a suggestion and hands the keys straight back.
- **Any OpenAI-compatible server.** llama.cpp, or anything else exposing `/v1/completions`.

## Requirements

A server exposing an OpenAI-compatible `/v1/completions` endpoint — plus `/v1/chat/completions` if you want inline edit. [llama.cpp](https://github.com/ggml-org/llama.cpp) is the reference target:

```bash
llama-server -m your-model.gguf \
  --host 127.0.0.1 --port 8080 \
  --cache-reuse 256 \
  -ngl 99
```

### Choosing a model

Any general instruction-tuned model works; you do not need a code model. Notes are prose, and a broadly-trained model writes better prose about your subject than a small code-specialised one. Larger models give better suggestions but raise latency — the number to watch is time-to-first-token, not tokens per second, because you only read the first few words before deciding.

### Why `--cache-reuse` matters

While you type, each request shares a long prefix with the previous one, so llama.cpp can reuse its KV cache instead of reprocessing the whole note. On a 27B model this took time-to-first-token from roughly **700 ms to 180 ms**. Without the flag the cache only survives while text is appended at the end; with it, it also survives edits made higher up in the document.

### Use an IP address, not `localhost`

On Windows, `localhost` resolves to IPv6 `::1` before `127.0.0.1`. If your server is bound to IPv4 only — which `--host 0.0.0.0` is — every request opens with a connection attempt to an address nothing is listening on, and only falls back after it fails. Name resolution itself is free; the cost is the dead connection.

How much that costs depends on the client. Measured directly it was around two seconds, because the failed SYN waits on TCP retransmit timers. Obsidian runs on Chromium, which races both address families instead of waiting, so expect a few hundred milliseconds there. Either way it is pure waste on every keystroke. Use `http://127.0.0.1:8080`.

### Running the model on another machine

The server does not have to be on the machine you write on. Bind it to an interface the writing machine can reach and point the plugin at that address — a Tailscale IP works well. The plugin talks to the server directly with `fetch`, and llama.cpp sends permissive CORS headers, so nothing extra is needed in between.

## Installation

Until this is in the community directory, install it manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from a [release](../../releases).
2. Put them in `<your vault>/.obsidian/plugins/ghostwriter/`.
3. In Obsidian, open **Settings → Community plugins**, disable Restricted mode, and enable **Ghostwriter**.
4. Open **Settings → Ghostwriter** and set your **Server URL**.

## Keybindings

Everything is an ordinary Obsidian command. Rebind or clear any of it in **Settings → Hotkeys**.

| Action | Default | Behaviour |
| --- | --- | --- |
| Accept suggestion (whole line) | <kbd>Tab</kbd> | Falls through to list indent when no suggestion is showing. |
| Accept suggestion (next word) | <kbd>Ctrl</kbd>+<kbd>→</kbd> | Falls through to jump-by-word when no suggestion is showing. |
| Dismiss suggestion | <kbd>Esc</kbd> | Clears the suggestion and releases <kbd>Tab</kbd>. Falls through when nothing is showing. |
| Inline edit at cursor | *(unassigned)* | Opens the instruction dialog. |
| Toggle inline completion | *(unassigned)* | Turns ghost text on and off. |

Because <kbd>Tab</kbd> and <kbd>Ctrl</kbd>+<kbd>→</kbd> only take effect while a suggestion is visible, they never take a key away from you permanently. If a suggestion is in your way, press <kbd>Esc</kbd> and the keys behave normally again.

<kbd>Esc</kbd> is bound in the editor itself rather than as a default hotkey, since claiming Escape globally would be far too intrusive. The command is still listed under Hotkeys if you want to add a second key for it.

*Inline edit* and *Toggle inline completion* ship **unassigned** so they cannot collide with your existing setup. Assign whatever you like — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> is a good fit for inline edit.

### About <kbd>Ctrl</kbd>+<kbd>I</kbd>

Obsidian binds <kbd>Ctrl</kbd>+<kbd>I</kbd> to italics, so Ghostwriter leaves it alone by default. If you would rather use it for inline edit, enable **Override Ctrl+I in editor** in settings. That claims the key inside the editor only, at the CodeMirror level, so italics keeps working everywhere else. Be aware that the Hotkeys tab will still list italics as bound — the override is invisible from there, which is why it is off by default.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Server URL | `http://127.0.0.1:8080` | Your LLM server. Use an IP, not `localhost`. |
| Model | `local-model` | Ignored by llama.cpp; matters for backends that route by model name. |
| API key | *(empty)* | Optional. Sent as `Authorization: Bearer` only when set. Leave blank for a local server. |
| Inline completion | on | Master switch for ghost text. |
| Trigger delay | 300 ms | Idle time after typing before a request is sent. Raise it if suggestions feel noisy. |
| Max tokens | 48 | Upper bound on suggestion length. |
| Context characters | 2000 | How much text before the cursor is sent as context. |
| Override Ctrl+I in editor | off | See above. |

## Troubleshooting

**There is a consistent lag before every suggestion.** Check whether your Server URL says `localhost`. Use `127.0.0.1` instead — see above for why.

**The first suggestion in a note is slow, then it speeds up.** Expected. The first request processes the whole prefix; later ones reuse the cache. Start the server with `--cache-reuse 256` to widen the cases where that applies.

**Suggestions are low quality, or come back in the wrong language.** Check what sits immediately before your cursor. A prompt ending in a stray space is off-distribution for most tokenizers and produces markedly worse output. Ghostwriter trims trailing spaces before sending, but unusual trailing punctuation can have a similar effect.

**Suggestions are off-topic.** The model only sees *Context characters* worth of text before the cursor. On a nearly empty note there is little to go on; it improves as the note fills in.

**Nothing appears at all.** Confirm the server is reachable from the machine running Obsidian, then check the developer console (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>) for request errors. Ghostwriter fails silently by design — a dead server should never interrupt your typing.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build
```

`npm run install-local` copies the build into `test-vault/`, and `npm run deploy` does both at once. Reload Obsidian with *Reload app without saving* to pick up changes.

### Releasing

`.github/workflows/release.yml` builds and drafts a GitHub release on any tag push. The tag must match `manifest.json` exactly, with **no leading `v`**:

```bash
npm version patch      # bumps package.json, manifest.json and versions.json
git push
git tag -a 0.1.1 -m 0.1.1
git push --tags
```

## License

MIT — see [LICENSE](LICENSE).
