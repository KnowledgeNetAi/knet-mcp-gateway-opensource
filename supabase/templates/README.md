# Auth email templates

Source of truth for the HTML of the two emails the gateway sends through
Supabase Auth: `invite.html` (`inviteUserByEmail`) and `recovery.html`
(`resetPasswordForEmail`). Supabase sends both through whatever SMTP the
project is configured with (Authentication → Emails → SMTP Settings). The
built-in sender is rate-limited, so configure your own before inviting more
than a few people. Change the "MCP Gateway" wordmark in both files to your
own product name if you like.

These files are **not** read at runtime. Supabase stores the template in the
project's auth config, so after editing one, push it:

```sh
TOKEN=<a Supabase personal access token>
python3 - <<'PY' > /tmp/auth-templates.json
import json
print(json.dumps({
  "mailer_templates_invite_content": open("supabase/templates/invite.html").read(),
  "mailer_templates_recovery_content": open("supabase/templates/recovery.html").read(),
}))
PY
curl -X PATCH "https://api.supabase.com/v1/projects/<project-ref>/config/auth" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @/tmp/auth-templates.json
```

The copy says links last 24 hours because `mailer_otp_exp` is 86400. Change
both together. Every link goes through `/auth/confirm`, never
`{{ .ConfirmationURL }}`. That page spends the token on a POST, so a link
scanner that opens the URL can't burn it.
