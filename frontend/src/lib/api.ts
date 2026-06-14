export const CRM_API = process.env.NEXT_PUBLIC_CRM_API_URL ?? "http://127.0.0.1:8000";
export const CHANNEL_SIM = process.env.NEXT_PUBLIC_CHANNEL_SIM_URL ?? "http://127.0.0.1:8001";

// ---------- Safe fetch helpers ----------
// All API calls go through these so network failures become null/empty results
// instead of unhandled exceptions in the dev overlay.

async function safeGet<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

async function safePost<T>(
  url: string,
  body?: BodyInit | null,
  fallback: T | null = null
): Promise<T | null> {
  try {
    const init: RequestInit = { method: "POST" };
    if (body !== undefined) init.body = body;
    const res = await fetch(url, init);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

// ---------- Health ----------

export type HealthResponse = {
  service: string;
  status: string;
  env?: string;
  checks?: Record<string, unknown>;
  crm_webhook_url?: string;
};

export async function fetchHealth(url: string): Promise<HealthResponse | null> {
  return safeGet<HealthResponse | null>(`${url}/health`, null);
}

// ---------- Data sources ----------

export type SourceQuirk = string;

export type DataSource = {
  key: string;
  label: string;
  system: string;
  filename: string;
  row_count: number;
  primary_identifier: string;
  fields: string[];
  quirks: SourceQuirk[];
};

export type DataSourcesManifest = {
  brand: {
    name: string;
    industry: string;
    country: string;
    description: string;
  };
  underlying_customers: number;
  overlap: {
    in_one_source_only: number;
    in_two_sources: number;
    in_all_three_sources: number;
  };
  sources: DataSource[];
  orders: {
    filename: string;
    row_count: number;
    window_days: number;
    categories: string[];
  };
};

export type CsvPreview = {
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
  limit: number;
};

export async function fetchDataSources(): Promise<DataSourcesManifest | null> {
  return safeGet<DataSourcesManifest | null>(`${CRM_API}/data-sources`, null);
}

export async function fetchPreview(filename: string, limit = 8): Promise<CsvPreview | null> {
  return safeGet<CsvPreview | null>(
    `${CRM_API}/data-sources/${encodeURIComponent(filename)}/preview?limit=${limit}`,
    null
  );
}

export function downloadUrl(filename: string): string {
  return `${CRM_API}/data-sources/${encodeURIComponent(filename)}/download`;
}

// ---------- Ingestion ----------

export type ImportBatch = {
  id: number;
  source_type: string;
  filename: string;
  row_count: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
};

export type DataQualityReport = {
  total_rows: number;
  total_issues: number;
  overall_completeness: number;
  by_source: Record<string, {
    filename: string;
    rows: number;
    issues_total: number;
    checks: Record<string, number>;
    completeness_score: number;
  }>;
  cross_source: {
    phone_cross_source_keys: number;
    email_cross_source_keys: number;
    likely_merges_estimate: number;
    triple_source_phone: number;
    triple_source_email: number;
  };
};

export async function listBatches(): Promise<ImportBatch[]> {
  const data = await safeGet<{ batches?: ImportBatch[] }>(`${CRM_API}/ingest/batches`, {});
  return data.batches ?? [];
}

export async function ingestAllSeed(): Promise<unknown> {
  return safePost(`${CRM_API}/ingest/seed/all`);
}

export async function ingestSource(source: string, file?: File): Promise<unknown> {
  const url = `${CRM_API}/ingest/source/${source}`;
  if (file) {
    const fd = new FormData();
    fd.append("file", file);
    return safePost(url, fd);
  }
  return safePost(url);
}

export async function getDataQuality(): Promise<DataQualityReport | null> {
  return safeGet<DataQualityReport | null>(`${CRM_API}/ingest/data-quality`, null);
}

export async function runResolution(): Promise<ResolutionResult | null> {
  return safePost<ResolutionResult>(`${CRM_API}/ingest/resolve`);
}

export async function resetAll(): Promise<unknown> {
  return safePost(`${CRM_API}/ingest/reset`);
}

// ---------- Identity resolution ----------

export type ResolutionResult = {
  staged_rows: number;
  customers_created: number;
  identities_created: number;
  rule_counts: Record<string, number>;
  flagged_components: number;
  component_size_distribution: Record<string, number>;
  deduplication_rate: number;
  orders?: {
    orders_ingested: number;
    matched_to_customer: number;
    unattributed: number;
    by_source: Record<string, number>;
    match_rate: number;
  };
};

export type IdentityDashboard = {
  staged_total: number;
  staged_by_source: Record<string, number>;
  canonical_total: number;
  deduplication_rate: number;
  rule_mix: Record<string, number>;
  source_coverage: Array<{ sources: number; count: number }>;
  flagged_count: number;
};

export async function getIdentityDashboard(): Promise<IdentityDashboard | null> {
  return safeGet<IdentityDashboard | null>(`${CRM_API}/identities/dashboard`, null);
}

export type FlaggedCustomer = {
  id: number;
  master_customer_id: string;
  full_name: string;
  city: string | null;
  primary_phone: string | null;
  primary_email: string | null;
};

export async function getFlagged(limit = 25): Promise<FlaggedCustomer[]> {
  const data = await safeGet<{ customers?: FlaggedCustomer[] }>(
    `${CRM_API}/identities/flagged?limit=${limit}`,
    {}
  );
  return data.customers ?? [];
}

export async function confirmFlagged(customerId: number): Promise<{ updated: number; action: string } | null> {
  return safePostJson(`${CRM_API}/identities/flagged/${customerId}/confirm`, {});
}

export async function rejectFlagged(
  customerId: number,
): Promise<{ deleted_identities: number; customer_removed: boolean; action: string } | null> {
  return safePostJson(`${CRM_API}/identities/flagged/${customerId}/reject`, {});
}

// ---------- Customers ----------

export type CustomerRow = {
  id: number;
  master_customer_id: string;
  full_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  city: string | null;
  loyalty_tier: string | null;
  lifetime_value: number;
  total_orders: number;
  last_order_at: string | null;
  identity_count: number;
};

export type CustomerListResponse = {
  total: number;
  limit: number;
  offset: number;
  customers: CustomerRow[];
};

export type CustomerListParams = {
  limit?: number;
  offset?: number;
  search?: string;
  city?: string;
  tier?: string;
  min_sources?: number;
  sources_eq?: number;
};

export async function listCustomers(params: CustomerListParams = {}): Promise<CustomerListResponse> {
  const q = new URLSearchParams();
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.offset != null) q.set("offset", String(params.offset));
  if (params.search) q.set("search", params.search);
  if (params.city) q.set("city", params.city);
  if (params.tier) q.set("tier", params.tier);
  if (params.min_sources) q.set("min_sources", String(params.min_sources));
  if (params.sources_eq != null) q.set("sources_eq", String(params.sources_eq));
  return safeGet<CustomerListResponse>(
    `${CRM_API}/customers?${q.toString()}`,
    { total: 0, limit: 0, offset: 0, customers: [] }
  );
}

export type CustomerIdentityRow = {
  id: number;
  source_system: string;
  source_record_id: string;
  raw_name: string | null;
  raw_phone: string | null;
  raw_email: string | null;
  normalized_phone: string | null;
  normalized_email: string | null;
  match_confidence: number;
  match_reasoning: string;
};

export type CustomerOrder = {
  id: number;
  source_system: string;
  source_order_id: string;
  order_date: string | null;
  amount: number;
  items_count: number;
  category: string | null;
  store_id: string | null;
};

export type CustomerDetail = {
  id: number;
  master_customer_id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  city: string | null;
  loyalty_tier: string | null;
  lifetime_value: number;
  total_orders: number;
  last_order_at: string | null;
  identities: CustomerIdentityRow[];
  orders: CustomerOrder[];
  top_categories: Array<{ category: string; count: number }>;
  top_stores: Array<{ store: string; count: number }>;
  consent: {
    whatsapp_opted_in: boolean;
    sms_opted_in: boolean;
    email_opted_in: boolean;
    rcs_opted_in: boolean;
    dnd_status: boolean;
  };
};

export async function getCustomer(id: number): Promise<CustomerDetail | null> {
  return safeGet<CustomerDetail | null>(`${CRM_API}/customers/${id}`, null);
}

export type CustomerStats = {
  total_customers: number;
  by_city_top10: Array<{ city: string; count: number }>;
  by_tier: Array<{ tier: string; count: number }>;
  source_coverage: Array<{ sources: number; count: number }>;
  ltv: { p50: number; p75: number; p90: number; p99: number; max: number };
  consent: { whatsapp: number; sms: number; email: number; rcs: number; dnd: number };
};

export async function getCustomerStats(): Promise<CustomerStats | null> {
  return safeGet<CustomerStats | null>(`${CRM_API}/customers/stats`, null);
}

// ---------- AI ----------

export type MergeExplanation = {
  ai_run_id: number;
  explanation: string;
  recommendation: "approve" | "review" | "reject";
  confidence_assessment: string;
  validation_status: string;
  provider: string;
  model: string;
  latency_ms: number;
};

export async function explainMerge(customerId: number): Promise<MergeExplanation | null> {
  return safePost<MergeExplanation>(`${CRM_API}/customers/${customerId}/explain-merge`);
}

export type AIRun = {
  id: number;
  purpose: string;
  prompt_version: string;
  provider: string;
  model: string;
  input_summary: string | null;
  raw_output: string | null;
  parsed_output: unknown;
  validation_status: string;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
};

export type AIRunsResponse = {
  total: number;
  runs: AIRun[];
  provider_status: {
    configured_provider: string;
    has_anthropic_key: boolean;
    has_openai_key: boolean;
    has_gemini_key: boolean;
    has_groq_key: boolean;
    effective_provider: string;
    fallback_provider: string | null;
  };
};

export async function listAIRuns(limit = 50): Promise<AIRunsResponse | null> {
  return safeGet<AIRunsResponse | null>(`${CRM_API}/ai-runs?limit=${limit}`, null);
}

export async function clearAIRuns(opts: { purpose?: string; status?: string } = {}): Promise<{ deleted: number } | null> {
  const q = new URLSearchParams();
  if (opts.purpose) q.set("purpose", opts.purpose);
  if (opts.status) q.set("status", opts.status);
  try {
    const res = await fetch(`${CRM_API}/ai-runs?${q.toString()}`, { method: "DELETE" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- AI customer ingest ----------

export type AIIngestedCustomerPreview = {
  full_name: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  loyalty_tier?: string | null;
  consent_whatsapp?: boolean | null;
  consent_sms?: boolean | null;
  consent_email?: boolean | null;
  notes?: string | null;
};

export type AIIngestResponse = {
  ai_run_id: number;
  provider: string;
  model: string;
  latency_ms: number;
  validation_status: string;
  rationale: string;
  parsed_customers: AIIngestedCustomerPreview[];
  persisted: boolean;
  created?: Array<{
    id: number;
    master_customer_id: string;
    full_name: string;
    primary_phone: string | null;
    primary_email: string | null;
    city: string | null;
    loyalty_tier: string | null;
  }>;
};

export async function aiIngestCustomers(prompt: string, confirm: boolean): Promise<AIIngestResponse | null> {
  return safePostJson<AIIngestResponse>(`${CRM_API}/customers/ai-ingest`, { prompt, confirm });
}

// ---------- Segments ----------

export type AudienceCriteria = {
  last_order_days_min?: number | null;
  last_order_days_max?: number | null;
  ltv_min?: number | null;
  ltv_max?: number | null;
  total_orders_min?: number | null;
  total_orders_max?: number | null;
  cities?: string[] | null;
  loyalty_tiers?: string[] | null;
  min_source_coverage?: number | null;
};

export type SuppressionRules = {
  exclude_dnd: boolean;
  require_channel_consent?: "whatsapp" | "sms" | "email" | "rcs" | "any" | null;
  recently_contacted_days?: number | null;
};

export type SegmentDefinition = {
  audience_criteria: AudienceCriteria;
  suppression_rules: SuppressionRules;
};

export type SegmentSample = {
  id: number;
  master_customer_id: string;
  full_name: string | null;
  city: string | null;
  loyalty_tier: string | null;
  lifetime_value: number;
  total_orders: number;
  last_order_at: string | null;
  reasons: string[];
};

export type SegmentPreviewResponse = {
  count: number;
  sample: SegmentSample[];
  definition: SegmentDefinition;
};

export type SegmentRow = {
  id: number;
  name: string;
  description: string | null;
  definition: SegmentDefinition;
  preview_count: number;
  created_by_ai: boolean;
  created_at: string | null;
};

export type SegmentTemplate = {
  key: string;
  name: string;
  description: string;
  definition: SegmentDefinition;
};

export const EMPTY_DEFINITION: SegmentDefinition = {
  audience_criteria: {},
  suppression_rules: { exclude_dnd: true, require_channel_consent: null },
};

export async function previewSegment(
  definition: SegmentDefinition,
  sampleLimit = 5
): Promise<SegmentPreviewResponse | null> {
  return safePost<SegmentPreviewResponse>(
    `${CRM_API}/segments/preview`,
    JSON.stringify({ definition, sample_limit: sampleLimit })
  ).then((r) => {
    // safePost helper sets only method; we need to set content-type for JSON body
    return r;
  });
}

// Specialized JSON POST helper (the generic safePost doesn't set content-type for JSON strings)
async function safePostJson<T>(url: string, payload: unknown): Promise<T | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function previewSegmentDef(
  definition: SegmentDefinition,
  sampleLimit = 5
): Promise<SegmentPreviewResponse | null> {
  return safePostJson<SegmentPreviewResponse>(`${CRM_API}/segments/preview`, {
    definition,
    sample_limit: sampleLimit,
  });
}

export async function saveSegment(payload: {
  name: string;
  description?: string;
  definition: SegmentDefinition;
}): Promise<SegmentRow | null> {
  return safePostJson<SegmentRow>(`${CRM_API}/segments`, payload);
}

export async function listSegments(): Promise<SegmentRow[]> {
  const r = await safeGet<{ segments?: SegmentRow[] }>(`${CRM_API}/segments`, {});
  return r.segments ?? [];
}

export async function getSegmentTemplates(): Promise<SegmentTemplate[]> {
  const r = await safeGet<{ templates?: SegmentTemplate[] }>(`${CRM_API}/segments/templates`, {});
  return r.templates ?? [];
}

export type AISegmentResult = {
  ai_run_id: number;
  provider: string;
  model: string;
  validation_status: string;
  latency_ms: number;
  rationale: string;
  definition: SegmentDefinition;
  count: number;
  sample: SegmentSample[];
};

export async function aiGenerateSegment(prompt: string): Promise<AISegmentResult | null> {
  return safePostJson<AISegmentResult>(`${CRM_API}/segments/ai-generate`, { prompt });
}

export async function deleteSegment(id: number): Promise<boolean> {
  try {
    const res = await fetch(`${CRM_API}/segments/${id}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- Campaigns ----------

export type ChannelPolicy = {
  priority: string[];
  respect_consent: boolean;
  respect_dnd: boolean;
};

export type CampaignRow = {
  id: number;
  name: string;
  goal: string | null;
  status: string;
  segment: { id: number; name: string; preview_count: number } | null;
  channel_policy: ChannelPolicy;
  message_template: string;
  ai_plan: unknown;
  created_at: string | null;
  launched_at: string | null;
};

export type CampaignIn = {
  name: string;
  goal?: string | null;
  segment_id: number;
  message_template: string;
  channel_policy: ChannelPolicy;
};

export type CampaignPreview = {
  campaign_id: number;
  template_report: {
    variables_used: string[];
    unknown_variables: string[];
    valid: boolean;
    char_count: number;
  };
  allowed_variables: Record<string, string>;
  samples: Array<{
    customer: { id: number; master_customer_id: string; full_name: string; city: string | null };
    context_used: Record<string, string>;
    rendered: string;
    length_per_channel: Record<string, {
      length: number;
      limit_hard: number;
      limit_soft: number;
      status: string;
      note: string | null;
    }>;
  }>;
  routing_breakdown: {
    total: number;
    by_channel: Record<string, number>;
    skipped: number;
    skipped_reasons: Record<string, number>;
    priority: string[];
  };
};

export async function listCampaigns(): Promise<CampaignRow[]> {
  const r = await safeGet<{ campaigns?: CampaignRow[] }>(`${CRM_API}/campaigns`, {});
  return r.campaigns ?? [];
}

export async function getCampaign(id: number): Promise<CampaignRow | null> {
  return safeGet<CampaignRow | null>(`${CRM_API}/campaigns/${id}`, null);
}

export async function createCampaign(payload: CampaignIn): Promise<CampaignRow | null> {
  return safePostJson<CampaignRow>(`${CRM_API}/campaigns`, payload);
}

export async function updateCampaign(id: number, payload: CampaignIn): Promise<CampaignRow | null> {
  return safePostJson<CampaignRow>(`${CRM_API}/campaigns/${id}`, payload);
}

export async function deleteCampaign(id: number): Promise<boolean> {
  try {
    const res = await fetch(`${CRM_API}/campaigns/${id}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function previewCampaign(id: number): Promise<CampaignPreview | null> {
  return safePostJson<CampaignPreview>(`${CRM_API}/campaigns/${id}/preview`, {});
}

// ---------- Launch + funnel + events ----------

export type LaunchResult = {
  launched: boolean;
  campaign_id?: number;
  targeted?: number;
  skipped?: number;
  skipped_reasons?: Record<string, number>;
  by_channel?: Record<string, number>;
  send_failures?: number;
  demo_timescale?: number;
  error?: string;
};

export async function launchCampaignNow(id: number): Promise<LaunchResult | null> {
  return safePostJson<LaunchResult>(`${CRM_API}/campaigns/${id}/launch`, {});
}

export type RetryQueuedResult = {
  retried: number;
  skipped_no_recipient: number;
  send_failures: number;
};

export async function retryQueued(id: number): Promise<RetryQueuedResult | null> {
  return safePostJson<RetryQueuedResult>(`${CRM_API}/campaigns/${id}/retry-queued`, {});
}

// ---------- Analytics ----------

export type AnalyticsOverview = {
  total_campaigns: number;
  campaigns_by_status: Record<string, number>;
  customers_reached: number;
  total_communications: number;
  sent_reached: number;
  delivered_reached: number;
  clicked_reached: number;
  converted_reached: number;
  failed: number;
  delivery_rate: number;
  click_through_rate: number;
  conversion_rate: number;
  failure_rate: number;
  total_revenue_inr: number;
};

export type ChannelStats = {
  channel: string;
  total: number;
  sent: number;
  delivered: number;
  viewed: number;
  clicked: number;
  converted: number;
  failed: number;
  delivery_rate: number;
  view_rate: number;
  click_through_rate: number;
  conversion_rate: number;
  revenue_inr: number;
  revenue_per_send_inr: number;
};

export type LeaderboardCampaign = {
  id: number;
  name: string;
  status: string;
  is_ai_planned: boolean;
  targeted: number;
  sent: number;
  delivered: number;
  clicked: number;
  converted: number;
  failed: number;
  delivery_rate: number;
  click_through_rate: number;
  conversion_rate: number;
  revenue_inr: number;
  created_at: string | null;
  launched_at: string | null;
};

export type FailuresReport = {
  by_reason: Array<{ reason: string; count: number }>;
  by_channel: Record<string, Record<string, number>>;
  webhook_integrity: {
    duplicates_ignored: number;
    invalid_signatures: number;
    no_communication: number;
    processed: number;
  };
};

export type AIUsageReport = {
  total_runs: number;
  by_purpose: Array<{
    purpose: string;
    runs: number;
    ok: number;
    retry_used: number;
    fallback_used: number;
    fallback_rate: number;
    avg_latency_ms: number;
  }>;
  by_provider: Array<{ provider: string; runs: number }>;
  overall: {
    ok: number;
    retry_used: number;
    fallback_used: number;
    fallback_rate: number;
  };
};

export type RevenuePoint = {
  campaign_id: number;
  name: string;
  launched_at: string | null;
  revenue_inr: number;
};

export type AnalyticsDashboard = {
  overview: AnalyticsOverview;
  channels: ChannelStats[];
  campaigns: LeaderboardCampaign[];
  failures: FailuresReport;
  ai_usage: AIUsageReport;
  revenue_timeline: RevenuePoint[];
};

export async function getAnalyticsDashboard(): Promise<AnalyticsDashboard | null> {
  return safeGet<AnalyticsDashboard | null>(`${CRM_API}/analytics/dashboard`, null);
}

export type CampaignFunnel = {
  campaign_id: number;
  status: string;
  total_targeted: number;
  total_skipped: number;
  by_status: Record<string, number>;
  by_channel: Record<string, number>;
  funnel: Record<string, number>;
  failure_reasons: Record<string, number>;
  launched_at: string | null;
  completed_at: string | null;
};

export async function getCampaignFunnel(id: number): Promise<CampaignFunnel | null> {
  return safeGet<CampaignFunnel | null>(`${CRM_API}/campaigns/${id}/funnel`, null);
}

export type CommunicationEvent = {
  id: number;
  event_id: string;
  communication_id: number;
  campaign_id: number | null;
  event_type: string;
  sequence: number;
  occurred_at: string | null;
  received_at: string | null;
  failure_reason: string | null;
  resolved_channel: string | null;
  customer_id: number | null;
};

export type EventStats = {
  total_events: number;
  by_type: Record<string, number>;
  duplicates_ignored: number;
  invalid_signatures: number;
  failed_deliveries: number;
};

export async function listEvents(params: {
  limit?: number;
  campaign_id?: number;
  communication_id?: number;
  event_type?: string;
} = {}): Promise<CommunicationEvent[]> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.campaign_id) q.set("campaign_id", String(params.campaign_id));
  if (params.communication_id) q.set("communication_id", String(params.communication_id));
  if (params.event_type) q.set("event_type", params.event_type);
  const r = await safeGet<{ events?: CommunicationEvent[] }>(`${CRM_API}/events?${q.toString()}`, {});
  return r.events ?? [];
}

export async function getEventStats(): Promise<EventStats | null> {
  return safeGet<EventStats | null>(`${CRM_API}/events/stats`, null);
}

export type WebhookDelivery = {
  id: number;
  provider_event_id: string | null;
  status: string;
  retry_count: number;
  last_error: string | null;
  raw_payload: unknown;
  received_at: string | null;
  processed_at: string | null;
};

export async function listWebhookDeliveries(limit = 100): Promise<WebhookDelivery[]> {
  const r = await safeGet<{ deliveries?: WebhookDelivery[] }>(`${CRM_API}/webhooks/deliveries?limit=${limit}`, {});
  return r.deliveries ?? [];
}

// ---------- AI campaign planner ----------

export type CampaignPlan = {
  name: string;
  rationale: string;
  segment_definition: SegmentDefinition;
  channel_priority: string[];
  message_template: string;
  message_angle: string;
  success_metric: string;
  suppression_notes: string;
};

export type AIPlanResponse = {
  ai_run_id: number;
  provider: string;
  model: string;
  latency_ms: number;
  validation_status: string;
  plan: CampaignPlan;
  segment_preview: { count: number; sample: SegmentSample[] };
};

export async function aiPlanCampaign(goal: string): Promise<AIPlanResponse | null> {
  return safePostJson<AIPlanResponse>(`${CRM_API}/campaigns/ai-plan`, { goal });
}

export type AIRegenMessageResponse = {
  ai_run_id: number;
  provider: string;
  model: string;
  latency_ms: number;
  validation_status: string;
  message_template: string;
};

export async function aiRegenerateMessage(payload: {
  goal: string;
  message_angle: string;
  previous_template: string;
  channel_priority: string[];
}): Promise<AIRegenMessageResponse | null> {
  return safePostJson<AIRegenMessageResponse>(
    `${CRM_API}/campaigns/ai-plan/regenerate-message`,
    payload,
  );
}

export type CopilotTraceStep = {
  tool: string;
  args: Record<string, unknown>;
  thought?: string | null;
  result: unknown;
};

export type CopilotResponse = {
  ai_run_id: number;
  answer: string;
  trace: CopilotTraceStep[];
  provider: string;
  model: string;
  latency_ms: number;
  validation_status: string;
};

export async function askCopilot(payload: {
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
}): Promise<CopilotResponse | null> {
  return safePostJson<CopilotResponse>(`${CRM_API}/copilot/ask`, payload);
}

export type ReliabilitySummary = {
  total_deliveries: number;
  by_status: {
    processed: number;
    duplicate: number;
    invalid_signature: number;
    no_communication: number;
    failed: number;
  };
  idempotency: { duplicates_absorbed: number; rate: number; note: string };
  ordering: { out_of_order_events: number; note: string };
  security: { rejected_invalid_signature: number; note: string };
  retries: { total_retries: number; failed_pending_replay: number; note: string };
  throughput: { events_last_hour: number; note: string };
};

export async function getReliabilitySummary(): Promise<ReliabilitySummary | null> {
  return safeGet<ReliabilitySummary | null>(`${CRM_API}/reliability/summary`, null);
}

export type FailedDelivery = {
  id: number;
  provider_event_id: string | null;
  status: string;
  retry_count: number;
  last_error: string | null;
  received_at: string | null;
  payload_preview: string | null;
};

export async function listFailedDeliveries(limit = 25): Promise<{ deliveries: FailedDelivery[] }> {
  return safeGet(`${CRM_API}/webhooks/deliveries/failed?limit=${limit}`, { deliveries: [] });
}

export async function replayDelivery(id: number): Promise<{ outcome: string; error: string | null } | null> {
  return safePostJson(`${CRM_API}/webhooks/deliveries/${id}/replay`, {});
}

export type EvalCaseResult = {
  id: string;
  passed: boolean;
  validation_status: string;
  provider: string;
  latency_ms: number;
  failures: string[];
  input_goal?: string;
  expected_summary?: string[];
};

export type EvalRunSummary = {
  passing: number;
  total: number;
  pct: number;
  elapsed_seconds: number;
  results: EvalCaseResult[];
  generated_at: string | null;
  never_run?: boolean;
};

export async function getLastEvalRun(): Promise<EvalRunSummary | null> {
  return safeGet<EvalRunSummary | null>(`${CRM_API}/evals/last`, null);
}

export async function runEvalsNow(): Promise<EvalRunSummary | null> {
  return safePostJson<EvalRunSummary>(`${CRM_API}/evals/run`, {});
}

export async function simulateWebhookFailure(
  kind: "transient" | "invalid_signature" | "no_communication" = "transient",
): Promise<{ delivery_id: number; status: string; note: string } | null> {
  return safePostJson(`${CRM_API}/reliability/simulate-failure?kind=${kind}`, {});
}

export type AutopilotNextResponse = {
  previous_campaign: { id: number; name: string; status: string };
  insight: CampaignInsight;
  followup_goal: { goal: string; rationale: string };
  plan: CampaignPlan;
  ai_runs: { analyst: number; followup_goal: number; planner: number };
  providers: { analyst: string; followup_goal: string; planner: string };
  latency_ms: { analyst: number; followup_goal: number; planner: number; total: number };
};

export async function autopilotNext(campaignId: number): Promise<AutopilotNextResponse | null> {
  return safePostJson<AutopilotNextResponse>(
    `${CRM_API}/campaigns/${campaignId}/autopilot/next`,
    {},
  );
}

export type CsvMappingItem = {
  source_column: string;
  target_field: string | null;
  confidence: number;
  reason: string;
};

export type CsvPreviewResponse = {
  ai_run_id: number;
  provider: string;
  model: string;
  latency_ms: number;
  validation_status: string;
  headers: string[];
  row_count: number;
  sample_rows: { row: Record<string, string>; issues: string[] }[];
  mapping: CsvMappingItem[];
  discarded_columns: string[];
  canonical_fields: string[];
  overall_notes: string;
};

export async function previewCsv(csv_text: string): Promise<CsvPreviewResponse | null> {
  return safePostJson<CsvPreviewResponse>(`${CRM_API}/ingest/csv/preview`, { csv_text });
}

export async function applyCsv(payload: {
  csv_text: string;
  mapping: Record<string, string | null>;
}): Promise<{ ingested: number; skipped: number; total_rows: number; skip_reasons: { row: string; reason: string }[] } | null> {
  return safePostJson(`${CRM_API}/ingest/csv/apply`, payload);
}

export type CampaignInsight = {
  headline: string;
  what_worked: string;
  what_didnt: string;
  next_action: string;
};

export type CampaignInsightResponse = {
  ai_run_id: number;
  provider: string;
  model: string;
  latency_ms: number;
  validation_status: string;
  insight: CampaignInsight;
};

export async function getCampaignInsight(id: number): Promise<CampaignInsightResponse | null> {
  return safePostJson<CampaignInsightResponse>(`${CRM_API}/campaigns/${id}/insight`, {});
}

export async function aiPlanCreate(payload: {
  goal: string;
  name: string;
  rationale?: string;
  segment_definition: SegmentDefinition;
  channel_priority: string[];
  message_template: string;
  message_angle?: string;
  success_metric?: string;
  suppression_notes?: string;
  ai_run_id?: number;
}): Promise<{ campaign_id: number; segment_id: number } | null> {
  return safePostJson(`${CRM_API}/campaigns/ai-plan/create`, payload);
}
