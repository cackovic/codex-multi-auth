import {
	getAccountPolicyKey,
	loadAccountPolicyStore,
	normalizeAccountPolicyTag,
	saveAccountPolicyStore,
	upsertAccountPolicy,
	type AccountPolicyStore,
} from "../../account-policy.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../../storage.js";

export interface AccountCommandDeps {
	setStoragePath: (path: string | null) => void;
	loadAccounts: () => Promise<AccountStorageV3 | null>;
	loadPolicyStore?: typeof loadAccountPolicyStore;
	savePolicyStore?: typeof saveAccountPolicyStore;
	logInfo?: (message: string) => void;
	logError?: (message: string) => void;
	getNow?: () => number;
}

function printAccountUsage(logInfo: (message: string) => void): void {
	logInfo(
		[
			"Usage:",
			"  codex-multi-auth account tag <index> <tag>",
			"  codex-multi-auth account untag <index> <tag>",
			"  codex-multi-auth account weight <index> <0..10>",
			"  codex-multi-auth account quota-limit <index> [--5h <0..100|clear>] [--7d <0..100|clear>]",
			"  codex-multi-auth account pause|unpause|drain|undrain <index>",
			"  codex-multi-auth account note <index> <text>",
			"  codex-multi-auth account policy list [--json]",
		].join("\n"),
	);
}

function parseAccountIndex(value: string | undefined): number | null {
	if (!value || !/^\d+$/.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed - 1 : null;
}

function resolveAccount(
	storage: AccountStorageV3 | null,
	index: number | null,
): { account: AccountMetadataV3; index: number } | null {
	if (!storage || index === null || index < 0 || index >= storage.accounts.length) {
		return null;
	}
	const account = storage.accounts[index];
	return account ? { account, index } : null;
}

function policySummary(store: AccountPolicyStore, storage: AccountStorageV3 | null) {
	return (storage?.accounts ?? []).map((account, index) => {
		const accountKey = getAccountPolicyKey(account, index);
		const policy = store.accounts[accountKey];
		return {
			index: index + 1,
			label: `Account ${index + 1}`,
			accountKey,
			tags: policy?.tags ?? [],
			weight: policy?.weight ?? 1,
			paused: policy?.paused ?? false,
			drained: policy?.drained ?? false,
			note: policy?.note ?? null,
			quota5hLimitPercent:
				policy?.quotaRemainingPercentThreshold5h ?? null,
			quota7dLimitPercent:
				policy?.quotaRemainingPercentThreshold7d ?? null,
		};
	});
}

export async function runAccountCommand(
	args: string[],
	deps: AccountCommandDeps,
): Promise<number> {
	const logInfo = deps.logInfo ?? console.log;
	const logError = deps.logError ?? console.error;
	const [command, ...rest] = args;
	if (!command || command === "--help" || command === "-h") {
		printAccountUsage(logInfo);
		return 0;
	}

	deps.setStoragePath(null);
	const storage = await deps.loadAccounts();
	const loadStore = deps.loadPolicyStore ?? loadAccountPolicyStore;
	const saveStore = deps.savePolicyStore ?? saveAccountPolicyStore;
	const store = await loadStore();

	if (command === "policy") {
		const [subcommand, ...policyArgs] = rest;
		if (subcommand !== "list") {
			logError(`Unknown account policy command: ${subcommand ?? "(missing)"}`);
			return 1;
		}
		const unknown = policyArgs.find((arg) => arg !== "--json" && arg !== "-j");
		if (unknown) {
			logError(`Unknown account policy list option: ${unknown}`);
			return 1;
		}
		const payload = {
			command: "account policy list",
			accounts: policySummary(store, storage),
		};
		if (policyArgs.includes("--json") || policyArgs.includes("-j")) {
			logInfo(JSON.stringify(payload, null, 2));
			return 0;
		}
		if (payload.accounts.length === 0) {
			logInfo("No accounts configured.");
			return 0;
		}
		for (const entry of payload.accounts) {
			const markers = [
				`weight=${entry.weight}`,
				entry.quota5hLimitPercent === null
					? null
					: `quota5h=${entry.quota5hLimitPercent}%`,
				entry.quota7dLimitPercent === null
					? null
					: `quota7d=${entry.quota7dLimitPercent}%`,
				entry.paused ? "paused" : null,
				entry.drained ? "drained" : null,
				entry.tags.length > 0 ? `tags=${entry.tags.join(",")}` : null,
				entry.note ? "note" : null,
			].filter((value): value is string => value !== null);
			logInfo(`${entry.index}. ${entry.label} | ${markers.join(" | ")}`);
		}
		return 0;
	}

	const accountIndex = parseAccountIndex(rest[0]);
	const resolved = resolveAccount(storage, accountIndex);
	if (!resolved) {
		logError("Account index is required and must reference a configured account.");
		return 1;
	}
	const accountKey = getAccountPolicyKey(resolved.account, resolved.index);
	const now = deps.getNow?.() ?? Date.now();

	if (command === "tag" || command === "untag") {
		const tag = normalizeAccountPolicyTag(rest[1] ?? "");
		if (!tag) {
			logError(`${command} requires a tag value.`);
			return 1;
		}
		const policy = upsertAccountPolicy(
			store,
			accountKey,
			(next) => {
				if (command === "tag" && !next.tags.includes(tag)) next.tags.push(tag);
				if (command === "untag") {
					next.tags = next.tags.filter((existing) => existing !== tag);
				}
			},
			now,
		);
		await saveStore(store);
		logInfo(
			`${command === "tag" ? "Tagged" : "Removed tag from"} account ${resolved.index + 1}: ${policy.tags.join(",") || "none"}`,
		);
		return 0;
	}

	if (command === "weight") {
		const weight = rest[1] === undefined ? Number.NaN : Number.parseFloat(rest[1]);
		if (!Number.isFinite(weight) || weight < 0 || weight > 10) {
			logError("weight requires a number from 0 to 10.");
			return 1;
		}
		upsertAccountPolicy(store, accountKey, (next) => {
			next.weight = weight;
		}, now);
		await saveStore(store);
		logInfo(`Set account ${resolved.index + 1} weight to ${weight}.`);
		return 0;
	}

	if (command === "quota-limit") {
		type QuotaLimitValue = number | null;
		const parsed: {
			quota5h?: QuotaLimitValue;
			quota7d?: QuotaLimitValue;
		} = {};
		const quotaArgs = rest.slice(1);
		for (let index = 0; index < quotaArgs.length; index += 2) {
			const flag = quotaArgs[index];
			const rawValue = quotaArgs[index + 1];
			if ((flag !== "--5h" && flag !== "--7d") || rawValue === undefined) {
				logError(
					"quota-limit requires --5h and/or --7d with a value from 0 to 100 or clear.",
				);
				return 1;
			}
			const value =
				rawValue === "clear"
					? null
					: /^(?:100|\d{1,2})(?:\.\d+)?$/.test(rawValue)
						? Number(rawValue)
						: Number.NaN;
			if (
				value !== null &&
				(!Number.isFinite(value) || value < 0 || value > 100)
			) {
				logError(`${flag} requires a number from 0 to 100 or clear.`);
				return 1;
			}
			if (flag === "--5h") parsed.quota5h = value;
			if (flag === "--7d") parsed.quota7d = value;
		}
		if (parsed.quota5h === undefined && parsed.quota7d === undefined) {
			logError("quota-limit requires at least one of --5h or --7d.");
			return 1;
		}
		const policy = upsertAccountPolicy(store, accountKey, (next) => {
			if (parsed.quota5h !== undefined) {
				next.quotaRemainingPercentThreshold5h = parsed.quota5h;
			}
			if (parsed.quota7d !== undefined) {
				next.quotaRemainingPercentThreshold7d = parsed.quota7d;
			}
		}, now);
		await saveStore(store);
		const quota5h = policy.quotaRemainingPercentThreshold5h;
		const quota7d = policy.quotaRemainingPercentThreshold7d;
		logInfo(
			`Updated account ${resolved.index + 1} quota limits: 5h=${quota5h === null ? "global" : `${quota5h}%`}, 7d=${quota7d === null ? "global" : `${quota7d}%`}.`,
		);
		return 0;
	}

	if (["pause", "unpause", "drain", "undrain"].includes(command)) {
		upsertAccountPolicy(store, accountKey, (next) => {
			if (command === "pause") next.paused = true;
			if (command === "unpause") next.paused = false;
			if (command === "drain") next.drained = true;
			if (command === "undrain") next.drained = false;
		}, now);
		await saveStore(store);
		logInfo(`Updated account ${resolved.index + 1}: ${command}.`);
		return 0;
	}

	if (command === "note") {
		const note = rest.slice(1).join(" ").trim();
		upsertAccountPolicy(store, accountKey, (next) => {
			next.note = note.length > 0 ? note.slice(0, 500) : null;
		}, now);
		await saveStore(store);
		logInfo(`Updated account ${resolved.index + 1} note.`);
		return 0;
	}

	logError(`Unknown account command: ${command}`);
	printAccountUsage(logInfo);
	return 1;
}
