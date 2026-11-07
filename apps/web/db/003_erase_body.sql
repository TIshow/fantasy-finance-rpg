-- 非表示にした投稿の本文を消す手続き（docs/EVENT_LOG.md §5.2・§6.1。lead の指示 #25 PR-3）。何度流しても同じ結果になる（冪等）。
-- 消せるのは、stored_values の本文（kind = 'body'）のうち、次をすべて満たすものだけ。乱数（salt）は同じ行にあるので一緒に消える。
--   * その本文を bodyHash に持つ post.published があり、それらすべてについて、最後の content.withdrawn（運営者が書いたもの）の bodyErased が真
-- イベントの表は変えない。本文のハッシュはイベントに残るので、ハッシュの連鎖は壊れない。
-- 消すのは erase_withdrawn_body(投稿の seq) だけ。表の持ち主（運営者）の接続から呼ぶ。ffr_app は、この関数を実行する権限も、
-- stored_values を削除する権限も持たない。上の条件に合わない削除と、この関数を通らない削除は、持ち主でもトリガが断る。
-- 運営者の手順は db/ops/erase_body.sql。

-- 本文 h を消してよいか（上の条件）。表は schema を指定して引く（呼ぶ側の search_path に左右されない）
CREATE OR REPLACE FUNCTION stored_values_erasable(sch text, h text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  posts int;
  erasable int;
BEGIN
  EXECUTE format($q$
    SELECT count(*)::int,
           count(*) FILTER (WHERE (SELECT w.payload->'bodyErased' FROM %1$I.events w
                                   WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%%' AND w.payload->'targetSeq' = to_jsonb(p.seq)
                                   ORDER BY w.seq DESC LIMIT 1) = 'true'::jsonb)::int
    FROM %1$I.events p WHERE p.type = 'post.published' AND p.payload->>'bodyHash' = $1$q$, sch) INTO posts, erasable USING h;
  RETURN posts > 0 AND posts = erasable;
END $$;

-- stored_values の削除の見張り。erase_withdrawn_body が、消す本文のハッシュをこのトランザクションだけの設定（ffr.erase_body）に入れたときだけ通す
CREATE OR REPLACE FUNCTION stored_values_guard_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF current_setting('ffr.erase_body', true) IS NOT DISTINCT FROM OLD.hash AND OLD.kind = 'body' THEN
    EXECUTE format('SELECT %I.stored_values_erasable($1, $2)', TG_TABLE_SCHEMA) INTO ok USING TG_TABLE_SCHEMA, OLD.hash;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'stored_values is append-only (DELETE is not allowed except a withdrawn body through erase_withdrawn_body)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;

-- 002 の行の見張りは更新と削除の両方を断るので、更新だけにして、削除は上の見張りに任せる
DROP TRIGGER IF EXISTS stored_values_refuse_row_change ON stored_values;
CREATE TRIGGER stored_values_refuse_row_change BEFORE UPDATE ON stored_values FOR EACH ROW EXECUTE FUNCTION stored_values_refuse_change();
DROP TRIGGER IF EXISTS stored_values_guard_delete ON stored_values;
CREATE TRIGGER stored_values_guard_delete BEFORE DELETE ON stored_values FOR EACH ROW EXECUTE FUNCTION stored_values_guard_delete();

-- 投稿 target_seq の本文と乱数を消し、消した本文のハッシュを返す。すでに消えていれば NULL（何度呼んでも同じ結果）。
-- 投稿がない・消してよい条件に合わないときは例外で、何も消さない。表は、migrate を流したときの schema のものを使う
CREATE OR REPLACE FUNCTION erase_withdrawn_body(target_seq bigint) RETURNS text LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  sch text := current_schema();
  h text;
  gone text;
BEGIN
  EXECUTE format('SELECT payload->>''bodyHash'' FROM %I.events WHERE seq = $1 AND type = ''post.published''', sch) INTO h USING target_seq;
  IF h IS NULL THEN
    RAISE EXCEPTION 'seq % is not a post.published', target_seq;
  END IF;
  IF NOT stored_values_erasable(sch, h) THEN
    RAISE EXCEPTION 'the body of seq % may not be erased: write content.withdrawn with bodyErased = true first', target_seq;
  END IF;
  PERFORM set_config('ffr.erase_body', h, true);
  EXECUTE format('DELETE FROM %I.stored_values WHERE hash = $1 AND kind = ''body'' RETURNING hash', sch) INTO gone USING h;
  PERFORM set_config('ffr.erase_body', '', true);
  RETURN gone;
END $$;

REVOKE ALL ON FUNCTION erase_withdrawn_body(bigint) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffr_app') THEN
    REVOKE ALL ON FUNCTION erase_withdrawn_body(bigint) FROM ffr_app;
  END IF;
END $$;
