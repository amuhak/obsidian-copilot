import { GhostwriterSettings } from "./settings";

/** Only the fields we read off an SSE frame. */
interface CompletionChunk {
	choices?: { text?: string }[];
}
interface ChatChunk {
	choices?: { delta?: { content?: string } }[];
}

/** Where the cursor is, as much as the editor knows about it. */
export interface CompletionContext {
	/** Note title. The cheapest strong hint about the subject. */
	title: string;
	/** Document text before the cursor. */
	prefix: string;
}

/**
 * Completion + edit calls against a llama.cpp server.
 *
 * Uses plain fetch rather than Obsidian's requestUrl by design. requestUrl
 * buffers the whole response and offers no cancellation, which would remove
 * both token streaming and AbortController - the two things that make ghost
 * text feel immediate. llama.cpp echoes the
 * Origin header back as Access-Control-Allow-Origin and answers preflight, so
 * CORS is not an obstacle, and fetch gives us AbortController and streaming.
 *
 * Note on hosts: "localhost" on Windows resolves to ::1 before 127.0.0.1, so a
 * server bound to IPv4 only makes every request start with a dead connection
 * and fall back. Resolution itself is free; the failed connect is not. Cost
 * depends on the client - seconds when connects are tried in sequence, a few
 * hundred ms in Chromium, which races them. Always configure an explicit IP.
 */

/** Settings hold whatever was typed, so a trailing slash would double up here. */
function endpoint(settings: GhostwriterSettings, path: string): string {
	return `${settings.baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Bearer header only when a key is configured, so local servers stay unauthenticated. */
function headers(settings: GhostwriterSettings): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	if (settings.apiKey) h["Authorization"] = `Bearer ${settings.apiKey}`;
	return h;
}

/** Trailing run of word characters: the word the user is partway through. */
const PARTIAL_WORD = /[\p{L}\p{N}_'’-]+$/u;

/** Escape a literal for a GBNF double-quoted string. */
function gbnf(literal: string): string {
	return literal.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Set once a server answers 400 to a request carrying a grammar. llama.cpp
 * supports the field; other OpenAI-compatible backends may reject it outright,
 * and one wasted request is enough to learn that.
 */
let grammarUnsupported = false;

/**
 * A note opens with almost nothing above the cursor, so the first few lines
 * used to be completed blind. The title and the configured subject are known
 * from the very first keystroke and cost a handful of tokens, so they lead
 * every prompt. Being constant while typing, they sit in front of the KV cache
 * prefix rather than disturbing it.
 */
function buildPrompt(
	settings: GhostwriterSettings,
	ctx: CompletionContext,
	body: string
): string {
	const header: string[] = [];
	if (ctx.title) header.push(`# ${ctx.title}`);
	const subject = settings.subject.trim();
	if (subject) header.push(subject);
	const tail = body.slice(-settings.contextChars);
	return header.length ? `${header.join("\n")}\n\n${tail}` : tail;
}

/**
 * Streaming raw text continuation, for ghost text. No chat template applied.
 * Calls onToken with the accumulated text so far, then resolves with the whole
 * completion.
 */
export async function completeStream(
	settings: GhostwriterSettings,
	ctx: CompletionContext,
	signal: AbortSignal,
	onToken: (accumulated: string) => void
): Promise<string> {
	// Token healing. A prompt cut mid-word ("...that is not in phys") tokenizes
	// into fragments that never occur in that position in training data, and
	// the model answers off-distribution. Measured against a 27B model on real
	// notes, every one of six mid-word prefixes came back broken: "botom",
	// "follwing", "approprate", "overhhead", "deliv ery", and once a literal
	// soft hyphen. So cut the partial word off the prompt, have the model spell
	// the whole word itself, and subtract back what is already on screen.
	const partial = PARTIAL_WORD.exec(ctx.prefix)?.[0] ?? "";
	const base = ctx.prefix.slice(0, ctx.prefix.length - partial.length);

	// Never end the prompt with a bare space either. Tokenizers pack the space
	// into the following word (" need" is one token), so a dangling space token
	// is off-distribution the same way: in testing it made the model answer in
	// Chinese, emit "0 or 1." as a definition, and invent facts. Trim it, let
	// the model produce its own leading space, then drop that space on the way
	// out since the user already typed one.
	const trimmed = base.replace(/[ \t]+$/, "");
	// A healed word is by construction preceded by whitespace, a line start or
	// punctuation, so any whitespace the model emits first is ours to discard.
	const stripLead = partial
		? /^\s+/
		: trimmed.length !== base.length
			? /^[ \t]+/
			: null;

	/**
	 * Raw model output to the text that belongs on screen. Null means the model
	 * spelled the healed word differently from the user: ghost text can only
	 * append, so there is no honest way to show that and the suggestion is
	 * dropped. Only reachable when the server ignored the grammar below.
	 */
	const project = (raw: string): string | null => {
		const out = stripLead ? raw.replace(stripLead, "") : raw;
		if (!partial) return out;
		const seen = out.toLowerCase();
		const typed = partial.toLowerCase();
		// Still short of the word: consistent so far, but nothing to show yet.
		if (seen.length < typed.length) return typed.startsWith(seen) ? "" : null;
		return seen.startsWith(typed) ? out.slice(partial.length) : null;
	};

	// Healing on its own lets the model pick a different word than the one
	// being typed ("...not in phys" continued as "main memory"), which leaves
	// nothing showable - it happened on half the test prefixes. A grammar pins
	// the first word back to what is on screen, so the model spells the user's
	// word and then continues freely. The trailing newline is load-bearing:
	// without it the grammar can never emit the stop sequence and every request
	// runs to max_tokens, measured at 2.9s against 0.5s.
	const grammar = partial ? `root ::= " "? "${gbnf(partial)}" [^\\n]* "\\n"` : null;

	const send = (withGrammar: boolean) =>
		fetch(endpoint(settings, "/v1/completions"), {
			method: "POST",
			headers: headers(settings),
			signal,
			body: JSON.stringify({
				model: settings.model,
				prompt: buildPrompt(settings, ctx, trimmed),
				// Healing spends a few tokens re-spelling a word the user can
				// already see, so ask for those back on top of the budget.
				max_tokens: settings.maxTokens + (partial ? 4 : 0),
				temperature: settings.temperature,
				repeat_penalty: settings.repeatPenalty,
				// One line per suggestion: caps latency and stops the model
				// looping back over text it has already written.
				stop: ["\n"],
				stream: true,
				// While typing, the prefix only grows, so the KV cache from the
				// last keystroke still applies. This takes time-to-first-token
				// from ~700ms cold to ~180ms warm. Healing helps here too:
				// every keystroke within one word produces the same prompt, so
				// those are exact cache hits.
				cache_prompt: true,
				...(withGrammar && grammar ? { grammar } : {}),
			}),
		});

	let res = await send(!grammarUnsupported);
	// Healing still works without a grammar; it just drops the suggestion when
	// the model disagrees about spelling instead of correcting it.
	if (res.status === 400 && grammar && !grammarUnsupported) {
		grammarUnsupported = true;
		res = await send(false);
	}
	if (!res.ok || !res.body) throw new Error(`llama.cpp ${res.status}`);

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let acc = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") return project(acc) ?? "";
			try {
				const chunk = JSON.parse(payload) as CompletionChunk;
				const token = chunk.choices?.[0]?.text ?? "";
				if (token) {
					acc += token;
					const shown = project(acc);
					// Diverged from what is already on screen. Nothing later in
					// this stream can rescue it, so stop paying for it.
					if (shown === null) {
						await reader.cancel();
						return "";
					}
					onToken(shown);
				}
			} catch {
				// A frame split across chunks; the remainder stays in buffer.
			}
		}
	}
	return project(acc) ?? "";
}

/** Instruction-following rewrite, for the Ctrl+I box. Uses the chat template. */
export async function edit(
	settings: GhostwriterSettings,
	instruction: string,
	selection: string,
	signal: AbortSignal,
	onToken?: (accumulated: string) => void
): Promise<string> {
	const system =
		"You edit text inside the user's notes. Output ONLY the rewritten text. " +
		"No explanation, no preamble, no code fences.";
	const user = selection
		? `Instruction: ${instruction}\n\nText:\n${selection}`
		: `Instruction: ${instruction}`;

	const res = await fetch(endpoint(settings, "/v1/chat/completions"), {
		method: "POST",
		headers: headers(settings),
		signal,
		body: JSON.stringify({
			model: settings.model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			max_tokens: 512,
			temperature: 0.2,
			stream: true,
		}),
	});
	if (!res.ok || !res.body) throw new Error(`llama.cpp ${res.status}`);

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let acc = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") return acc.trim();
			try {
				const chunk = JSON.parse(payload) as ChatChunk;
				const delta = chunk.choices?.[0]?.delta?.content ?? "";
				if (delta) {
					acc += delta;
					onToken?.(acc);
				}
			} catch {
				// partial frame
			}
		}
	}
	return acc.trim();
}
