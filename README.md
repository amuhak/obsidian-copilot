# Ghostwriter

Inline completion and AI edits for Obsidian, backed by any LLM server you choose.

```
- A page fault occurs when▏a process accesses memory not in physical RAM
                          └─ Tab accepts · Ctrl+→ one word · Esc dismisses
```

It also does inline edits: put the cursor somewhere or select text, run *Inline edit at cursor*, and type an instruction like "turn this into inline latex".

## Setup

Needs a server exposing an OpenAI-compatible `/v1/completions`, plus `/v1/chat/completions` for inline edit. With llama.cpp:

```bash
llama-server -m model.gguf --host 127.0.0.1 --port 8080 --cache-reuse 256 -ngl 99
```

`--cache-reuse` is worth setting. Consecutive keystrokes share a prompt prefix, so llama.cpp can skip reprocessing the note — measured 700 ms → 180 ms to first token on a 27B model.

Then copy `main.js`, `manifest.json`, and `styles.css` from a [release](../../releases) into `<vault>/.obsidian/plugins/ghostwriter/`, enable it under Community plugins, and set **Server URL**.

Point it at an IP, not `localhost` — on Windows that resolves to IPv6 first and burns a failed connection on every request. The server can live on another machine; a Tailscale IP works fine.

## Keybindings

| Action | Default |
| --- | --- |
| Accept whole line | <kbd>Tab</kbd> |
| Accept next word | <kbd>Ctrl</kbd>+<kbd>→</kbd> |
| Dismiss suggestion | <kbd>Esc</kbd> |
| Inline edit at cursor | *unassigned* |
| Toggle inline completion | *unassigned* |

<kbd>Tab</kbd> and <kbd>Ctrl</kbd>+<kbd>→</kbd> only bind while a suggestion is on screen; otherwise they indent and jump by word as usual. Rebind anything in **Settings → Hotkeys**.

<kbd>Ctrl</kbd>+<kbd>I</kbd> is left to Obsidian's italics. Enable **Override Ctrl+I in editor** to claim it inside the editor instead — note the Hotkeys tab will still show italics as bound.

## Settings

| Setting | Default |
| --- | --- |
| Server URL | `http://127.0.0.1:8080` |
| Model | `local-model` — ignored by llama.cpp, used by backends that route on it |
| API key | empty — sent as `Authorization: Bearer` only when set |
| Trigger delay | 300 ms |
| Max tokens | 48 |
| Context characters | 2000 |

## Troubleshooting

- **Steady lag before every suggestion** — Server URL is probably `localhost`.
- **First suggestion in a note is slow, then fast** — expected; the cache warms after one request.
- **Nothing appears** — check the server is reachable, then the console (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>). Failures are silent by design so a dead server never interrupts typing.

## Development

```bash
npm install
npm run dev      # watch build
npm run deploy   # build + copy into test-vault/
```

To release: `npm version patch`, push, then tag with the same number and push tags. CI builds, attests, and publishes.

## License

MIT
