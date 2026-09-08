import type { App } from "obsidian";
import { backendConfigError, type AiBackend } from "./backends";
import { isBackendAvailable, recordBackendRateLimited, recordBackendSuccess, todayString, type BackendUsageState } from "./backendUsage";
import { sendToBackend } from "./providers";
import { AiRequestError, isRateLimitStatus, type ChatMessage } from "./types";

const USAGE_FILE_NAME = "ai-backend-usage.json";

/** For the settings screen's own per-backend status line — see AiBackendChain.statusFor. */
export interface BackendStatus {
	usedToday: number;
	dailyLimit: number;
	limitHitToday: boolean;
}

/**
 * Owns the ordered attempt over a message's configured backends, and the small on-disk record of
 * how many requests each one has answered today. Deliberately not unit-tested directly — the same
 * reasoning VaultSearchIndex.ts's own doc comment gives for itself: this class is IO glue (a real
 * network call per backend, a real file read/write) around backendUsage.ts's pure state machine
 * and providers.ts's pure dispatch, both of which already have their own direct tests.
 */
export class AiBackendChain {
	private usage = new Map<string, BackendUsageState>();
	private loaded = false;

	constructor(
		private app: App,
		/** A function rather than a plain string: it reads `manifest.dir`, which main.ts only has
		 * once the plugin has actually finished loading — the same reason VaultSearchIndex takes its
		 * own data folder this way. */
		private dataFolder: () => string,
	) {}

	private usagePath(): string {
		return `${this.dataFolder()}/${USAGE_FILE_NAME}`;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		const path = this.usagePath();
		if (!(await this.app.vault.adapter.exists(path))) return;
		try {
			const raw = JSON.parse(await this.app.vault.adapter.read(path)) as Record<string, BackendUsageState>;
			this.usage = new Map(Object.entries(raw));
		} catch {
			// A corrupt or foreign-format usage file is worth starting over from, not crashing on —
			// worst case every backend's counter looks fresh again a day early.
			this.usage = new Map();
		}
	}

	private async persist(): Promise<void> {
		await this.app.vault.adapter.write(this.usagePath(), JSON.stringify(Object.fromEntries(this.usage)));
	}

	/** Called once from main.ts right after construction, so the settings screen's own status
	 * lines (statusFor, below) reflect real numbers from the moment Obsidian opens rather than
	 * reading as "0 used today" until the first actual chat message of the session. */
	async preload(): Promise<void> {
		await this.ensureLoaded();
	}

	/**
	 * For the settings screen's own per-backend line — never triggers a load itself, the same
	 * "rendering settings can't accidentally kick off IO" rule VaultSearchIndex.status() already
	 * follows, which is why main.ts calls preload() once up front instead of relying on this to
	 * load lazily.
	 */
	statusFor(backendId: string, dailyLimit: number): BackendStatus {
		const state = this.usage.get(backendId);
		const fresh = !state || state.date !== todayString();
		return { usedToday: fresh ? 0 : state.count, dailyLimit, limitHitToday: fresh ? false : state.limitHit };
	}

	/**
	 * Tries `backends` strictly in order, skipping any that are unconfigured or already at today's
	 * limit without spending a network round-trip finding that out, and returns the first reply
	 * that actually comes back. A same-day HTTP 429 from a backend benches it (see
	 * backendUsage.ts's recordBackendRateLimited) even if its own configured dailyLimit hadn't
	 * technically been reached yet — the 429 means the real limit, which this plugin never actually
	 * knows, already has been. Every other kind of failure (bad key, malformed model, network down)
	 * still falls through to the next backend, on the theory that a working fallback beats no reply
	 * at all, but doesn't bench the backend — those aren't evidence of an exhausted quota.
	 *
	 * Throws only once every backend has been skipped or has failed, with whichever failure was
	 * seen last — usually informative enough on its own to act on, and simpler than tracking a
	 * separate reason per backend for a case that, with at least one backend actually configured
	 * right, should be rare.
	 */
	async send(backends: AiBackend[], messages: ChatMessage[], systemPrompt?: string): Promise<string> {
		await this.ensureLoaded();
		const today = todayString();
		let lastError: Error | undefined;
		let dirty = false;
		try {
			for (const backend of backends) {
				const configError = backendConfigError(backend);
				if (configError) {
					lastError = new Error(configError);
					continue;
				}
				if (!isBackendAvailable(this.usage.get(backend.id), backend.dailyLimit, today)) {
					lastError = new Error(`${backend.name.trim() || "This backend"} has reached today's limit.`);
					continue;
				}
				try {
					const reply = await sendToBackend(backend, messages, systemPrompt);
					this.usage.set(backend.id, recordBackendSuccess(this.usage.get(backend.id), today));
					dirty = true;
					return reply;
				} catch (e) {
					lastError = e instanceof Error ? e : new Error(String(e));
					if (e instanceof AiRequestError && isRateLimitStatus(e.status)) {
						this.usage.set(backend.id, recordBackendRateLimited(this.usage.get(backend.id), today));
						dirty = true;
					}
				}
			}
		} finally {
			if (dirty) await this.persist();
		}
		throw lastError ?? new Error("No AI backend is configured — add one in Settings → AI Assistant.");
	}
}
