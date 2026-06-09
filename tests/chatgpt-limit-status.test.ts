import { describe, expect, it } from "vitest";
import {
  buildUsageHeaders,
  createLatestOnlyRunner,
  formatChatGptLimitStatus,
  formatResetShort,
  getHighestUsedPercent,
  getTokenMetadata,
  hasChatGptUsageCredentials,
  isOpenAICodexProvider,
  parseUsageSnapshot,
} from "../extensions/chatgpt-limit-status";

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(payload: unknown): string {
  return `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for condition");
}

describe("isOpenAICodexProvider", () => {
  it("accepts the base provider and numbered variants", () => {
    expect(isOpenAICodexProvider("openai-codex")).toBe(true);
    expect(isOpenAICodexProvider("openai-codex-1")).toBe(true);
    expect(isOpenAICodexProvider("openai-codex-12")).toBe(true);
  });

  it("rejects unrelated providers", () => {
    expect(isOpenAICodexProvider(undefined)).toBe(false);
    expect(isOpenAICodexProvider("openai")).toBe(false);
    expect(isOpenAICodexProvider("openai-codex-beta")).toBe(false);
  });
});

describe("parseUsageSnapshot", () => {
  it("extracts 5-hour and weekly windows by duration", () => {
    const snapshot = parseUsageSnapshot(
      {
        plan_type: "pro",
        email: "user@example.com",
        rate_limit: {
          primary_window: {
            used_percent: 25.4,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: 1_700_007_200,
          },
          secondary_window: {
            used_percent: 42.2,
            limit_window_seconds: 7 * 24 * 60 * 60,
            reset_at: 1_700_172_800,
          },
        },
      },
      1_700_000_000_000,
    );

    expect(snapshot.planType).toBe("pro");
    expect(snapshot.email).toBe("user@example.com");
    expect(snapshot.fiveHour).toEqual({
      usedPercent: 25.4,
      windowSeconds: 18_000,
      resetAt: 1_700_007_200,
    });
    expect(snapshot.weekly).toEqual({
      usedPercent: 42.2,
      windowSeconds: 604_800,
      resetAt: 1_700_172_800,
    });
    expect(snapshot.fetchedAt).toBe(1_700_000_000_000);
  });

  it("tolerates small duration differences and missing windows", () => {
    const snapshot = parseUsageSnapshot({
      rate_limit: {
        primary_window: {
          used_percent: 11,
          limit_window_seconds: 18_060,
        },
        secondary_window: {
          used_percent: 22,
          limit_window_seconds: 60,
        },
      },
    });

    expect(snapshot.fiveHour?.usedPercent).toBe(11);
    expect(snapshot.weekly).toBeUndefined();
  });

  it("ignores malformed window data", () => {
    const snapshot = parseUsageSnapshot({
      rate_limit: {
        primary_window: { used_percent: "25", limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 42 },
      },
    });

    expect(snapshot.fiveHour).toBeUndefined();
    expect(snapshot.weekly).toBeUndefined();
  });
});

describe("formatChatGptLimitStatus", () => {
  it("formats remaining quota and reset time for both windows", () => {
    const text = formatChatGptLimitStatus(
      {
        fiveHour: {
          usedPercent: 25.4,
          windowSeconds: 18_000,
          resetAt: 1_700_003_600,
        },
        weekly: {
          usedPercent: 42.2,
          windowSeconds: 604_800,
          resetAt: 1_700_172_800,
        },
        fetchedAt: 1_700_000_000_000,
      },
      1_700_000_000_000,
    );

    expect(text).toBe("GPT 5h 75% ↺1h · W 58% ↺2d");
  });

  it("omits missing windows", () => {
    const text = formatChatGptLimitStatus(
      {
        weekly: {
          usedPercent: 99.4,
          windowSeconds: 604_800,
          resetAt: 1_700_000_600,
        },
        fetchedAt: 1_700_000_000_000,
      },
      1_700_000_000_000,
    );

    expect(text).toBe("GPT W 1% ↺10m");
  });

  it("returns undefined when no usage windows are available", () => {
    expect(formatChatGptLimitStatus({ fetchedAt: 1 })).toBeUndefined();
    expect(formatChatGptLimitStatus(undefined)).toBeUndefined();
  });
});

describe("formatResetShort", () => {
  it("formats minutes, hours, days, and missing reset times", () => {
    expect(formatResetShort(undefined, 1_700_000_000_000)).toBe("?");
    expect(formatResetShort(1_700_000_600, 1_700_000_000_000)).toBe("10m");
    expect(formatResetShort(1_700_007_200, 1_700_000_000_000)).toBe("2h");
    expect(formatResetShort(1_700_172_800, 1_700_000_000_000)).toBe("2d");
  });
});

describe("getHighestUsedPercent", () => {
  it("returns the highest used percentage across windows", () => {
    expect(
      getHighestUsedPercent({
        fiveHour: { usedPercent: 81, windowSeconds: 18_000 },
        weekly: { usedPercent: 42, windowSeconds: 604_800 },
        fetchedAt: 1,
      }),
    ).toBe(81);
  });
});

describe("token metadata and headers", () => {
  it("extracts account metadata from ChatGPT OAuth token claims", () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_plan_type: "pro",
      },
      "https://api.openai.com/profile": {
        email: "user@example.com",
      },
    });

    expect(getTokenMetadata(token)).toEqual({
      accountId: "acct_test",
      planType: "pro",
      email: "user@example.com",
    });
    expect(buildUsageHeaders(token)["chatgpt-account-id"]).toBe("acct_test");
    expect(buildUsageHeaders(token).Authorization).toBe(`Bearer ${token}`);
  });

  it("handles invalid tokens without throwing", () => {
    const metadata = getTokenMetadata("not-a-jwt");

    expect(metadata).toEqual({
      accountId: undefined,
      planType: undefined,
      email: undefined,
    });
    expect(hasChatGptUsageCredentials(metadata)).toBe(false);
    expect(
      buildUsageHeaders("not-a-jwt")["chatgpt-account-id"],
    ).toBeUndefined();
  });

  it("requires ChatGPT account metadata before usage fetches are allowed", () => {
    expect(
      hasChatGptUsageCredentials({
        accountId: "acct_test",
        planType: "pro",
        email: "user@example.com",
      }),
    ).toBe(true);
    expect(
      hasChatGptUsageCredentials({
        planType: "pro",
        email: "user@example.com",
      }),
    ).toBe(false);
  });
});

describe("createLatestOnlyRunner", () => {
  it("coalesces pending refreshes while one is running", async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const runner = createLatestOnlyRunner<number>(async (value) => {
      started.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    runner(1);
    await waitFor(() => releases.length === 1);

    runner(2);
    runner(3);
    expect(started).toEqual([1]);

    releases.shift()?.();
    await waitFor(() => releases.length === 1);
    expect(started).toEqual([1, 3]);

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1, 3]);
  });

  it("continues after a failed refresh", async () => {
    const started: number[] = [];
    const runner = createLatestOnlyRunner<number>(async (value) => {
      started.push(value);
      if (value === 1) throw new Error("boom");
    });

    runner(1);
    runner(2);
    await waitFor(() => started.length === 2);

    expect(started).toEqual([1, 2]);
  });
});
