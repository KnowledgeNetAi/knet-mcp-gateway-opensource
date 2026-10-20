# Migrations

Apply locally:

    supabase db reset

Apply to a linked project:

    supabase db push

`audit_events` carries customer PII in `args` and is bounded to 90 days.
The retention job is configured outside these migrations.
