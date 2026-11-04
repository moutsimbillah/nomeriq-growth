-- Which client saved a row: the connector's own name, as it declared itself at registration.
--
-- Reporting only. It is never read for permissions, scopes or trust, and it is sanitised before it
-- is written (control characters and line breaks stripped, whitespace collapsed, 80 characters max),
-- because the name is supplied by the client. NULL means the portal saved the row, or that the row
-- predates this column.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS source_client text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS source_client text;

-- Backfill the eight rows that existed when this column was added, and only those.
--
-- Every pair below was derived from audit_log: each save_prospect / save_draft call made by an OAuth
-- client carries metadata.client, and the saved row's created_at sits a few seconds after that entry.
--   10:12:03 Claude  -> prospect f8602ca5 P4 Provider      10:12:08 -> draft f4610445
--   10:43:20 Claude  -> prospect 123d1e92 Learn2Trade      10:43:45 -> draft 132a60b9
--   10:45:19 Claude  -> prospect 815a1cd5 Tawsiyat         10:45:25 -> draft c1b2ba85
--   10:55:10 ChatGPT -> prospect fa5981b5 Infinity Signals 10:55:17 -> draft 1eb2aebe
--
-- The pairs are written out by id rather than matched with a wildcard, so this migration can never
-- attribute a row it did not see. A row that already has a value is left alone, which makes every
-- statement below safe to run again.

UPDATE prospects p SET source_client = v.client
  FROM (VALUES
    ('f8602ca5-bf39-402b-84cd-21212da236fd'::uuid, 'Claude'),
    ('123d1e92-be6d-4754-a23c-d7958abce752'::uuid, 'Claude'),
    ('815a1cd5-86c5-4705-9402-ab6b98526c89'::uuid, 'Claude'),
    ('fa5981b5-b8d9-4a2e-acd8-89d4c0f2ee4a'::uuid, 'ChatGPT')
  ) AS v(id, client)
 WHERE p.id = v.id AND p.source_client IS NULL;

UPDATE drafts d SET source_client = v.client
  FROM (VALUES
    ('f4610445-6004-47ef-a012-a4e2b5fa674a'::uuid, 'Claude'),
    ('132a60b9-4d4d-4c66-92fa-f42e0bdf4031'::uuid, 'Claude'),
    ('c1b2ba85-2756-4985-9131-26bf70910f9f'::uuid, 'Claude'),
    ('1eb2aebe-3032-4bde-8be4-7393d5daaa40'::uuid, 'ChatGPT')
  ) AS v(id, client)
 WHERE d.id = v.id AND d.source_client IS NULL;
