import { describe, expect, it } from "vitest";
import { hasExecuteIntent } from "../extensions/workflow-guard";

describe("hasExecuteIntent", () => {
	it("flags imperative execution requests", () => {
		expect(hasExecuteIntent("implement caching in foo")).toBe(true);
		expect(hasExecuteIntent("refactor the auth module")).toBe(true);
		expect(hasExecuteIntent("build a caching layer for the api")).toBe(true);
		expect(hasExecuteIntent("migrate the config to yaml")).toBe(true);
	});

	it("skips slash commands", () => {
		expect(hasExecuteIntent("/execute the plan")).toBe(false);
		expect(hasExecuteIntent("  /new-feature implement caching")).toBe(false);
	});

	it("skips questions", () => {
		expect(hasExecuteIntent("how do I migrate this?")).toBe(false);
		expect(hasExecuteIntent("should we refactor the auth module")).toBe(false);
		expect(hasExecuteIntent("implement caching? or is that overkill")).toBe(false);
	});

	it("skips explicit go-aheads", () => {
		expect(hasExecuteIntent("implement caching, just do it")).toBe(false);
		expect(hasExecuteIntent("go ahead and implement it")).toBe(false);
		expect(hasExecuteIntent("refactor the auth module, skip the plan")).toBe(false);
		expect(hasExecuteIntent("no plan needed, refactor the var names")).toBe(false);
	});

	it("does not treat negated phrases as go-aheads", () => {
		expect(hasExecuteIntent("implement caching but don't do it yet")).toBe(true);
		expect(hasExecuteIntent("refactor auth, do not do it all at once")).toBe(true);
	});

	it("does not treat descriptions of missing plans as go-aheads", () => {
		expect(hasExecuteIntent("refactor auth, there is no plan yet for this")).toBe(true);
		expect(hasExecuteIntent("migrate the db, we have no plan so far")).toBe(true);
	});

	it("does not flag 'build' as a noun", () => {
		expect(hasExecuteIntent("build is failing on main")).toBe(false);
		expect(hasExecuteIntent("the build broke after the merge")).toBe(false);
	});

	it("only checks the head for execution keywords", () => {
		expect(
			hasExecuteIntent(
				"here is some long context about the system and at the very end of all of this I mention refactor",
			),
		).toBe(false);
	});
});
