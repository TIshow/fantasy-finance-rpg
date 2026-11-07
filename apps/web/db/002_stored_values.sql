-- ログの外に置く値と本文の表（docs/EVENT_LOG.md §5.2。lead の指示 #25）。何度流しても同じ結果になる（冪等）。
-- 価格・分割・配当の内容（kind = 'value'）と、投稿の本文・LLM の出力（kind = 'body'）を、ハッシュを鍵にして追記だけで残す。
-- ハッシュは SHA-256(salt ‖ 中身)。アプリが開くときに全行を照合する（本文は SQL の制約でも確かめる。値の正規化は SQL で再現しない）。
-- 更新・削除・TRUNCATE は、events と同じく、表の持ち主でもトリガが断る。ffr_app には SELECT と INSERT だけを許す。
-- ただし、非表示にした投稿の本文だけは、運営者が erase_withdrawn_body で消せる（db/003_erase_body.sql が削除の見張りを差し替える）。

CREATE TABLE IF NOT EXISTS stored_values (
  hash    text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  kind    text NOT NULL CHECK (kind IN ('value', 'body')),
  salt    text NOT NULL CHECK (salt ~ '^[0-9a-f]{32}$'),
  content jsonb NOT NULL,
  CHECK (kind = 'value' OR jsonb_typeof(content) = 'string'),
  -- 本文のハッシュは SQL でも確かめられる（SHA-256(salt ‖ UTF-8)）。不正な行は入る前に断る。値は RFC 8785 の正規化をアプリが照合する
  CHECK (kind = 'value' OR hash = encode(sha256(decode(salt, 'hex') || convert_to(content #>> '{}', 'UTF8')), 'hex'))
);

CREATE OR REPLACE FUNCTION stored_values_refuse_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS stored_values_refuse_row_change ON stored_values;
CREATE TRIGGER stored_values_refuse_row_change BEFORE UPDATE OR DELETE ON stored_values FOR EACH ROW EXECUTE FUNCTION stored_values_refuse_change();
DROP TRIGGER IF EXISTS stored_values_refuse_truncate ON stored_values;
CREATE TRIGGER stored_values_refuse_truncate BEFORE TRUNCATE ON stored_values FOR EACH STATEMENT EXECUTE FUNCTION stored_values_refuse_change();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffr_app') THEN
    REVOKE ALL ON stored_values FROM ffr_app;
    GRANT SELECT, INSERT ON stored_values TO ffr_app;
  ELSE
    RAISE NOTICE 'role ffr_app does not exist: no privileges were granted (see the header of 001_events.sql)';
  END IF;
END $$;
