-- 非表示にした投稿の本文を消す手続き（docs/EVENT_LOG.md §5.2・§6.1。lead の指示 #25 PR-3）。何度流しても同じ結果になる（冪等）。
-- 消せるのは、stored_values の本文（kind = 'body'）のうち、次をすべて満たすものだけ。乱数（salt）は同じ行にあるので一緒に消える。
--   * その本文を bodyHash に持つ post.published があり、それらすべてについて、最後の content.withdrawn（運営者が書いたもの）の bodyErased が真
--   * ほかの記録が、そのハッシュを指していない（投稿の中身の bodyHash の項目を除き、すべての記録の中身・keys・refs を文字列にして、
--     どこにも出てこない。入れ子や接頭辞つきの書き方でも見つかる。中身がオブジェクトでない行も、そのまま文字列にして探す）。
--     例：agent.run の outputHash（判断の出力）、source.captured の contentHash、prices・企業行動の valuesHash、訂正の新しい本文。
--     中身の項目の名前ではなく文字列で探すので、ハッシュでログの外を指す項目が増えても、消してはいけない行を消さない側に倒れる
-- イベントの表は変えない。本文のハッシュはイベントに残るので、ハッシュの連鎖は壊れない。
-- 運営者は erase_withdrawn_body(投稿の seq) を、表の持ち主の接続から呼ぶ。ffr_app は、この関数を実行する権限も、
-- stored_values を削除する権限も持たない。上の条件に合わない行は、持ち主でもトリガが断る（誰も消せない）。
-- 守りの範囲：持ち主は守りの対象外。持ち主は、設定 ffr.erase_body を自分で入れれば、条件に合う本文を関数を通らずに直接消せる
-- （消せる行は関数と同じ）。トリガを外すこともできる。関数だけに絞るには、専用の役割と SECURITY DEFINER が要る（この版では作らない）。
-- 運営者の手順は db/ops/erase_body.sql。

-- 本文 h を消してよいか（上の条件）。表は schema を指定して引く（呼ぶ側の search_path に左右されない）
CREATE OR REPLACE FUNCTION stored_values_erasable(sch text, h text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  posts int;
  erasable int;
  elsewhere boolean;
BEGIN
  EXECUTE format($q$
    SELECT count(*)::int,
           count(*) FILTER (WHERE (SELECT w.payload->'bodyErased' FROM %1$I.events w
                                   WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%%' AND w.payload->'targetSeq' = to_jsonb(p.seq)
                                   ORDER BY w.seq DESC LIMIT 1) = 'true'::jsonb)::int
    FROM %1$I.events p WHERE p.type = 'post.published' AND p.payload->>'bodyHash' = $1$q$, sch) INTO posts, erasable USING h;
  -- 行の h は 64 文字の16進（stored_values の制約）。投稿の中身から来た h に % などが混じっても、当たりが増えて断る側に倒れる
  EXECUTE format($q$
    SELECT EXISTS (SELECT 1 FROM %1$I.events e
                   WHERE ((CASE WHEN e.type = 'post.published' AND jsonb_typeof(e.payload) = 'object' THEN e.payload - 'bodyHash' ELSE e.payload END)::text
                          || e.keys::text || e.refs::text) LIKE '%%' || $1 || '%%')$q$, sch) INTO elsewhere USING h;
  RETURN posts > 0 AND posts = erasable AND NOT elsewhere;
END $$;

-- stored_values の削除の見張り。消す本文のハッシュがこのトランザクションだけの設定（ffr.erase_body）に入っていて、条件に合う本文のときだけ通す。
-- 設定は erase_withdrawn_body が入れる。うっかりした DELETE を止めるための印で、持ち主が自分で入れることは防げない
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

-- 投稿 target_seq の本文と乱数を消し、消した本文のハッシュを返す。消す本文の行がなければ NULL（何度呼んでも同じ結果）。
-- NULL は「消し済み」のほか、値の行を指す投稿や、本文の行がもともとない投稿でも返る。手順書の2つ目の文の missing で確かめる。
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
  -- 消す本文の行がなければ（消し済み・値の行を指している）、何もしない
  EXECUTE format('SELECT hash FROM %I.stored_values WHERE hash = $1 AND kind = ''body''', sch) INTO gone USING h;
  IF gone IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT stored_values_erasable(sch, h) THEN
    RAISE EXCEPTION 'the body of seq % may not be erased: every post with this body needs content.withdrawn with bodyErased = true, and no other record may point to it', target_seq;
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
