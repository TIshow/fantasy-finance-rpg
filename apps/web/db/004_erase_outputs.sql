-- 本文を消すとき、その投稿を出した AI の判断の出力（agent.run の outputHash が指す、ログの外の行）に残る同じ文も消す
-- （lead の指示 #29・#157、大枠 #179。docs/EVENT_LOG.md §5.2・§6.1）。何度流しても同じ結果になる（冪等）。003 の関数を差し替える。
--
-- 「同じ判断」：同じ AI（agentId）で、入力の seq の一覧（inputSeqs）が同じ agent.run。毎日の実行（src/runner/day.ts）は、
--   1つの判断から、投稿用と注文用の2つの agent.run を、同じ入力・同じ出力の全文で書く。入力には、その日の口座の根拠の seq が入るので、
--   別の日の判断とは一覧が重ならない。
-- 消す出力（関数 withdrawn_post_outputs が選ぶ）：同じ判断の agent.run の出力の行のうち、次のどれかに当たるもの
--   * 投稿の元になった agent.run（post.published の runSeq）の出力
--   * その出力と全文が同じもの（注文用の agent.run の出力など）
--   * 投稿の本文をそのまま含むもの、または JSON の文字列として書いた形（引用符・改行などを \ で書いたもの）で含むもの
--   中身の形（JSON の項目の名前）には頼らない。同じ判断の中で、同じ文を持たない出力（別の形の注文だけの出力など）は残す。
-- 消してよい出力（関数 stored_values_output_erasable が確かめる。削除の見張りも同じ条件を使う）：次をすべて満たす本文の行（kind = 'body'）
--   * その行を outputHash に持つ agent.run が1件以上あり、すべてが同じ判断（同じ agentId と inputSeqs）
--   * その判断から出た投稿（runSeq がその判断の agent.run を指す post.published）のうち、最後の content.withdrawn
--     （運営者が書いたもの）の bodyErased が真のものが1件以上ある。ほかの投稿が表示されたままでも消す（出力は画面に本文として
--     出さない記録で、消す文が残るほうが問題のため。表示されたままの投稿の本文の行は残る）
--   * ほかの記録が、そのハッシュを指していない（agent.run の outputHash の項目を除き、すべての記録の中身・keys・refs を文字列にして探す。003 と同じ）
--   見張りは、行のハッシュとイベントだけで判定し、ほかの出力の行が先に消えていても結果が変わらない（1つの DELETE で複数行を消しても同じ）
-- イベントの表は変えない。出力のハッシュは agent.run に残るので、ハッシュの連鎖も、保管の検査（再生・照合）も壊れない
-- （再生と照合は、判断の出力の中身を読まない。消えた行は、消えた本文と同じく「引けない」として扱う）。
-- 守りの範囲は 003 と同じ：ffr_app は関数を呼べず、表から削除もできない。持ち主は、設定 ffr.erase_body を自分で入れれば、
-- 消してよい出力を関数を通らずに直接消せる（消せる行の上限は関数と同じか、同じ判断の中で文を持たない出力まで）。
-- 限界：同じ判断の注文票がまだ確定していないうちに消すと、毎日の実行の回し直しは、出力を読めずに止まる（例外になる）。
--   消すのは、その日の注文票の確定のあとにする（手順書 db/ops/erase_body.sql）。

-- 出力 h を消してよいか（上の条件）。表は schema を指定して引く
CREATE OR REPLACE FUNCTION stored_values_output_erasable(sch text, h text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  groups int;
  agent jsonb;
  inputs jsonb;
  posts int;
  erasable int;
  elsewhere boolean;
BEGIN
  EXECUTE format($q$
    SELECT count(DISTINCT jsonb_build_array(r.payload->'agentId', r.payload->'inputSeqs'))::int, (array_agg(r.payload->'agentId'))[1], (array_agg(r.payload->'inputSeqs'))[1]
    FROM %1$I.events r WHERE r.type = 'agent.run' AND r.payload->>'outputHash' = $1$q$, sch) INTO groups, agent, inputs USING h;
  IF groups <> 1 OR agent IS NULL OR inputs IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format($q$
    SELECT count(*)::int,
           count(*) FILTER (WHERE (SELECT w.payload->'bodyErased' FROM %1$I.events w
                                   WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%%' AND w.payload->'targetSeq' = to_jsonb(p.seq)
                                   ORDER BY w.seq DESC LIMIT 1) = 'true'::jsonb)::int
    FROM %1$I.events p
    WHERE p.type = 'post.published'
      AND EXISTS (SELECT 1 FROM %1$I.events r WHERE r.type = 'agent.run' AND to_jsonb(r.seq) = p.payload->'runSeq'
                  AND r.payload->'agentId' = $1 AND r.payload->'inputSeqs' = $2)$q$, sch) INTO posts, erasable USING agent, inputs;
  EXECUTE format($q$
    SELECT EXISTS (SELECT 1 FROM %1$I.events e
                   WHERE ((CASE WHEN e.type = 'agent.run' AND jsonb_typeof(e.payload) = 'object' THEN e.payload - 'outputHash' ELSE e.payload END)::text
                          || e.keys::text || e.refs::text) LIKE '%%' || $1 || '%%')$q$, sch) INTO elsewhere USING h;
  RETURN erasable > 0 AND NOT elsewhere;
END $$;

-- 投稿 target_seq の本文と同じ文を持つ、同じ判断の出力の行のハッシュ（上の「消す出力」）。残っている行だけを返す。
-- 本文の行がもう消えていれば、本文を含むかの判定はできず、元の出力と全文が同じものだけを選ぶ
CREATE OR REPLACE FUNCTION withdrawn_post_outputs(sch text, target_seq bigint) RETURNS SETOF text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  RETURN QUERY EXECUTE format($q$
    WITH src AS (
      SELECT r.payload->'agentId' AS agent, r.payload->'inputSeqs' AS inputs, r.payload->>'outputHash' AS out_hash,
             (SELECT v.content #>> '{}' FROM %1$I.stored_values v WHERE v.hash = r.payload->>'outputHash' AND v.kind = 'body') AS out_text,
             (SELECT b.content #>> '{}' FROM %1$I.stored_values b WHERE b.hash = p.payload->>'bodyHash' AND b.kind = 'body') AS body
      FROM %1$I.events p JOIN %1$I.events r ON r.type = 'agent.run' AND to_jsonb(r.seq) = p.payload->'runSeq'
      WHERE p.seq = $1 AND p.type = 'post.published' AND jsonb_typeof(r.payload->'outputHash') = 'string'
    )
    SELECT DISTINCT v.hash
    FROM src
    JOIN %1$I.events r ON r.type = 'agent.run' AND r.payload->'agentId' = src.agent AND r.payload->'inputSeqs' = src.inputs
    JOIN %1$I.stored_values v ON v.hash = r.payload->>'outputHash' AND v.kind = 'body'
    WHERE v.hash = src.out_hash
       OR v.content #>> '{}' = src.out_text
       OR (length(src.body) > 0 AND (strpos(v.content #>> '{}', src.body) > 0
                                     OR strpos(v.content #>> '{}', substr(to_jsonb(src.body)::text, 2, length(to_jsonb(src.body)::text) - 2)) > 0))
    ORDER BY v.hash$q$, sch) USING target_seq;
END $$;

-- 削除の見張りを差し替える：消す行のハッシュがこのトランザクションだけの設定（ffr.erase_body）に入っていて、
-- 消してよい本文（003）か、消してよい出力（上）のときだけ通す
CREATE OR REPLACE FUNCTION stored_values_guard_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  ok boolean := false;
BEGIN
  IF current_setting('ffr.erase_body', true) IS NOT DISTINCT FROM OLD.hash AND OLD.kind = 'body' THEN
    EXECUTE format('SELECT %1$I.stored_values_erasable($1, $2) OR %1$I.stored_values_output_erasable($1, $2)', TG_TABLE_SCHEMA) INTO ok USING TG_TABLE_SCHEMA, OLD.hash;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'stored_values is append-only (DELETE is not allowed except a withdrawn body through erase_withdrawn_body)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;

-- 投稿 target_seq の判断の出力のうち、本文と同じ文を持つ行を消し、消した行のハッシュを返す（なければ何も返さない。何度呼んでも同じ結果）。
-- 消す行のどれかが消してよい条件に合わなければ例外で、何も消さない。ふつうは erase_withdrawn_body が呼ぶ。
-- 003 の版で本文だけを消した投稿は、この関数か erase_withdrawn_body をもう一度呼べば、出力も消える
CREATE OR REPLACE FUNCTION erase_withdrawn_outputs(target_seq bigint) RETURNS SETOF text LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  sch text := current_schema();
  targets text[];
  withdrawn boolean;
  h text;
  gone text;
BEGIN
  EXECUTE format('SELECT 1 FROM %I.events WHERE seq = $1 AND type = ''post.published''', sch) INTO gone USING target_seq;
  IF gone IS NULL THEN
    RAISE EXCEPTION 'seq % is not a post.published', target_seq;
  END IF;
  SELECT coalesce(array_agg(o), '{}') INTO targets FROM withdrawn_post_outputs(sch, target_seq) AS o;
  IF cardinality(targets) = 0 THEN
    RETURN;
  END IF;
  -- 消すのは、この投稿自身が本文を消す印つきで取り下げられているときだけ（同じ判断のほかの投稿の取り下げでは消さない）
  EXECUTE format($q$SELECT (SELECT w.payload->'bodyErased' FROM %I.events w
                            WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%%' AND w.payload->'targetSeq' = to_jsonb($1::bigint)
                            ORDER BY w.seq DESC LIMIT 1) = 'true'::jsonb$q$, sch) INTO withdrawn USING target_seq;
  IF withdrawn IS NOT TRUE THEN
    RAISE EXCEPTION 'the outputs of the run behind seq % may not be erased: the post needs content.withdrawn with bodyErased = true', target_seq;
  END IF;
  FOREACH h IN ARRAY targets LOOP
    IF NOT stored_values_output_erasable(sch, h) THEN
      RAISE EXCEPTION 'the outputs of the run behind seq % may not be erased: each output must be pointed to only by agent.run of one decision, and by no other record', target_seq;
    END IF;
  END LOOP;
  FOREACH h IN ARRAY targets LOOP
    PERFORM set_config('ffr.erase_body', h, true);
    EXECUTE format('DELETE FROM %I.stored_values WHERE hash = $1 AND kind = ''body'' RETURNING hash', sch) INTO gone USING h;
    RETURN NEXT gone;
  END LOOP;
  PERFORM set_config('ffr.erase_body', '', true);
END $$;

-- 投稿 target_seq の本文と乱数を消し、同じ判断の出力に残る同じ文（上）も消す。返すのは、消した本文のハッシュ（003 と同じ）。
-- 本文の行がなければ（消し済み・値の行を指す・もともとない）NULL を返す。そのときも、残っている出力があれば消す。
-- 投稿がない・本文か出力が消してよい条件に合わないときは例外で、何も消さない
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
  EXECUTE format('SELECT hash FROM %I.stored_values WHERE hash = $1 AND kind = ''body''', sch) INTO gone USING h;
  IF gone IS NOT NULL AND NOT stored_values_erasable(sch, h) THEN
    RAISE EXCEPTION 'the body of seq % may not be erased: every post with this body needs content.withdrawn with bodyErased = true, and no other record may point to it', target_seq;
  END IF;
  -- 出力を先に消す（出力を選ぶのに、本文の文を使うため）
  PERFORM erase_withdrawn_outputs(target_seq);
  IF gone IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('ffr.erase_body', h, true);
  EXECUTE format('DELETE FROM %I.stored_values WHERE hash = $1 AND kind = ''body'' RETURNING hash', sch) INTO gone USING h;
  PERFORM set_config('ffr.erase_body', '', true);
  RETURN gone;
END $$;

REVOKE ALL ON FUNCTION erase_withdrawn_body(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION erase_withdrawn_outputs(bigint) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffr_app') THEN
    REVOKE ALL ON FUNCTION erase_withdrawn_body(bigint) FROM ffr_app;
    REVOKE ALL ON FUNCTION erase_withdrawn_outputs(bigint) FROM ffr_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ffr_reader') THEN
    REVOKE ALL ON FUNCTION erase_withdrawn_body(bigint) FROM ffr_reader;
    REVOKE ALL ON FUNCTION erase_withdrawn_outputs(bigint) FROM ffr_reader;
  END IF;
END $$;
