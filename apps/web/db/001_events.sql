-- 追記だけのイベントの表（docs/EVENT_LOG.md §4・§8の4、D-040）。何度流しても同じ結果になる（冪等）。
-- アプリの役割（ffr_app）には SELECT と INSERT だけを許す。役割は運営者が作る（Neon のコンソールなど）。
-- トリガは、表の持ち主を含めて、更新・削除・TRUNCATE と、連鎖が続かない追記を断る。

CREATE TABLE IF NOT EXISTS events (
  seq         bigint PRIMARY KEY CHECK (seq >= 1),
  schema_ver  smallint NOT NULL,
  type        text NOT NULL,
  recorded_at bigint NOT NULL,
  actor       text NOT NULL,
  keys        jsonb NOT NULL,
  refs        jsonb NOT NULL,
  payload     jsonb NOT NULL,
  prev_hash   text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash        text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);

-- 追記は、seq が前の次で、prev_hash が前の hash で、recorded_at が戻らないものだけ（先頭は seq 1・0 が64個）
CREATE OR REPLACE FUNCTION events_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
  last_at bigint;
BEGIN
  SELECT seq, hash, recorded_at INTO last_seq, last_hash, last_at FROM events ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN
    last_seq := 0;
    last_hash := repeat('0', 64);
    last_at := NEW.recorded_at;
  END IF;
  IF NEW.seq <> last_seq + 1 OR NEW.prev_hash <> last_hash OR NEW.recorded_at < last_at THEN
    RAISE EXCEPTION 'events: the new row does not continue the log (seq %)', NEW.seq USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION events_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only (% is not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS events_guard_insert ON events;
CREATE TRIGGER events_guard_insert BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_guard_insert();
DROP TRIGGER IF EXISTS events_refuse_row_change ON events;
CREATE TRIGGER events_refuse_row_change BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_refuse_change();
DROP TRIGGER IF EXISTS events_refuse_truncate ON events;
CREATE TRIGGER events_refuse_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION events_refuse_change();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffr_app') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO ffr_app', current_schema());
    REVOKE ALL ON events FROM ffr_app;
    GRANT SELECT, INSERT ON events TO ffr_app;
  END IF;
END $$;
