import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { routeInitialEmail, type InitialEmailLead } from '@/lib/initial-email-router'
import { generateFollowUpEmail, type FollowUpBusinessContext } from '@/lib/followup-generation'
import { generateStoredReactivation } from '@/lib/stored-sequence-templates'
import { INITIAL_SIGN_OFF } from '@/lib/email-voice'
import {
  OUTREACH_SIGNATURE,
  OUTREACH_SIGNATURE_TEXT,
  appendOutreachSignature,
  composeOutreachEmailBody,
} from '@/lib/outreach-signature'

const count = (value: string, needle: string) => value.split(needle).length - 1
const assertOneSignature = (bodyText: string, bodyHtml: string, label: string) => {
  assert.equal(count(bodyText, OUTREACH_SIGNATURE.email), 1, `${label}: text signature appears once`)
  assert.equal(count(bodyHtml, 'data-outreach-signature="aussie-venture"'), 1, `${label}: HTML signature appears once`)
  for (const { url } of OUTREACH_SIGNATURE.socialProfiles) {
    assert.equal(count(bodyText, url), 1, `${label}: ${url} appears once in text`)
    assert.equal(count(bodyHtml, `href="${url}"`), 1, `${label}: ${url} has one clickable HTML link`)
  }
}

type Row = Record<string, unknown>
class TemplateQuery {
  private filters: Record<string, unknown> = {}
  constructor(private table: string, private rows: Record<string, Row[]>) {}
  select() { return this }
  eq(key: string, value: unknown) { this.filters[key] = value; return this }
  maybeSingle() {
    const data = (this.rows[this.table] ?? []).find((row) => Object.entries(this.filters).every(([key, value]) => row[key] === value)) ?? null
    return Promise.resolve({ data, error: null })
  }
}

const lead: InitialEmailLead = {
  id: 'lead-1', business_name: 'Harbour <Escape>', category_id: 'cat-1', category_name: 'Escape Rooms',
  suburb: null, city: 'Sydney', website: 'https://example.com', description: null, services: null, content_type: 'visit',
}
const templateSupabase = {
  from(table: string) {
    return new TemplateQuery(table, {
      categories: [{ id: 'cat-1', name: 'Escape Rooms' }],
      category_email_templates: [{
        category_id: 'cat-1', template_type: 'initial_pitch', subject_template: 'Hello {{business_name}}',
        body_template: `Hey {{business_name}},\n\nMain body stays intact.\n\n${INITIAL_SIGN_OFF}`,
      }],
    })
  },
}

const business: FollowUpBusinessContext = {
  businessName: 'Harbour Escape', category: 'Escape Rooms', suburb: 'Sydney', city: 'Sydney', website: '',
  description: '', services: '', notes: '', contentType: 'visit',
}

async function main() {
  const legacyMainBody = 'Hey there,\n\nLegacy main body stays intact.'
  const legacyLf = `${legacyMainBody}\n\n${INITIAL_SIGN_OFF}`
  const legacyLfComposed = composeOutreachEmailBody(legacyLf)
  assert.equal(legacyLfComposed.bodyText, `${legacyMainBody}\n\n${OUTREACH_SIGNATURE_TEXT}`, 'an exact terminal LF legacy sign-off is replaced by the canonical signature')
  assertOneSignature(legacyLfComposed.bodyText, legacyLfComposed.bodyHtml, 'legacy LF sign-off')

  const legacyCrlf = legacyLf.replaceAll('\n', '\r\n')
  const legacyCrlfComposed = composeOutreachEmailBody(legacyCrlf)
  assert.equal(legacyCrlfComposed.bodyText, `${legacyMainBody.replaceAll('\n', '\r\n')}\n\n${OUTREACH_SIGNATURE_TEXT}`, 'an exact terminal CRLF legacy sign-off is replaced by the canonical signature')
  assertOneSignature(legacyCrlfComposed.bodyText, legacyCrlfComposed.bodyHtml, 'legacy CRLF sign-off')

  const nonTerminalLegacy = `Intro\n\n${INITIAL_SIGN_OFF}\n\nKeep this trailing paragraph.`
  const nonTerminalComposed = composeOutreachEmailBody(nonTerminalLegacy)
  assert.ok(nonTerminalComposed.bodyText.includes(nonTerminalLegacy), 'a non-terminal legacy-looking block is preserved')

  const shortBody = 'Hey there,\n\nMain body.\n\nCheers,\nOwais'
  const signed = appendOutreachSignature(shortBody)
  assert.equal(signed, `Hey there,\n\nMain body.\n\n${OUTREACH_SIGNATURE_TEXT}`)
  assert.equal(appendOutreachSignature(signed), signed, 'a complete canonical signature is unchanged')
  assert.equal(appendOutreachSignature(appendOutreachSignature(shortBody)), signed, 'plain-text composition is idempotent')
  const windowsSigned = signed.replaceAll('\n', '\r\n')
  assert.equal(appendOutreachSignature(windowsSigned), windowsSigned, 'an existing CRLF canonical signature is recognised without modification')
  assert.ok(appendOutreachSignature('Do not remove NotCheers,\nOwais').startsWith('Do not remove NotCheers,\nOwais\n\n'), 'a short sign-off is removed only at an exact line boundary')
  assert.ok(signed.startsWith('Hey there,\n\nMain body.\n\n'), 'main body content and line breaks are preserved')
  assert.equal(signed.slice(-OUTREACH_SIGNATURE_TEXT.length), OUTREACH_SIGNATURE_TEXT, 'plain text ends in the exact canonical signature')

  const legitimateCheers = composeOutreachEmailBody('Hey there,\n\nCheers for reading <this> & replying.\n\nCheers,\nOwais')
  assert.ok(legitimateCheers.bodyText.includes('Cheers for reading <this> & replying.'), 'non-terminal body content containing Cheers is preserved')
  assert.ok(legitimateCheers.bodyHtml.includes('Cheers for reading &lt;this&gt; &amp; replying.'), 'dynamic HTML content is escaped')
  assert.ok(legitimateCheers.bodyHtml.includes(`href="mailto:${OUTREACH_SIGNATURE.email}"`), 'email address is clickable')
  assert.ok(legitimateCheers.bodyHtml.includes(`href="${OUTREACH_SIGNATURE.website}"`), 'website is clickable')
  assertOneSignature(legitimateCheers.bodyText, legitimateCheers.bodyHtml, 'shared composer')

  const templateInitial = await routeInitialEmail(templateSupabase as never, lead, 'template', { operation: 'content_only' })
  assert.ok(templateInitial.ok)
  assert.equal(templateInitial.body, `Hey Harbour <Escape>,\n\nMain body stays intact.\n\n${OUTREACH_SIGNATURE_TEXT}`, 'a custom template ending in the legacy sign-off gets one canonical signature')
  assertOneSignature(templateInitial.body!, templateInitial.html!, 'Template Initial')

  let aiCalls = 0
  const aiInitial = await routeInitialEmail(templateSupabase as never, lead, 'ai_personalised', {
    operation: 'content_only',
    aiWriter: async () => { aiCalls++; return { subject: 'AI subject', body: shortBody } },
  })
  assert.ok(aiInitial.ok)
  assert.equal(aiCalls, 1, 'AI Personalised generation executes once')
  assertOneSignature(aiInitial.body!, aiInitial.html!, 'AI Personalised Initial')

  for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as const) {
    const result = await generateFollowUpEmail(type, business, 'Initial subject', [])
    assertOneSignature(result.body, result.html, type)
  }

  const reactivation = await generateStoredReactivation({} as never, null, business.businessName, business.category, business.contentType)
  assertOneSignature(reactivation.body, reactivation.html, 'Reactivation')

  const composed = composeOutreachEmailBody(legacyLf)
  let deliveryCalls = 0
  const delivered = await (async (message: { text: string; html: string }) => { deliveryCalls++; return message })({ text: composed.bodyText, html: composed.bodyHtml })
  const stored = { body_text: composed.bodyText, body_html: composed.bodyHtml }
  assert.equal(stored.body_text, `${legacyMainBody}\n\n${OUTREACH_SIGNATURE_TEXT}`, 'editing a legacy pending draft stores one canonical signature')
  assertOneSignature(stored.body_text, stored.body_html, 'edited legacy pending draft')
  assert.deepEqual(delivered, { text: stored.body_text, html: stored.body_html }, 'stored content exactly matches delivery-layer content')
  assert.equal(deliveryCalls, 1, 'signature composition does not execute an email operation twice')

  const resendSource = readFileSync(resolve(process.cwd(), 'src/lib/resend.ts'), 'utf8')
  assert.doesNotMatch(resendSource, /composeOutreachEmailBody|appendOutreachSignature/, 'low-level Resend transport does not append the signature')
  console.log('Outreach signature composition checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
