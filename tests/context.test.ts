import { describe, expect, it } from "vitest";
import {
	buildScaledBreakdown,
	estimateMessagesTokens,
	estimateTokens,
	parseScaleCache,
	serializeScaleCache,
	skillBreakdown,
	sliceSystemPrompt,
	sumToolTokens,
	toolDefTokens,
} from "../extensions/context-pure";

const MEMORY = `\n\n<project_context>\n\n<project_instructions path="CLAUDE.md">\nbe nice\n</project_instructions>\n\n</project_context>\n`;
const SKILLS = [
	"\n\nThe following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"",
	"<available_skills>",
	"  <skill>",
	"    <name>alpha</name>",
	"    <description>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</description>",
	"    <location>/x/alpha/SKILL.md</location>",
	"  </skill>",
	"  <skill>",
	"    <name>beta</name>",
	"    <description>bb</description>",
	"    <location>/x/beta/SKILL.md</location>",
	"  </skill>",
	"</available_skills>",
].join("\n");
const BASE = "You are an expert coding assistant.\nGuidelines:\n- be concise";
const TAIL = "\nCurrent date: 2026-06-26\nCurrent working directory: /tmp";

describe("sliceSystemPrompt", () => {
	it("splits a full prompt into system/memory/skills", () => {
		const prompt = BASE + MEMORY + SKILLS + TAIL;
		const r = sliceSystemPrompt(prompt);
		expect(r.memory.startsWith("<project_context>")).toBe(true);
		expect(r.memory.endsWith("</project_context>")).toBe(true);
		expect(r.memory).toContain("CLAUDE.md");
		expect(r.skills.startsWith("The following skills provide")).toBe(true);
		expect(r.skills.endsWith("</available_skills>")).toBe(true);
		// system is everything else (base + tail), with the two regions removed
		expect(r.system).toContain("expert coding assistant");
		expect(r.system).toContain("Current date");
		expect(r.system).not.toContain("<project_context>");
		expect(r.system).not.toContain("<available_skills>");
	});

	it("returns empty skills when there is no skills block", () => {
		const prompt = BASE + MEMORY + TAIL;
		const r = sliceSystemPrompt(prompt);
		expect(r.skills).toBe("");
		expect(r.memory).toContain("<project_context>");
		expect(r.system).toContain("expert coding assistant");
	});

	it("returns empty memory when there is no project_context block", () => {
		const prompt = BASE + SKILLS + TAIL;
		const r = sliceSystemPrompt(prompt);
		expect(r.memory).toBe("");
		expect(r.skills).toContain("<available_skills>");
	});

	it("returns empty memory and skills for a base-only prompt", () => {
		const r = sliceSystemPrompt(BASE + TAIL);
		expect(r.memory).toBe("");
		expect(r.skills).toBe("");
		expect(r.system).toBe(BASE + TAIL);
	});
});

describe("toolDefTokens / sumToolTokens", () => {
	const tools = [
		{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
		{ name: "bash", description: "run a command with a much longer description so it is bigger", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } },
		{ name: "edit", description: "edit", parameters: {} },
	] as any[];

	it("estimates a single tool from its JSON blob", () => {
		const t = tools[0];
		const expected = estimateTokens(
			JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters, promptGuidelines: undefined }),
		);
		expect(toolDefTokens(t)).toBe(expected);
	});

	it("excludes inactive tools and sorts perTool largest first", () => {
		const { total, perTool } = sumToolTokens(tools, ["read", "bash"]);
		expect(perTool.map((p) => p.name)).toEqual(["bash", "read"]);
		expect(total).toBe(perTool[0].tokens + perTool[1].tokens);
		expect(perTool.find((p) => p.name === "edit")).toBeUndefined();
	});

	it("falls back to name length for active tools missing from the registry", () => {
		const { perTool } = sumToolTokens(tools, ["ghost"]);
		expect(perTool).toEqual([{ name: "ghost", tokens: estimateTokens("ghost") }]);
	});
});

describe("skillBreakdown", () => {
	it("parses each skill block and sorts largest first", () => {
		const { total, perSkill } = skillBreakdown(sliceSystemPrompt(BASE + SKILLS).skills);
		expect(perSkill.map((s) => s.name)).toEqual(["alpha", "beta"]);
		expect(perSkill[0].tokens).toBeGreaterThan(perSkill[1].tokens);
		expect(total).toBe(perSkill[0].tokens + perSkill[1].tokens);
	});

	it("returns nothing for an empty region", () => {
		expect(skillBreakdown("")).toEqual({ total: 0, perSkill: [] });
	});
});

describe("buildScaledBreakdown", () => {
	const prefix = { systemTok: 10000, memoryTok: 1500, skillsTok: 6000, toolsTok: 6500 };

	it("scales char/4 categories to the real provider total (usage)", () => {
		const messagesTok = 1000;
		const char4Total = 10000 + 1500 + 6000 + 6500 + 1000; // 25000
		const realTotal = 38750; // → scale 1.55
		const r = buildScaledBreakdown({ ...prefix, messagesTok, realTotal, cachedScale: null, contextWindow: 1_000_000 });
		expect(r.scaleSource).toBe("usage");
		expect(r.scale).toBeCloseTo(realTotal / char4Total, 5);
		// slices sum to ~realTotal (within rounding) and equal effective
		const consumed = r.categories.filter((c) => c.label !== "Free space");
		const sum = consumed.reduce((a, c) => a + c.tokens, 0);
		expect(sum).toBe(r.effective);
		expect(Math.abs(r.effective - realTotal)).toBeLessThanOrEqual(3);
		expect(r.free).toBe(1_000_000 - r.effective);
	});

	it("hello-there does not inflate Messages (the old residual bug)", () => {
		// system+tools dominate; a 3-token greeting stays tiny after scaling
		const r = buildScaledBreakdown({ ...prefix, messagesTok: 7, realTotal: 37200, cachedScale: null, contextWindow: 1_000_000 });
		const messages = r.categories.find((c) => c.label === "Messages")!;
		expect(messages.tokens).toBeLessThan(20); // ~7 * 1.55 ≈ 11, NOT ~10k
	});

	it("uses cached scale on a fresh session (no usage yet)", () => {
		const r = buildScaledBreakdown({ ...prefix, messagesTok: 0, realTotal: null, cachedScale: 1.55, contextWindow: 1_000_000 });
		expect(r.scaleSource).toBe("cache");
		expect(r.scale).toBe(1.55);
		expect(r.effective).toBe(Math.round((10000 + 1500 + 6000 + 6500) * 1.55));
	});

	it("falls back to raw char/4 (scale 1) for a never-seen model", () => {
		const r = buildScaledBreakdown({ ...prefix, messagesTok: 0, realTotal: null, cachedScale: null, contextWindow: 1_000_000 });
		expect(r.scaleSource).toBe("raw");
		expect(r.scale).toBe(1);
		expect(r.effective).toBe(10000 + 1500 + 6000 + 6500);
	});

	it("is model-agnostic: an OpenAI-like ~1.05 scale reconciles to its real total", () => {
		const char4Total = 10000 + 1500 + 6000 + 6500 + 2000; // 26000
		const realTotal = 27300; // scale 1.05
		const r = buildScaledBreakdown({ ...prefix, messagesTok: 2000, realTotal, cachedScale: null, contextWindow: 128000 });
		expect(r.scale).toBeCloseTo(1.05, 5);
		expect(Math.abs(r.effective - realTotal)).toBeLessThanOrEqual(3);
	});

	it("sorts consumed categories largest first and keeps Free space last", () => {
		const r = buildScaledBreakdown({ ...prefix, messagesTok: 0, realTotal: 37200, cachedScale: null, contextWindow: 1_000_000 });
		expect(r.categories[r.categories.length - 1].label).toBe("Free space");
		const consumed = r.categories.slice(0, -1);
		for (let i = 1; i < consumed.length; i++) {
			expect(consumed[i - 1].tokens).toBeGreaterThanOrEqual(consumed[i].tokens);
		}
		expect(consumed[0].label).toBe("System prompt");
	});

	it("guards against a zero/garbage scale", () => {
		const r = buildScaledBreakdown({ ...prefix, messagesTok: 0, realTotal: 0, cachedScale: 0, contextWindow: 1_000_000 });
		expect(r.scale).toBe(1);
		expect(r.scaleSource).toBe("raw");
	});
});

describe("estimateMessagesTokens", () => {
	it("estimates user + assistant content via char/4, mirroring pi", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "hello there" } }, // 11 chars → 3
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "x".repeat(40) }, // 40
						{ type: "thinking", thinking: "y".repeat(8) }, // 8
						{ type: "toolCall", name: "read", arguments: { path: "a" } }, // 4 + len('{"path":"a"}')=12
					],
				},
			},
		];
		// user: ceil(11/4)=3 ; assistant: ceil((40+8+4+12)/4)=16
		expect(estimateMessagesTokens(entries as any)).toBe(3 + 16);
	});

	it("ignores non-message entries and tolerates junk", () => {
		expect(estimateMessagesTokens([] as any)).toBe(0);
		expect(estimateMessagesTokens([{ type: "model_change" }, null, 5] as any)).toBe(0);
		expect(estimateMessagesTokens([{ type: "compaction", summary: "z".repeat(40) }] as any)).toBe(10);
	});
});

describe("scale cache", () => {
	it("round-trips and keeps only positive finite scales", () => {
		const obj = { "claude-opus": 1.55, "gpt-5": 1.05 };
		expect(parseScaleCache(serializeScaleCache(obj))).toEqual(obj);
	});

	it("drops bad values and tolerates garbage input", () => {
		expect(parseScaleCache('{"a":1.5,"b":0,"c":-2,"d":"x"}')).toEqual({ a: 1.5 });
		expect(parseScaleCache("not json")).toEqual({});
		expect(parseScaleCache(null)).toEqual({});
		expect(parseScaleCache("[1,2,3]")).toEqual({});
	});
});
