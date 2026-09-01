-- Read-only, report-scoped lead identity lookup by normalized email address or
-- business-owned domain. Automatic inbound matching does not use this function.

CREATE INDEX IF NOT EXISTS leads_email_report_address_idx
  ON public.leads ((lower(btrim(email))))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_email_report_domain_idx
  ON public.leads ((lower(btrim(split_part(btrim(email), '@', 2)))))
  WHERE email IS NOT NULL
    AND position('@' IN btrim(email)) > 1;

CREATE OR REPLACE FUNCTION public.get_email_report_leads(
  p_addresses TEXT[],
  p_domains TEXT[]
)
RETURNS TABLE (
  id UUID,
  business_name TEXT,
  email TEXT,
  status TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  WITH matching_leads AS (
    SELECT leads.id, leads.business_name, leads.email, leads.status
    FROM public.leads AS leads
    WHERE leads.email IS NOT NULL
      AND lower(btrim(leads.email)) = ANY (p_addresses)

    UNION

    SELECT leads.id, leads.business_name, leads.email, leads.status
    FROM public.leads AS leads
    WHERE leads.email IS NOT NULL
      AND position('@' IN btrim(leads.email)) > 1
      AND lower(btrim(split_part(btrim(leads.email), '@', 2))) = ANY (p_domains)
  )
  SELECT matching_leads.id,
         matching_leads.business_name,
         matching_leads.email,
         matching_leads.status
  FROM matching_leads
  ORDER BY matching_leads.id;
$function$;

REVOKE ALL ON FUNCTION public.get_email_report_leads(TEXT[], TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_email_report_leads(TEXT[], TEXT[]) TO authenticated, service_role;
