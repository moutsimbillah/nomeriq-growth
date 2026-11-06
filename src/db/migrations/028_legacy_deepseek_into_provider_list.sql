-- 028_legacy_deepseek_into_provider_list.sql
-- One provider list: the old single "DeepSeek research provider" form is removed from Settings.
--
-- If that form ever saved a key (one `provider_credentials` row for 'deepseek'), it is copied into
-- `research_providers` as an ordinary DeepSeek provider, so nothing configured there is lost when the
-- form disappears. The encrypted key is copied as it is (same encryption key, never decrypted here).
--
-- Additive and safe to re-run: it inserts only when the old row exists, has a key, and no provider
-- with the copied name exists yet. The old row itself is left untouched. On a database where the old
-- form was never used (the live database has 0 such rows), this does nothing.
--
-- The copy starts with no Test result, so it is not "working" until the founder tests it, and it is
-- not assigned to any AI action.

INSERT INTO research_providers
  (id, name, provider, kinds, base_url, model, encrypted_api_key, search_path, fetch_path,
   priority, is_enabled)
SELECT gen_random_uuid(), 'DeepSeek (from the old form)', 'deepseek', 'both',
       COALESCE(NULLIF(pc.base_url, ''), 'https://api.deepseek.com'),
       COALESCE(NULLIF(pc.model, ''), 'deepseek-flash'),
       pc.encrypted_api_key, pc.search_path, pc.fetch_path,
       100, true
  FROM provider_credentials pc
 WHERE pc.provider = 'deepseek'
   AND pc.encrypted_api_key IS NOT NULL AND pc.encrypted_api_key <> ''
   AND NOT EXISTS (
     SELECT 1 FROM research_providers rp WHERE lower(rp.name) = lower('DeepSeek (from the old form)')
   )
 LIMIT 1;
