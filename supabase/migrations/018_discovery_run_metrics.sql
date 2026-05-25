create table if not exists discovery_run_metrics (
  id                         uuid        primary key default gen_random_uuid(),
  run_id                     text        not null,
  run_at                     timestamptz not null default now(),

  -- Targets
  email_target               int         not null default 0,
  dm_target                  int         not null default 0,
  total_target               int         not null default 0,

  -- API usage
  outscraper_calls           int         not null default 0,
  total_results_fetched      int         not null default 0,
  outscraper_results_fetched int         not null default 0,
  businesses_processed       int         not null default 0,
  queries_executed           int         not null default 0,

  -- Funnel drop-offs
  irrelevant_skips           int         not null default 0,
  keyword_filtered_skips     int         not null default 0,
  early_duplicate_skips      int         not null default 0,
  db_duplicate_skips         int         not null default 0,
  dedupe_index_skips         int         not null default 0,
  no_website_skips           int         not null default 0,
  social_only_skips          int         not null default 0,
  website_no_email_skips     int         not null default 0,
  invalid_emails_removed     int         not null default 0,
  halal_confidence_recorded  int         not null default 0,
  qualified_candidates       int         not null default 0,

  -- Outputs
  email_leads_saved          int         not null default 0,
  dm_leads_queued            int         not null default 0,
  total_leads_saved          int         not null default 0,

  -- Derived rates (0–100)
  duplicate_rate_pct         numeric(5,2),
  qualification_rate_pct     numeric(5,2),
  website_coverage_pct       numeric(5,2),
  email_extraction_rate_pct  numeric(5,2),
  efficiency_pct             numeric(5,2),

  -- Cost
  estimated_cost_usd         numeric(10,4),

  -- Pipeline exit
  exit_reason                text,
  runtime_ms                 int,
  safety_limit_hit           boolean     not null default false,
  safety_limit_reason        text,
  cost_guard_hit             boolean     not null default false,

  -- Top/worst query breakdown (JSONB arrays, up to 5 entries each)
  top_yield_queries          jsonb,
  worst_duplicate_queries    jsonb,
  worst_suburb_overlap_queries jsonb,
  lowest_qualification_queries jsonb
);

create index discovery_run_metrics_run_at_idx on discovery_run_metrics (run_at desc);
