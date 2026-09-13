-- Keep recipient ownership as the authority for outreach eligibility, while
-- ensuring a rejected Initial Email can never remain in the active queue.
CREATE OR REPLACE FUNCTION public.claim_recipient_outreach(p_lead_id UUID, p_phase TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT;
  v_owner UUID;
  v_bad TEXT;
  v_provisional BOOLEAN := false;
  v_claim_token UUID;
BEGIN
  IF p_phase NOT IN ('initial','follow_up','reactivation') THEN RAISE EXCEPTION 'Invalid outreach phase'; END IF;
  SELECT normalized_email INTO v_email FROM leads WHERE id = p_lead_id FOR UPDATE;
  IF v_email IS NULL THEN
    UPDATE leads SET
      outreach_suppression_reason = 'invalid_email',
      outreach_suppressed_at = COALESCE(outreach_suppressed_at, now()),
      status = CASE WHEN status = 'email_ready' THEN 'researched' ELSE status END,
      updated_at = now()
    WHERE id = p_lead_id;
    UPDATE emails SET status = 'failed'
    WHERE lead_id = p_lead_id AND type = 'initial_pitch' AND status = 'pending_send';
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', NULL, 'normalized_email', NULL, 'reason', 'invalid_email');
  END IF;

  SELECT issue_type INTO v_bad FROM lead_data_quality_flags
  WHERE lead_id = p_lead_id AND status = 'open'
    AND issue_type IN ('invalid_email','placeholder_email','technical_email')
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    UPDATE leads SET
      outreach_suppression_reason = v_bad,
      outreach_suppressed_at = COALESCE(outreach_suppressed_at, now()),
      status = CASE WHEN status = 'email_ready' THEN 'researched' ELSE status END,
      updated_at = now()
    WHERE id = p_lead_id;
    UPDATE emails SET status = 'failed'
    WHERE lead_id = p_lead_id AND type = 'initial_pitch' AND status = 'pending_send';
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', NULL, 'normalized_email', v_email, 'reason', v_bad);
  END IF;

  -- The advisory transaction lock plus normalized_email primary key makes the
  -- first claim atomic across Writer, automated Sender, and manual send paths.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 734921));
  SELECT owner_lead_id INTO v_owner
  FROM recipient_outreach_ownership
  WHERE normalized_email = v_email
  FOR UPDATE;
  v_provisional := v_owner IS NULL;
  IF v_owner IS NULL THEN
    SELECT l.id INTO v_owner
    FROM leads l
    JOIN emails e ON e.lead_id = l.id AND e.status IN ('sent','email_sync_failed')
    LEFT JOIN deals d ON d.lead_id = l.id
    WHERE l.normalized_email = v_email
    ORDER BY
      CASE WHEN d.id IS NOT NULL OR l.status IN ('replied','negotiating','interested','closed_won','closed','closed_manual') THEN 0 ELSE 1 END,
      e.sent_at ASC NULLS LAST, l.created_at ASC, l.id
    LIMIT 1;
  END IF;
  IF v_owner IS NULL THEN v_owner := p_lead_id; END IF;
  IF v_provisional AND v_owner = p_lead_id THEN v_claim_token := gen_random_uuid(); END IF;

  INSERT INTO recipient_outreach_ownership (normalized_email, owner_lead_id, metadata)
  VALUES (
    v_email,
    v_owner,
    jsonb_build_object('source', 'claim', 'phase', p_phase)
      || CASE WHEN v_claim_token IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('claim_token', v_claim_token) END
  )
  ON CONFLICT (normalized_email) DO UPDATE SET
    owner_lead_id = COALESCE(recipient_outreach_ownership.owner_lead_id, EXCLUDED.owner_lead_id),
    state = 'active',
    last_activity_at = now(),
    metadata = CASE
      WHEN recipient_outreach_ownership.owner_lead_id IS NULL
        THEN recipient_outreach_ownership.metadata || EXCLUDED.metadata
      ELSE recipient_outreach_ownership.metadata
    END;
  SELECT owner_lead_id INTO v_owner
  FROM recipient_outreach_ownership
  WHERE normalized_email = v_email;

  INSERT INTO lead_data_quality_flags (lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
  SELECT l.id, v_email, 'already_contacted_email',
    'Another lead owns the active outreach lifecycle for this recipient.',
    ARRAY[v_owner], jsonb_build_object('owner_lead_id', v_owner, 'phase', p_phase)
  FROM leads l
  WHERE l.normalized_email = v_email AND l.id <> v_owner
  ON CONFLICT DO NOTHING;

  IF v_owner <> p_lead_id THEN
    UPDATE leads SET
      outreach_suppression_reason = 'email_already_contacted',
      outreach_suppressed_at = COALESCE(outreach_suppressed_at, now()),
      status = CASE WHEN status = 'email_ready' THEN 'researched' ELSE status END,
      updated_at = now()
    WHERE id = p_lead_id;
    UPDATE emails SET status = 'failed'
    WHERE lead_id = p_lead_id AND type = 'initial_pitch' AND status = 'pending_send';
    INSERT INTO lead_data_quality_flags (lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
    VALUES (
      p_lead_id, v_email, 'already_contacted_email',
      'Another lead owns the active outreach lifecycle for this recipient.',
      ARRAY[v_owner], jsonb_build_object('owner_lead_id', v_owner, 'phase', p_phase)
    )
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', v_owner, 'normalized_email', v_email, 'reason', 'email_already_contacted');
  END IF;

  UPDATE leads
  SET outreach_suppression_reason = NULL, outreach_suppressed_at = NULL
  WHERE id = p_lead_id AND outreach_suppression_reason = 'email_already_contacted';
  RETURN jsonb_build_object(
    'allowed', true,
    'owner_lead_id', v_owner,
    'normalized_email', v_email,
    'reason', NULL,
    'claim_token', v_claim_token
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_recipient_outreach(UUID, TEXT) TO authenticated, service_role;

-- A generation failure may occur after the atomic claim but before a draft is
-- durable. Release only that provisional claim, and only while no outreach or
-- progressed lifecycle exists. The recipient advisory lock keeps this atomic
-- with concurrent claims for the same normalized address.
CREATE OR REPLACE FUNCTION public.release_recipient_outreach_claim(
  p_lead_id UUID,
  p_normalized_email TEXT,
  p_claim_token UUID
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT := NULLIF(lower(btrim(p_normalized_email)), '');
BEGIN
  IF v_email IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 734921));

  UPDATE recipient_outreach_ownership o
  SET owner_lead_id = NULL,
      state = 'released',
      last_activity_at = now(),
      metadata = o.metadata || jsonb_build_object(
        'released_source', 'generation_persistence_failure',
        'released_lead_id', p_lead_id,
        'released_at', now()
      )
  WHERE o.normalized_email = v_email
    AND o.owner_lead_id = p_lead_id
    AND o.metadata->>'claim_token' = p_claim_token::TEXT
    AND NOT EXISTS (
      SELECT 1 FROM emails e
      WHERE e.lead_id = p_lead_id
        AND e.status IN ('pending_send','sent','email_sync_failed')
        AND COALESCE(e.sent_at, e.created_at) >= o.last_activity_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM leads l
      WHERE l.id = p_lead_id
        AND l.status IN ('email_ready','contacted','replied','negotiating','interested','closed_won','closed','closed_manual')
    );
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.release_recipient_outreach_claim(UUID, TEXT, UUID) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.release_recipient_outreach_claim(UUID, TEXT, UUID) TO service_role;

-- Suppression belongs to the normalized recipient, not permanently to the
-- lead. A genuinely corrected address may re-enter the normal Writer query;
-- the ownership RPC will then adjudicate the new recipient atomically.
CREATE OR REPLACE FUNCTION public.clear_lead_outreach_suppression_on_email_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bad TEXT;
BEGIN
  IF NULLIF(lower(btrim(OLD.email)), '') IS DISTINCT FROM NULLIF(lower(btrim(NEW.email)), '') THEN
    SELECT q.issue_type INTO v_bad
    FROM public.classify_email_quality(NEW.email) q
    LIMIT 1;
    UPDATE leads
    SET outreach_suppression_reason = v_bad,
        outreach_suppressed_at = CASE WHEN v_bad IS NULL THEN NULL ELSE COALESCE(outreach_suppressed_at, now()) END
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_clear_outreach_suppression_on_email_change ON public.leads;
CREATE TRIGGER leads_clear_outreach_suppression_on_email_change
  AFTER UPDATE OF email ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.clear_lead_outreach_suppression_on_email_change();
