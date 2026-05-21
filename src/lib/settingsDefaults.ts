export const SETTINGS_DEFAULTS = {
  active_cities: {
    value: 'Sydney',
    description: 'Comma separated list of active cities',
  },
  blocked_business_keywords: {
    value: '[]',
    description: 'JSON array of blocked business name keywords (lowercase, matched by inclusion)',
  },
  blocked_google_categories: {
    value: '[]',
    description: 'JSON array of blocked Google Maps categories (matched exact or by lowercase inclusion)',
  },
  enable_lead_filtering: {
    value: 'false',
    description: 'Enable global lead filtering — skip businesses matching blocked keywords or Google Maps categories before scraping',
  },
  daily_dm_limit: {
    value: '10',
    description: 'Maximum DMs to queue per day (Instagram + Facebook)',
  },
  daily_email_limit: {
    value: '50',
    description: 'Maximum emails to send per day',
  },
  daily_followup1_limit: {
    value: '20',
    description: 'Maximum first follow-up emails to send per day',
  },
  daily_followup2_limit: {
    value: '10',
    description: 'Maximum second follow-up emails to send per day',
  },
  daily_followup3_limit: {
    value: '5',
    description: 'Maximum final follow-up emails to send per day',
  },
  daily_lead_limit: {
    value: '50',
    description: 'Maximum new leads to find per day',
  },
  daily_outscraper_limit: {
    value: '2.00',
    description: 'Maximum Outscraper spend per day in USD. Pipeline stops when reached. Normal daily cost is ~$0.50. Set to $2.00 for safety margin.',
  },
  dead_lead_days: {
    value: '21',
    description: 'Days before marking lead as dead',
  },
  digest_email: {
    value: 'hello@aussieventure.com',
    description: 'Email address for daily digest',
  },
  follow_up_1_days: {
    value: '7',
    description: 'Days before sending first follow-up',
  },
  follow_up_2_days: {
    value: '14',
    description: 'Days before sending second follow-up',
  },
  google_maps_cost_per_request: {
    value: '0.032',
    description: 'Google Maps API cost per request in USD - update if pricing changes',
  },
  google_maps_monthly_limit: {
    value: '180',
    description: 'Switch to Outscraper when Google spend exceeds this',
  },
  google_maps_spend_reset_month: {
    value: '',
    description: 'Last month spend was reset (YYYY-MM format)',
  },
  google_maps_spend_this_month: {
    value: '0.0000',
    description: 'Tracked Google Maps spend this month',
  },
  primary_search_api: {
    value: 'google_maps',
    description: 'Primary API: google_maps or outscraper',
  },
  system_active: {
    value: 'true',
    description: 'Master on/off switch for the entire system',
  },
} as const

export type SettingKey = keyof typeof SETTINGS_DEFAULTS

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS_DEFAULTS
}

export interface SettingRow {
  key: string
  value: string
  description: string | null
}

export function withDefaultSettings(settings: SettingRow[]): SettingRow[] {
  const byKey = new Map(settings.map((setting) => [setting.key, setting]))

  for (const [key, defaults] of Object.entries(SETTINGS_DEFAULTS)) {
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        value: defaults.value,
        description: defaults.description,
      })
    }
  }

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}
