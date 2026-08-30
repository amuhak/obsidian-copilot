import { GhostwriterSettings } from "./settings";

/**
 * Completion + edit calls against a llama.cpp server.
 *
 * Uses plain fetch rather than Obsidian's requestUrl: llama.cpp echoes the
 * Origin header back as Access-Control-Allow-Origin and answers preflight, so
 * CORS is not an obstacle, and fetch gives us AbortController and streaming.
 *
 * Note on hosts: "localhost" on Windows resolves to ::1 before 127.0.0.1, so a
 * server bound to IPv4 only makes every request start with a dead connection
 * and fall back. Resolution itself is free; the failed connect is not. Cost
 * depends on the client - seconds when connects are tried in sequence, a few
 * hundred ms in Chromium, which races them. Always configure an explicit IP.
 */

/**
 * Streaming raw text continuation, for ghost text. No chat template applied.
 * Calls onToken with the accumulated text so far, then resolves with the whole
 * completion.
 */
/** Bearer header only when a key is configured, so local servers stay unauthenticated. */
function headers(settings: GhostwriterSettings): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	if (settings.apiKey) h["Authorization"] = `Bearer ${settings.apiKey}`;
	return h;
}

export async function completeStream(
	settings: GhostwriterSettings,
	prefix: string,
	signal: AbortSignal,
	onToken: (accumulated: string) => void
): Promise<string> {
	// Never end the prompt with a bare space. Tokenizers pack the space into
	// the following word (" need" is one token), so a dangling space token is
	// off-distribution: in testing it made the model answer in Chinese, emit
	// "0 or 1." as a definition, and invent facts. Trim it, let the model
	// produce its own leading space, then drop that space on the way out since
	// the user already typed one - which also fixes the doubled space.
	const trimmed = prefix.replace(/[ \t]+$/, "");
	const userTypedSpace = trimmed.length !== prefix.length;
	const reconcile = (text: string) =>
		userTypedSpace ? text.replace(/^[ \t]+/, "") : text;

	const res = await fetch(`${settings.baseUrl}/v1/completions`, {
		method: "POST",
		headers: headers(settings),
		signal,
		body: JSON.stringify({
			model: settings.model,
			prompt: trimmed.slice(-settings.contextChars),
			max_tokens: settings.maxTokens,
			temperature: settings.temperature,
			repeat_penalty: settings.repeatPenalty,
			// One line per suggestion: caps latency and stops the model looping
			// back over text it has already written.
			stop: ["\n"],
			stream: true,
			// While typing, the prefix only grows, so the KV cache from the last
			// keystroke still applies. This takes time-to-first-token from
			// ~700ms cold to ~180ms warm - the difference between sluggish and
			// responsive.
			cache_prompt: true,
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
			if (payload === "[DONE]") return reconcile(acc);
			try {
				const token: string = JSON.parse(payload)?.choices?.[0]?.text ?? "";
				if (token) {
					acc += token;
					onToken(reconcile(acc));
				}
			} catch {
				// A frame split across chunks; the remainder stays in buffer.
			}
		}
	}
	return reconcile(acc);
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

	const res = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
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
				const delta: string =
					JSON.parse(payload)?.choices?.[0]?.delta?.content ?? "";
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
