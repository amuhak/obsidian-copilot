import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	SettingDefinitionItem,
} from "obsidian";
import { GhostwriterSettings, DEFAULT_SETTINGS } from "./settings";
import type { EditorView } from "@codemirror/view";
import {
	acceptFull,
	acceptWord,
	dismiss,
	ghostTextExtension,
	hasSuggestion,
} from "./ghost";
import { edit } from "./llm";

/** Obsidian exposes the underlying CodeMirror view as Editor.cm. */
function cmView(editor: Editor): EditorView | null {
	return ((editor as unknown as { cm?: EditorView }).cm) ?? null;
}

export default class GhostwriterPlugin extends Plugin {
	settings: GhostwriterSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		// Read settings through a closure so changes apply without a reload.
		this.registerEditorExtension(
			ghostTextExtension(
				() => this.settings,
				() => this.openInlineEdit()
			)
		);
		this.addSettingTab(new GhostwriterSettingTab(this.app, this));

		// Registered as commands (not a CodeMirror keymap) so they appear in the
		// Hotkeys tab and can be rebound. Returning false when there is nothing
		// to accept is what lets Tab fall through to normal list indentation.
		this.addCommand({
			id: "accept-line",
			name: "Accept suggestion (whole line)",
			hotkeys: [{ modifiers: [], key: "Tab" }],
			editorCheckCallback: (checking: boolean, editor: Editor) => {
				const view = cmView(editor);
				if (!view || !hasSuggestion(view)) return false;
				if (checking) return true;
				acceptFull(view);
				return true;
			},
		});

		this.addCommand({
			id: "accept-word",
			name: "Accept suggestion (next word)",
			hotkeys: [{ modifiers: ["Mod"], key: "ArrowRight" }],
			editorCheckCallback: (checking: boolean, editor: Editor) => {
				const view = cmView(editor);
				if (!view || !hasSuggestion(view)) return false;
				if (checking) return true;
				acceptWord(view);
				return true;
			},
		});

		// Escape is bound in the CodeMirror keymap (a default hotkey on Escape
		// would be far too intrusive), but the command is registered so the
		// action is discoverable in the Hotkeys tab and can be given a second key.
		this.addCommand({
			id: "dismiss-suggestion",
			name: "Dismiss suggestion",
			editorCheckCallback: (checking: boolean, editor: Editor) => {
				const view = cmView(editor);
				if (!view || !hasSuggestion(view)) return false;
				if (checking) return true;
				dismiss(view);
				return true;
			},
		});

		// No hotkey here on purpose: Obsidian binds Ctrl+I to italics, and a
		// second binding on the same key only registers as a conflict. The CM6
		// keymap in ghost.ts claims Mod-i at editor level instead, which wins
		// outright. This command keeps it reachable from the palette.
		this.addCommand({
			id: "inline-edit",
			name: "Inline edit at cursor",
			editorCallback: (editor: Editor) =>
				new EditPromptModal(this.app, this, editor).open(),
		});

		this.addCommand({
			id: "toggle-completion",
			name: "Toggle inline completion",
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.saveSettings();
				new Notice(`Inline completion ${this.settings.enabled ? "on" : "off"}`);
			},
		});
	}

	private openInlineEdit() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		new EditPromptModal(this.app, this, view.editor).open();
	}

	async loadSettings() {
		const stored = (await this.loadData()) as Partial<GhostwriterSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class EditPromptModal extends Modal {
	private controller = new AbortController();

	constructor(
		app: App,
		private plugin: GhostwriterPlugin,
		private editor: Editor
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		const selection = this.editor.getSelection();

		contentEl.createEl("h3", {
			text: selection ? "Edit selection" : "Insert at cursor",
		});

		const input = contentEl.createEl("input", {
			type: "text",
			placeholder: "Turn this into inline latex",
			cls: "ghostwriter-prompt-input",
		});

		const status = contentEl.createDiv({ cls: "ghostwriter-prompt-status" });

		const submit = async () => {
			const instruction = input.value.trim();
			if (!instruction) return;
			status.setText("…");
			input.disabled = true;
			try {
				// Stream into the modal so there is something to read while the
				// model works, rather than a frozen "Thinking".
				const out = await edit(
					this.plugin.settings,
					instruction,
					selection,
					this.controller.signal,
					(acc) => status.setText(acc)
				);
				if (selection) this.editor.replaceSelection(out);
				else this.editor.replaceRange(out, this.editor.getCursor());
				this.close();
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				status.setText(`Failed: ${message}`);
				input.disabled = false;
			}
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void submit();
			}
		});

		window.setTimeout(() => input.focus(), 0);
	}

	onClose() {
		this.controller.abort();
		this.contentEl.empty();
	}
}

class GhostwriterSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: GhostwriterPlugin) {
		super(app, plugin);
	}

	// Declarative settings (1.13+). Obsidian reads and writes plugin.settings
	// directly and persists on change, so the closure the editor extension
	// holds sees updates without a reload. It also makes these searchable from
	// the settings search, which display() does not.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Server URL",
				desc: "Your LLM server. Use an IP address, not 'localhost'.",
				control: {
					type: "text",
					key: "baseUrl",
					placeholder: "http://127.0.0.1:8080",
				},
			},
			{
				name: "Model",
				desc: "Ignored by llama.cpp; used by backends that route on model name.",
				control: { type: "text", key: "model", placeholder: "local-model" },
			},
			{
				name: "API key",
				desc: "Optional. Sent as an Authorization: Bearer header when set.",
				control: { type: "text", key: "apiKey", placeholder: "(none)" },
			},
			{
				name: "Inline completion",
				desc: "Show ghost text as you type.",
				control: { type: "toggle", key: "enabled" },
			},
			{
				name: "Trigger delay",
				desc: "Idle time after typing before a suggestion is requested.",
				control: {
					type: "slider",
					key: "debounceMs",
					min: 100,
					max: 1500,
					step: 50,
					displayFormat: (v) => `${v} ms`,
				},
			},
			{
				name: "Max tokens",
				desc: "Upper bound on suggestion length.",
				control: { type: "slider", key: "maxTokens", min: 8, max: 128, step: 8 },
			},
			{
				name: "Context characters",
				desc: "How much text before the cursor is sent as context.",
				control: {
					type: "number",
					key: "contextChars",
					min: 200,
					max: 20000,
					step: 100,
				},
			},
			{
				name: "Override Ctrl+I in editor",
				desc:
					"Claim Ctrl+I for inline edit while typing, shadowing the built-in " +
					"italics command. The Hotkeys tab will still show italics as bound.",
				control: { type: "toggle", key: "overrideItalics" },
			},
		];
	}
}
