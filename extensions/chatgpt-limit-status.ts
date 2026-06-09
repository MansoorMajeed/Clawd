import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "chatgpt-limit-status";
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const WINDOW_TOLERANCE_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 15_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

type UsageWindow = {
  usedPercent: number;
  windowSeconds: number;
  resetAt?: number;
};

export type ChatGptUsageSnapshot = {
  planType?: string;
  email?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  fetchedAt: number;
};

type TokenMetadata = {
  accountId?: string;
  planType?: string;
  email?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function isOpenAICodexProvider(provider: string | undefined): boolean {
  return (
    provider === "openai-codex" || /^openai-codex-\d+$/.test(provider ?? "")
  );
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const usedPercent =
    typeof record.used_percent === "number" ? record.used_percent : undefined;
  const windowSeconds =
    typeof record.limit_window_seconds === "number"
      ? record.limit_window_seconds
      : undefined;
  const resetAt =
    typeof record.reset_at === "number" ? record.reset_at : undefined;

  if (usedPercent === undefined || windowSeconds === undefined)
    return undefined;
  return { usedPercent, windowSeconds, resetAt };
}

function matchesWindow(window: UsageWindow, seconds: number): boolean {
  return Math.abs(window.windowSeconds - seconds) <= WINDOW_TOLERANCE_SECONDS;
}

export function parseUsageSnapshot(
  data: unknown,
  fetchedAt = Date.now(),
): ChatGptUsageSnapshot {
  const raw = asRecord(data);
  const rateLimit = asRecord(raw?.rate_limit);
  const windows = [
    normalizeWindow(rateLimit?.primary_window),
    normalizeWindow(rateLimit?.secondary_window),
  ].filter((window): window is UsageWindow => Boolean(window));

  return {
    planType: typeof raw?.plan_type === "string" ? raw.plan_type : undefined,
    email: typeof raw?.email === "string" ? raw.email : undefined,
    fiveHour: windows.find((window) =>
      matchesWindow(window, FIVE_HOUR_SECONDS),
    ),
    weekly: windows.find((window) => matchesWindow(window, WEEK_SECONDS)),
    fetchedAt,
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function getRemainingPercent(window: UsageWindow): number {
  return Math.round(clampPercent(100 - window.usedPercent));
}

function formatRemainingPercent(window: UsageWindow): string {
  return `${getRemainingPercent(window)}%`;
}

export function formatResetShort(
  resetAt: number | undefined,
  nowMs = Date.now(),
): string {
  if (!resetAt) return "?";

  const minutes = Math.max(0, Math.round((resetAt * 1000 - nowMs) / 60_000));
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function formatPart(
  label: string,
  window: UsageWindow | undefined,
  nowMs: number,
): string | undefined {
  if (!window) return undefined;
  return `${label} ${formatRemainingPercent(window)} ↺${formatResetShort(window.resetAt, nowMs)}`;
}

export function formatChatGptLimitStatus(
  snapshot: ChatGptUsageSnapshot | undefined,
  nowMs = Date.now(),
): string | undefined {
  const parts = [
    formatPart("5h", snapshot?.fiveHour, nowMs),
    formatPart("W", snapshot?.weekly, nowMs),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `GPT ${parts.join(" · ")}` : undefined;
}

export function getHighestUsedPercent(
  snapshot: ChatGptUsageSnapshot | undefined,
): number {
  return Math.max(
    snapshot?.fiveHour?.usedPercent ?? 0,
    snapshot?.weekly?.usedPercent ?? 0,
  );
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function getTokenMetadata(token: string): TokenMetadata {
  const payload = decodeJwtPayload(token);
  const auth = asRecord(payload[OPENAI_AUTH_CLAIM]);
  const profile = asRecord(payload[OPENAI_PROFILE_CLAIM]);

  return {
    accountId:
      typeof auth?.chatgpt_account_id === "string"
        ? auth.chatgpt_account_id
        : undefined,
    planType:
      typeof auth?.chatgpt_plan_type === "string"
        ? auth.chatgpt_plan_type
        : undefined,
    email: typeof profile?.email === "string" ? profile.email : undefined,
  };
}

export function buildUsageHeaders(
  token: string,
  metadata = getTokenMetadata(token),
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "clawd-chatgpt-limit-status",
    ...(metadata.accountId ? { "chatgpt-account-id": metadata.accountId } : {}),
  };
}

export function hasChatGptUsageCredentials(metadata: TokenMetadata): boolean {
  return Boolean(metadata.accountId);
}

function clearStatus(ctx: ExtensionContext): void {
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

function colorRemainingPercent(
  ctx: ExtensionContext,
  window: UsageWindow,
): string {
  const remaining = getRemainingPercent(window);
  const text = `${remaining}%`;
  if (remaining <= 10) return ctx.ui.theme.fg("error", text);
  if (remaining <= 20) return ctx.ui.theme.fg("warning", text);
  return ctx.ui.theme.fg("success", text);
}

function formatThemedPart(
  ctx: ExtensionContext,
  label: string,
  window: UsageWindow | undefined,
  nowMs: number,
): string | undefined {
  if (!window) return undefined;
  const theme = ctx.ui.theme;
  return `${theme.fg("muted", label)} ${colorRemainingPercent(ctx, window)} ${theme.fg(
    "dim",
    `↺${formatResetShort(window.resetAt, nowMs)}`,
  )}`;
}

function formatThemedStatus(
  ctx: ExtensionContext,
  snapshot: ChatGptUsageSnapshot,
): string | undefined {
  const nowMs = Date.now();
  const parts = [
    formatThemedPart(ctx, "5h", snapshot.fiveHour, nowMs),
    formatThemedPart(ctx, "W", snapshot.weekly, nowMs),
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return undefined;
  return `${ctx.ui.theme.fg("muted", "GPT")} ${parts.join(ctx.ui.theme.fg("dim", " · "))}`;
}

function setUsageStatus(
  ctx: ExtensionContext,
  snapshot: ChatGptUsageSnapshot,
): void {
  if (!ctx.hasUI) return;
  const text = formatThemedStatus(ctx, snapshot);
  ctx.ui.setStatus(STATUS_KEY, text);
}

async function fetchUsage(
  ctx: ExtensionContext,
  model = ctx.model,
): Promise<ChatGptUsageSnapshot | undefined> {
  if (!isOpenAICodexProvider(model?.provider)) {
    clearStatus(ctx);
    return undefined;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    clearStatus(ctx);
    return undefined;
  }

  const metadata = getTokenMetadata(auth.apiKey);
  if (!hasChatGptUsageCredentials(metadata)) {
    clearStatus(ctx);
    return undefined;
  }

  try {
    const response = await fetch(CHATGPT_USAGE_URL, {
      headers: buildUsageHeaders(auth.apiKey, metadata),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      clearStatus(ctx);
      return undefined;
    }

    const snapshot = parseUsageSnapshot(await response.json());
    if (!snapshot.email && metadata.email) snapshot.email = metadata.email;
    if (!snapshot.planType && metadata.planType)
      snapshot.planType = metadata.planType;
    setUsageStatus(ctx, snapshot);
    return snapshot;
  } catch {
    clearStatus(ctx);
    return undefined;
  }
}

export function createLatestOnlyRunner<T>(
  run: (value: T) => Promise<void>,
): (value: T) => void {
  let running = false;
  let pending: T | undefined;

  const queue = (value: T) => {
    pending = value;
    if (running) return;

    running = true;
    void (async () => {
      try {
        while (pending !== undefined) {
          const next = pending;
          pending = undefined;
          try {
            await run(next);
          } catch {}
        }
      } finally {
        running = false;
        if (pending !== undefined) queue(pending);
      }
    })();
  };

  return queue;
}

type RefreshRequest = {
  ctx: ExtensionContext;
  model?: ExtensionContext["model"];
};

export default function (pi: ExtensionAPI) {
  const queueUpdate = createLatestOnlyRunner<RefreshRequest>(
    async (request) => {
      await fetchUsage(request.ctx, request.model);
    },
  );

  pi.on("session_start", (_event, ctx) => queueUpdate({ ctx }));
  pi.on("model_select", (event, ctx) =>
    queueUpdate({ ctx, model: event.model }),
  );
  pi.on("agent_end", (_event, ctx) => queueUpdate({ ctx }));
  pi.on("session_shutdown", (_event, ctx) => clearStatus(ctx));
}
