export interface GhostwriterSettings {
	/** llama.cpp server base URL. Use an IP, not "localhost" - see llm.ts. */
	baseUrl: string;
	model: string;
	/** Characters of text before the cursor sent as context. */
	contextChars: number;
	/**
	 * One line describing what the vault is about, prepended to every
	 * completion prompt. A note title alone ("Lecture 12") often says nothing.
	 */
	subject: string;
	/** Idle time after typing before a completion is requested. */
	debounceMs: number;
	maxTokens: number;
	temperature: number;
	/** llama.cpp defaults this to 1.0 (off), which lets the model loop. */
	repeatPenalty: number;
	enabled: boolean;
	/** Optional bearer token, for a server behind an authenticating proxy. */
	apiKey: string;
	/**
	 * Claim Ctrl+I inside the editor via CodeMirror, shadowing the built-in
	 * italics command. Off by default: it wins silently, and the Hotkeys tab
	 * still shows italics as bound, so the conflict is invisible.
	 */
	overrideItalics: boolean;
}

export const DEFAULT_SETTINGS: GhostwriterSettings = {
	// llama.cpp's own default port. Deliberately not a real host: a shipped
	// default should point at the user's own machine, never at ours.
	baseUrl: "http://127.0.0.1:8080",
	// llama.cpp serves one model and ignores this field; it matters only for
	// backends that route by model name.
	model: "local-model",
	contextChars: 2000,
	subject: "",
	debounceMs: 300,
	maxTokens: 48,
	temperature: 0.2,
	repeatPenalty: 1.15,
	enabled: true,
	apiKey: "",
	overrideItalics: false,
};
