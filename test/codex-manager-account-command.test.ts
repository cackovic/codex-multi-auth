import { describe, expect, it, vi } from "vitest";
import { getAccountPolicyKey, type AccountPolicyStore } from "../lib/account-policy.js";
import { runAccountCommand } from "../lib/codex-manager/commands/account.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function makeStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "owner@example.com",
				accountId: "acct_1",
				refreshToken: "refresh",
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
}

function makeDeps(store: AccountPolicyStore) {
	return {
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => makeStorage()),
		loadPolicyStore: vi.fn(async () => store),
		savePolicyStore: vi.fn(async () => undefined),
		logInfo: vi.fn(),
		logError: vi.fn(),
		getNow: () => 123,
	};
}

describe("account command", () => {
	it("tags and pauses account policies", async () => {
		const store: AccountPolicyStore = { version: 1, accounts: {} };
		const deps = makeDeps(store);

		expect(await runAccountCommand(["tag", "1", "Team A"], deps)).toBe(0);
		expect(await runAccountCommand(["pause", "1"], deps)).toBe(0);

		const key = getAccountPolicyKey(makeStorage().accounts[0]!, 0);
		expect(store.accounts[key]).toMatchObject({
			tags: ["team-a"],
			paused: true,
			updatedAt: 123,
		});
		expect(deps.savePolicyStore).toHaveBeenCalledTimes(2);
	});

	it("sets weight, drain state, and note", async () => {
		const store: AccountPolicyStore = { version: 1, accounts: {} };
		const deps = makeDeps(store);

		expect(await runAccountCommand(["weight", "1", "3.5"], deps)).toBe(0);
		expect(await runAccountCommand(["drain", "1"], deps)).toBe(0);
		expect(await runAccountCommand(["note", "1", "batch", "only"], deps)).toBe(0);

		const key = getAccountPolicyKey(makeStorage().accounts[0]!, 0);
		expect(store.accounts[key]).toMatchObject({
			weight: 3.5,
			drained: true,
			note: "batch only",
		});
	});

	it.each([
		["5h only", ["--5h", "50"], 50, null],
		["7d only", ["--7d", "10"], null, 10],
		["both windows", ["--5h", "50", "--7d", "10"], 50, 10],
	] as const)(
		"sets quota limits for %s",
		async (_label, flags, expected5h, expected7d) => {
			const store: AccountPolicyStore = { version: 1, accounts: {} };
			const deps = makeDeps(store);

			expect(
				await runAccountCommand(["quota-limit", "1", ...flags], deps),
			).toBe(0);

			const key = getAccountPolicyKey(makeStorage().accounts[0]!, 0);
			expect(store.accounts[key]).toMatchObject({
				quotaRemainingPercentThreshold5h: expected5h,
				quotaRemainingPercentThreshold7d: expected7d,
				updatedAt: 123,
			});
			expect(deps.savePolicyStore).toHaveBeenCalledTimes(1);
		},
	);

	it("clears a previously set quota limit", async () => {
		const store: AccountPolicyStore = { version: 1, accounts: {} };
		const deps = makeDeps(store);

		expect(
			await runAccountCommand(
				["quota-limit", "1", "--5h", "50", "--7d", "10"],
				deps,
			),
		).toBe(0);
		expect(
			await runAccountCommand(["quota-limit", "1", "--5h", "clear"], deps),
		).toBe(0);

		const key = getAccountPolicyKey(makeStorage().accounts[0]!, 0);
		expect(store.accounts[key]).toMatchObject({
			quotaRemainingPercentThreshold5h: null,
			quotaRemainingPercentThreshold7d: 10,
		});
		expect(deps.savePolicyStore).toHaveBeenCalledTimes(2);
	});

	it("rejects quota-limit without a window flag and does not save", async () => {
		const deps = makeDeps({ version: 1, accounts: {} });

		expect(await runAccountCommand(["quota-limit", "1"], deps)).toBe(1);
		expect(deps.logError).toHaveBeenCalledWith(
			"quota-limit requires at least one of --5h or --7d.",
		);
		expect(deps.savePolicyStore).not.toHaveBeenCalled();
	});

	it.each([
		["--5h", "101"],
		["--7d", "not-a-percent"],
	] as const)(
		"rejects invalid quota limit %s %s and does not save",
		async (flag, value) => {
			const deps = makeDeps({ version: 1, accounts: {} });

			expect(
				await runAccountCommand(["quota-limit", "1", flag, value], deps),
			).toBe(1);
			expect(deps.savePolicyStore).not.toHaveBeenCalled();
		},
	);

	it("uses the existing invalid-index failure for quota-limit", async () => {
		const deps = makeDeps({ version: 1, accounts: {} });

		expect(
			await runAccountCommand(["quota-limit", "2", "--5h", "50"], deps),
		).toBe(1);
		expect(String(deps.logError.mock.calls[0]?.[0])).toContain(
			"Account index is required",
		);
		expect(deps.savePolicyStore).not.toHaveBeenCalled();
	});

	it("lists policy state as json", async () => {
		const storage = makeStorage();
		const key = getAccountPolicyKey(storage.accounts[0]!, 0);
		const store: AccountPolicyStore = {
			version: 1,
			accounts: {
				[key]: {
					accountKey: key,
					tags: ["team-a"],
					weight: 2,
					paused: true,
					drained: false,
					note: null,
					quotaRemainingPercentThreshold5h: 50,
					quotaRemainingPercentThreshold7d: null,
					updatedAt: 123,
				},
			},
		};
		const deps = makeDeps(store);

		expect(await runAccountCommand(["policy", "list", "--json"], deps)).toBe(0);
		const payload = JSON.parse(String(deps.logInfo.mock.calls[0]?.[0])) as {
			accounts: Array<{
				accountKey: string;
				tags: string[];
				paused: boolean;
				quota5hLimitPercent: number | null;
				quota7dLimitPercent: number | null;
			}>;
		};
		expect(payload.accounts[0]).toMatchObject({
			accountKey: key,
			tags: ["team-a"],
			paused: true,
			quota5hLimitPercent: 50,
			quota7dLimitPercent: null,
		});
		expect(JSON.stringify(payload)).not.toContain("acct_1");
		expect(JSON.stringify(payload)).not.toContain("owner@example.com");
	});

	it("shows text quota markers only when a window override is set", async () => {
		const store: AccountPolicyStore = { version: 1, accounts: {} };
		const deps = makeDeps(store);

		expect(await runAccountCommand(["policy", "list"], deps)).toBe(0);
		expect(String(deps.logInfo.mock.calls.at(-1)?.[0])).not.toContain("quota5h=");
		expect(String(deps.logInfo.mock.calls.at(-1)?.[0])).not.toContain("quota7d=");

		expect(
			await runAccountCommand(["quota-limit", "1", "--7d", "12"], deps),
		).toBe(0);
		expect(await runAccountCommand(["policy", "list"], deps)).toBe(0);
		const line = String(deps.logInfo.mock.calls.at(-1)?.[0]);
		expect(line).toContain("quota7d=12%");
		expect(line).not.toContain("quota5h=");
	});

	it("rejects invalid account indexes", async () => {
		const deps = makeDeps({ version: 1, accounts: {} });
		expect(await runAccountCommand(["tag", "2", "team"], deps)).toBe(1);
		expect(String(deps.logError.mock.calls[0]?.[0])).toContain(
			"Account index is required",
		);
	});
});
