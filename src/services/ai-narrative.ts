// ─────────────────────────────────────────────────────────────────────────────
//  AI narrative service (optional enrichment)
//
//  Layered on top of rule-based services (find, trend, depreciation,
//  dealer-alerts) to produce human-readable summaries for end-users.
//
//  Behaviour:
//    - If OPENAI_API_KEY is missing, every helper returns { enabled: false }
//      and callers degrade gracefully (use the rule-based output as-is).
//    - If set, calls OpenAI Chat Completions with `gpt-5-mini` by default
//      (override via OPENAI_MODEL).
//    - Uses GPT-5–compatible params: `max_completion_tokens` and
//      `reasoning_effort: "minimal"` so a small token budget actually
//      yields real JSON instead of being consumed by reasoning tokens
//      (the EstiMate-style trap).
// ─────────────────────────────────────────────────────────────────────────────

import type { ClassicCandidate, DailyCandidate, FindClassicsCriteria, FindDailyCriteria } from './find';
import type { TrendResult } from './trend';
import type { DealerAlert } from './dealer-alerts';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export function aiEnabled(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

interface ChatJsonOpts {
  system: string;
  user: string;
  maxTokens?: number;
}

interface ChatJsonResult<T = unknown> {
  enabled: boolean;
  ok?: boolean;
  json?: T;
  detail?: string;
  modelUsed?: string;
}

async function chatJson<T = unknown>(opts: ChatJsonOpts): Promise<ChatJsonResult<T>> {
  if (!aiEnabled()) return { enabled: false };
  try {
    const isGpt5 = MODEL.startsWith('gpt-5');
    const body: Record<string, unknown> = {
      model: MODEL,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      response_format: { type: 'json_object' },
      // GPT-5 reasoning eats max_completion_tokens — bump default and
      // request minimal reasoning so the JSON survives.
      max_completion_tokens: opts.maxTokens ?? 1200,
    };
    if (isGpt5) {
      body.reasoning_effort = 'minimal';
    } else {
      body.temperature = 0.5;
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text();
      return { enabled: true, ok: false, detail: detail.slice(0, 500) };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || '';
    if (!content.trim()) {
      return {
        enabled: true,
        ok: false,
        detail: `${MODEL} returned empty completion (likely token budget consumed by reasoning).`,
      };
    }
    try {
      return { enabled: true, ok: true, json: JSON.parse(content) as T, modelUsed: MODEL };
    } catch (e) {
      return {
        enabled: true,
        ok: false,
        detail: `Non-JSON response from ${MODEL}: ${content.slice(0, 200)}`,
      };
    }
  } catch (e: any) {
    return { enabled: true, ok: false, detail: e?.message ?? String(e) };
  }
}

// ── Classic finder narrative ─────────────────────────────────────────────────

export interface ClassicFinderNarrative {
  headline: string;
  picks: Array<{
    modelId: string;
    rationale: string;
    watchPriceAud: number | null;
    exitHorizonYears: number;
  }>;
  risks: string[];
}

export async function narrateClassicFinder(args: {
  criteria: FindClassicsCriteria;
  candidates: ClassicCandidate[];
}): Promise<ChatJsonResult<ClassicFinderNarrative>> {
  if (!aiEnabled()) return { enabled: false };
  const top = args.candidates.slice(0, 8).map((c) => ({
    modelId: c.modelId,
    label: `${c.make} ${c.model} ${c.generation || ''}`.trim(),
    referencePrice: c.referencePrice,
    trendDirection: c.trend.direction,
    velocityPctPerMonth: c.trend.velocityPctPerMonth,
    sampleSize: c.trend.sampleSize,
    category: c.category,
    notes: c.notes,
    score: c.score,
  }));
  return chatJson<ClassicFinderNarrative>({
    system:
      'You are an Australian classic-car investment analyst. Be specific. Cite trend direction, sample-size confidence, and risk. Speak from an Australian buyer perspective (RHD market, 25-yr import rule, AU auction comps). Respond strictly as JSON: { "headline": string, "picks": [{ "modelId": string, "rationale": string, "watchPriceAud": number|null, "exitHorizonYears": number }], "risks": [string] }.',
    user: `Buyer criteria: ${JSON.stringify(args.criteria)}.\nPre-scored candidates: ${JSON.stringify(top)}.`,
    maxTokens: 1400,
  });
}

// ── Daily finder narrative ──────────────────────────────────────────────────

export interface DailyFinderNarrative {
  headline: string;
  picks: Array<{
    listingId: string;
    rationale: string;
    riskFlags: string[];
  }>;
  buyerWarning: string | null;
}

export async function narrateDailyFinder(args: {
  criteria: FindDailyCriteria;
  candidates: DailyCandidate[];
}): Promise<ChatJsonResult<DailyFinderNarrative>> {
  if (!aiEnabled()) return { enabled: false };
  const top = args.candidates.slice(0, 6);
  return chatJson<DailyFinderNarrative>({
    system:
      'You are an Australian car-buying advisor. Recommend daily-driver candidates from supplied listings, citing market delta and trend. Respond strictly as JSON: { "headline": string, "picks": [{ "listingId": string, "rationale": string, "riskFlags": string[] }], "buyerWarning": string|null }.',
    user: `Buyer criteria: ${JSON.stringify(args.criteria)}.\nTop scored listings: ${JSON.stringify(top)}.`,
    maxTokens: 1200,
  });
}

// ── Trend narrative for a single model ──────────────────────────────────────

export interface TrendNarrative {
  summary: string;
  signals: string[];
  comparable_models: string[];
  risk_level: 'low' | 'medium' | 'high';
}

export async function narrateTrend(args: {
  make: string;
  model: string;
  year?: number;
  trend: TrendResult;
}): Promise<ChatJsonResult<TrendNarrative>> {
  if (!aiEnabled()) return { enabled: false };
  return chatJson<TrendNarrative>({
    system:
      'You are an Australian used-car market analyst. Respond strictly as JSON: { "summary": string, "signals": [string], "comparable_models": [string], "risk_level": "low"|"medium"|"high" }.',
    user: `Vehicle: ${args.make} ${args.model}${args.year ? ' ' + args.year : ''}. Trend (last ${args.trend.windowDays}d): ${JSON.stringify(args.trend)}.`,
    maxTokens: 900,
  });
}

// ── Dealer alert narrative ──────────────────────────────────────────────────

export interface DealerAlertNarrative {
  summary: string;
  topActions: Array<{ listingId: string; action: string; expectedImpact: string }>;
}

export async function narrateDealerAlerts(args: {
  dealerName: string;
  alerts: DealerAlert[];
}): Promise<ChatJsonResult<DealerAlertNarrative>> {
  if (!aiEnabled()) return { enabled: false };
  const top = args.alerts.slice(0, 10);
  return chatJson<DealerAlertNarrative>({
    system:
      'You are an Australian dealership pricing strategist advising the dealer principal. Be direct and outcome-focused. Respond strictly as JSON: { "summary": string, "topActions": [{ "listingId": string, "action": string, "expectedImpact": string }] }.',
    user: `Dealer: ${args.dealerName}. Pricing alerts (sorted most actionable first): ${JSON.stringify(top)}.`,
    maxTokens: 1100,
  });
}
