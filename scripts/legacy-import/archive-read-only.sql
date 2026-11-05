-- After the archive is loaded, make it read-only at the database level. The import runs this last; the dry
-- run proves it by attempting each write as the app's role and requiring a refusal.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA legacy FROM growth_app;
