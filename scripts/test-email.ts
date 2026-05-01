import { Resend } from 'resend'
import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../.env.local') })

const resend = new Resend(process.env.RESEND_API_KEY!)

const bodyText = `Hey Taste of Istanbul,

Came across you on Google while looking for great halal spots in Lakemba. Food looks amazing.

I run Aussie Venture, an Australian food and lifestyle page with around 500K followers. We're building out our halal food content and would love to feature you.

Would love to come in and try the food - no cost at all, just a collab. Let me know if you're keen!

Cheers,
Owais
Aussie Venture
hello@aussieventure.com
aussieventure.com`

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:540px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#0f1117;padding:24px 32px;">
      <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Aussie Venture</p>
      <p style="margin:3px 0 0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Outreach Preview</p>
    </div>

    <!-- Body -->
    <div style="padding:32px;font-size:15px;color:#374151;line-height:1.7;">
      <p style="margin:0 0 18px;">Hey <strong>Taste of Istanbul</strong>,</p>

      <p style="margin:0 0 18px;">
        Came across you on Google while looking for great halal spots in Lakemba.
        Food looks amazing.
      </p>

      <p style="margin:0 0 18px;">
        I run <strong>Aussie Venture</strong>, an Australian food and lifestyle page with around
        <strong>500K followers</strong>. We're building out our halal food content and would love
        to feature you.
      </p>

      <p style="margin:0 0 32px;">
        Would love to come in and try the food - no cost at all, just a collab.
        Let me know if you're keen!
      </p>

      <!-- Signature -->
      <p style="margin:0 0 2px;font-size:15px;color:#111827;font-weight:600;">Cheers,</p>
      <p style="margin:0 0 2px;font-size:15px;font-weight:700;color:#111827;">Owais</p>
      <p style="margin:0;font-size:13px;color:#6b7280;">
        Aussie Venture &nbsp;·&nbsp;
        <a href="mailto:hello@aussieventure.com" style="color:#0ea5e9;text-decoration:none;">hello@aussieventure.com</a>
        &nbsp;·&nbsp;
        <a href="https://aussieventure.com" style="color:#0ea5e9;text-decoration:none;">aussieventure.com</a>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
        Test email from Aussie Venture Outreach System
      </p>
    </div>

  </div>
</body>
</html>`

async function main() {
  console.log('Sending test email via Resend...')

  const result = await resend.emails.send({
    from: 'Owais | Aussie Venture <hello@aussieventure.com>',
    to: 'owais_ahmed12@hotmail.com',
    subject: 'Collab with Aussie Venture - Taste of Istanbul',
    html,
    text: bodyText,
  })

  if (result.error) {
    console.error('Failed:', result.error)
    process.exit(1)
  }

  console.log('Email sent!')
  console.log('ID:', result.data?.id)
  console.log('To: owais_ahmed12@hotmail.com')
}

main()
