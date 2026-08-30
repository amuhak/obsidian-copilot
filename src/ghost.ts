import {
	Decoration,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
	keymap,
} from "@codemirror/view";
import { Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { GhostwriterSettings } from "./settings";
import { completeStream } from "./llm";

interface Suggestion {
	text: string;
	pos: number;
}

/** Setting a suggestion (or clearing it with null) always wins over invalidation. */
const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setSuggestion)) return e.value;
		// Any edit or cursor move we did not initiate invalidates the suggestion.
		// Our own accepts carry a setSuggestion effect and returned above.
		if (tr.docChanged || tr.selection) return null;
		return value;
	},
});

class GhostWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}
	eq(other: GhostWidget) {
		return other.text === this.text;
	}
	toDOM() {
		return createSpan({ cls: "ghostwriter-ghost", text: this.text });
	}
}

const ghostDecorations = EditorView.decorations.compute([suggestionField], (state) => {
	const s = state.field(suggestionField);
	if (!s || s.pos > state.doc.length) return Decoration.none;
	return Decoration.set([
		Decoration.widget({ widget: new GhostWidget(s.text), side: 1 }).range(s.pos),
	]);
});

/** True when there is ghost text on screen to act on. */
export function hasSuggestion(view: EditorView): boolean {
	return view.state.field(suggestionField, false) != null;
}

/** Take the whole suggested line. */
export function acceptFull(view: EditorView): boolean {
	const s = view.state.field(suggestionField);
	// Returning false is what lets Tab fall through to list-indent when there
	// is nothing to accept. Without this the plugin breaks normal editing.
	if (!s) return false;
	view.dispatch({
		changes: { from: s.pos, insert: s.text },
		selection: { anchor: s.pos + s.text.length },
		effects: setSuggestion.of(null),
	});
	return true;
}

/** Take one word, keep the rest as ghost text. */
export function acceptWord(view: EditorView): boolean {
	const s = view.state.field(suggestionField);
	if (!s) return false;
	const match = /^\s*\S+/.exec(s.text);
	const word = match ? match[0] : s.text;
	const rest = s.text.slice(word.length);
	const next = s.pos + word.length;
	view.dispatch({
		changes: { from: s.pos, insert: word },
		selection: { anchor: next },
		effects: setSuggestion.of(rest ? { text: rest, pos: next } : null),
	});
	return true;
}

/** Clear the current suggestion, releasing Tab back to the editor. */
export function dismiss(view: EditorView): boolean {
	if (!view.state.field(suggestionField)) return false;
	view.dispatch({ effects: setSuggestion.of(null) });
	return true;
}

function requestPlugin(getSettings: () => GhostwriterSettings) {
	return ViewPlugin.fromClass(
		class {
			timer: number | null = null;
			controller: AbortController | null = null;

			constructor(readonly view: EditorView) {}

			update(u: ViewUpdate) {
				if (!u.docChanged) return;
				// Our own accepts change the doc; don't let them retrigger.
				const ours = u.transactions.some((t) =>
					t.effects.some((e) => e.is(setSuggestion))
				);
				if (ours) return;
				this.schedule();
			}

			schedule() {
				const settings = getSettings();
				if (!settings.enabled) return;
				if (this.timer !== null) window.clearTimeout(this.timer);
				this.controller?.abort();
				this.timer = window.setTimeout(() => void this.run(), settings.debounceMs);
			}

			async run() {
				const settings = getSettings();
				const sel = this.view.state.selection.main;
				if (!sel.empty) return;
				const pos = sel.head;
				const prefix = this.view.state.sliceDoc(0, pos);
				if (!prefix.trim()) return;

				const controller = new AbortController();
				this.controller = controller;
				try {
					// Render each token as it lands rather than waiting for the
					// whole line, so the first word or two is visible almost
					// immediately.
					await completeStream(settings, prefix, controller.signal, (acc) => {
						if (controller.signal.aborted || !acc.trim()) return;
						// The cursor moved while the stream was open; the
						// suggestion no longer belongs anywhere.
						if (this.view.state.selection.main.head !== pos) {
							controller.abort();
							return;
						}
						this.view.dispatch({
							effects: setSuggestion.of({ text: acc, pos }),
						});
					});
				} catch {
					// Server down or request aborted: no suggestion, no noise.
				}
			}

			destroy() {
				if (this.timer !== null) window.clearTimeout(this.timer);
				this.controller?.abort();
			}
		}
	);
}

export function ghostTextExtension(
	getSettings: () => GhostwriterSettings,
	onInlineEdit: () => void
): Extension {
	return [
		suggestionField,
		ghostDecorations,
		requestPlugin(getSettings),
		// Prec.highest so these reach us before Obsidian's own bindings.
		// This is also how Mod-i beats the built-in italics command: CodeMirror
		// handles the key on the editor and calls preventDefault, so Obsidian's
		// hotkey manager never runs it. No manual unbinding required.
		// Accepting is registered as real Obsidian commands in main.ts so the
		// keys show up in the Hotkeys tab and can be rebound. Only the two that
		// cannot work that way live here: Escape (not worth a command) and the
		// opt-in italics override, which has to beat a core binding.
		Prec.highest(
			keymap.of([
				{ key: "Escape", run: dismiss },
				{
					key: "Mod-i",
					run: () => {
						// Returning false lets the built-in italics run instead.
						if (!getSettings().overrideItalics) return false;
						onInlineEdit();
						return true;
					},
				},
			])
		),
	];
}
