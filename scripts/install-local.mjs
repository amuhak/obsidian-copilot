// Copies build artifacts into the test vault so Obsidian picks them up.
// Run after `npm run build`, then hit "Reload app without saving" in Obsidian.
import { copyFileSync, mkdirSync, existsSync } from "fs";

const DEST = "test-vault/.obsidian/plugins/ghostwriter";
const FILES = ["main.js", "manifest.json", "styles.css"];

mkdirSync(DEST, { recursive: true });
for (const f of FILES) {
	if (!existsSync(f)) {
		console.error(`missing ${f} - run \`npm run build\` first`);
		process.exit(1);
	}
	copyFileSync(f, `${DEST}/${f}`);
}
console.log(`installed ${FILES.join(", ")} -> ${DEST}`);
