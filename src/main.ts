import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

		const status = contentEl.createEl("div", { cls: "ghostwriter-prompt-status" });

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
				status.setText(`Failed: ${(e as Error).message}`);
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const save = () => this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc(
				"Your LLM server. Use an IP address, not 'localhost' — on Windows that " +
					"resolves to IPv6 first and wastes a failed connection on every request."
			)
			.addText((t) =>
				t.setValue(this.plugin.settings.baseUrl).onChange(async (v) => {
					this.plugin.settings.baseUrl = v.replace(/\/+$/, "");
					await save();
				})
			);

		new Setting(containerEl).setName("Model").addText((t) =>
			t.setValue(this.plugin.settings.model).onChange(async (v) => {
				this.plugin.settings.model = v;
				await save();
			})
		);

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				"Optional. Sent as an Authorization: Bearer header. Leave empty for " +
					"a local llama.cpp server; needed if you put it behind a proxy " +
					"that requires auth."
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("(none)")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v) => {
						this.plugin.settings.apiKey = v.trim();
						await save();
					});
			});

		new Setting(containerEl)
			.setName("Override Ctrl+I inside the editor")
			.setDesc(
				"Claim Ctrl+I for inline edit while typing, shadowing the built-in " +
					"italics command. Off by default because the Hotkeys tab still " +
					"shows italics as bound, so the conflict is invisible. Prefer " +
					"assigning a hotkey to \"Inline edit at cursor\" instead."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.overrideItalics).onChange(async (v) => {
					this.plugin.settings.overrideItalics = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Inline completion")
			.setDesc("Show ghost text as you type.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
					this.plugin.settings.enabled = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Trigger delay (ms)")
			.setDesc("Idle time after typing before a suggestion is requested.")
			.addSlider((s) =>
				s
					.setLimits(100, 1500, 50)
					.setValue(this.plugin.settings.debounceMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.debounceMs = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Max tokens")
			.setDesc("Upper bound on suggestion length.")
			.addSlider((s) =>
				s
					.setLimits(8, 128, 8)
					.setValue(this.plugin.settings.maxTokens)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxTokens = v;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Context characters")
			.setDesc("How much text before the cursor is sent as context.")
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.contextChars))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.contextChars = n;
							await save();
						}
					})
			);
	}
}
