-- 本文を消すとき、その投稿を出した AI の判断の出力（agent.run の outputHash が指す、ログの外の行）に残る同じ文も消す
-- （lead の指示 #29・#157、大枠 #179。docs/EVENT_LOG.md §5.2・§6.1）。何度流しても同じ結果になる（冪等）。003 の関数を差し替える。
--
-- 言葉
--   元の run：投稿の runSeq が指す agent.run。種類が post で、投稿と同じ AI のものだけを数える（そうでなければ元の run はないとし、出力は消さない）
--   同じ判断：同じ AI（agentId）で、入力の seq の一覧（inputSeqs）が同じ agent.run。毎日の実行（src/runner/day.ts）は、1つの判断から、
--     投稿用と注文用の2つの agent.run を、同じ入力・同じ出力の全文で書く。入力には、その日の口座の根拠の seq が入るので、別の日の判断とは一覧が違う
--   本文を持つ：出力の全体が本文と同じか、本文を JSON の文字列の値として丸ごと含む（引用符を含めた to_jsonb(本文)::text を含む）。
--     本文の一部だけ・引用符のない形では数えない
--
-- 消す出力（withdrawn_post_outputs）：同じ判断の出力の行のうち、本文を持つもの。本文の行が残っているときだけ選ぶ
-- 消す前の確かめ（withdrawn_post_problem。どれかに当たれば、関数は何も消さずに例外にする。手順書の2つ目の文にも、その名前で出る）
--   run_has_many_posts   ：元の run を指す投稿が2件以上ある（アプリの接続で偽の投稿を足し、本物の判断の出力を消させようとした跡の可能性がある）。
--                          本文の項目が同じ写しの投稿は数えない（写しがあると、写しをすべて本文を消す印つきで取り下げるまで本文を消せない。003 の決まり）
--   output_missing       ：元の run の出力の行がもうない（本文を持つかを確かめられない）
--   output_without_body  ：元の run の出力が本文を持たない（偽の投稿の可能性がある）
--   decision_unclear     ：同じ判断に、投稿用の run が元の run のほかにある、または注文用の run が2つ以上ある（「同じ判断」の前提が外れている。
--                          入力の一覧が日をまたいで同じなど）
--   sheet_not_settled    ：同じ判断に注文用の run がない、またはその注文票の確定・拒否の記録がない（確定の前に消すと、毎日の実行が出力を読めずに止まる）
--   text_outside_decision：同じ AI の、同じ判断の外の出力が本文を持つ（入力の一覧が違うなどで、判断の外に同じ文が残る）
-- 確かめられない状態（例外にはしない。手順書の2つ目の文に出る）
--   output_unverifiable  ：本文の行がもうないのに、同じ判断の出力の行が残っている。本文がないので、残りが本文を持つかを確かめられない
--                          （003 の版で本文だけを消した投稿、持ち主が直接消した場合、本文を持たない出力を残した場合）。関数は何も消さない
--
-- 消してよい出力（stored_values_output_erasable。削除の見張りが使う）：次をすべて満たす本文の行（kind = 'body'）
--   * その行を outputHash に持つ agent.run が1件以上あり、すべてが同じ判断
--   * その判断から出た投稿のうち、最後の content.withdrawn（運営者が書いたもの）の bodyErased が真で、上の確かめに当たらず、
--     その行が「消す出力」に入るものがある
--   * ほかの記録が、そのハッシュを指していない（agent.run の outputHash の項目を除き、すべての記録の中身・keys・refs を文字列にして探す。003 と同じ）
--   見張りは関数と同じ範囲だけを通す。関数は、元の run の出力を最後に消す（それまでは、元の run の出力が本文を持つことを毎行確かめられる）
-- イベントの表は変えない。出力のハッシュは agent.run に残るので、ハッシュの連鎖も、保管の検査（再生・照合）も壊れない
-- （再生と照合は、判断の出力の中身を読まない。消えた行は、消えた本文と同じく「引けない」として扱う）。
-- 守りの範囲は 003 と同じ：ffr_app・ffr_reader は関数を呼べず、表から削除もできない。持ち主は、設定 ffr.erase_body を自分で入れれば、
-- 消してよい出力を関数を通らずに直接消せる（消せる行は関数と同じ。ただし元の run の出力を先に消すと、残りは消せなくなる）。

-- 出力 o が本文 b を持つか（上の言葉）
CREATE OR REPLACE FUNCTION output_has_body(o text, b text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(o = b OR (length(b) > 0 AND strpos(o, to_jsonb(b)::text) > 0), false)
$$;

-- 投稿 target_seq の元の run と、その出力・本文。元の run がなければ run_seq は NULL。行がもうない出力・本文は NULL
CREATE OR REPLACE FUNCTION withdrawn_post_source(sch text, target_seq bigint, OUT run_seq bigint, OUT agent jsonb, OUT inputs jsonb, OUT out_hash text, OUT out_text text, OUT body text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  EXECUTE format($q$
    SELECT r.seq, r.payload->'agentId', r.payload->'inputSeqs', r.payload->>'outputHash',
           (SELECT v.content #>> '{}' FROM %1$I.stored_values v WHERE v.hash = r.payload->>'outputHash' AND v.kind = 'body'),
           (SELECT b.content #>> '{}' FROM %1$I.stored_values b WHERE b.hash = p.payload->>'bodyHash' AND b.kind = 'body')
    FROM %1$I.events p JOIN %1$I.events r ON r.type = 'agent.run' AND to_jsonb(r.seq) = p.payload->'runSeq'
    WHERE p.seq = $1 AND p.type = 'post.published' AND jsonb_typeof(p.payload) = 'object' AND jsonb_typeof(r.payload) = 'object'
      AND r.payload->>'purpose' = 'post' AND r.payload->'agentId' = p.payload->'agentId'
      AND jsonb_typeof(r.payload->'outputHash') = 'string' AND r.payload ? 'inputSeqs'$q$, sch)
    INTO run_seq, agent, inputs, out_hash, out_text, body USING target_seq;
END $$;

-- 投稿 target_seq の出力を消す前の確かめ（上の名前）。当たらなければ NULL
CREATE OR REPLACE FUNCTION withdrawn_post_problem(sch text, target_seq bigint) RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  s record;
  n int;
  post_runs int;
  order_runs int;
  settled boolean;
BEGIN
  EXECUTE format('SELECT * FROM %I.withdrawn_post_source($1, $2)', sch) INTO s USING sch, target_seq;
  IF s.run_seq IS NULL THEN
    RETURN NULL;
  END IF;
  IF s.body IS NULL THEN
    EXECUTE format($q$
      SELECT count(*)::int FROM %1$I.events r JOIN %1$I.stored_values v ON v.hash = r.payload->>'outputHash' AND v.kind = 'body'
      WHERE r.type = 'agent.run' AND r.payload->'agentId' = $1 AND r.payload->'inputSeqs' = $2$q$, sch) INTO n USING s.agent, s.inputs;
    RETURN CASE WHEN n > 0 THEN 'output_unverifiable' END;
  END IF;
  -- 本文の項目が同じ写しの投稿は数えない（本文は、写しがすべて本文を消す印つきで取り下げられるまで消せない。003 の決まり）
  EXECUTE format($q$
    SELECT count(*)::int FROM %1$I.events p
    WHERE p.type = 'post.published' AND p.payload->'runSeq' = to_jsonb($1::bigint)
      AND p.payload->'bodyHash' IS DISTINCT FROM (SELECT t.payload->'bodyHash' FROM %1$I.events t WHERE t.seq = $2)$q$, sch) INTO n USING s.run_seq, target_seq;
  IF n > 0 THEN
    RETURN 'run_has_many_posts';
  END IF;
  IF s.out_text IS NULL THEN
    RETURN 'output_missing';
  END IF;
  EXECUTE format('SELECT %I.output_has_body($1, $2)', sch) INTO settled USING s.out_text, s.body;
  IF NOT settled THEN
    RETURN 'output_without_body';
  END IF;
  EXECUTE format($q$
    SELECT count(*) FILTER (WHERE r.payload->>'purpose' = 'post')::int, count(*) FILTER (WHERE r.payload->>'purpose' = 'order')::int,
           bool_or(r.payload->>'purpose' = 'order' AND EXISTS (SELECT 1 FROM %1$I.events o WHERE o.type IN ('order_sheet.committed', 'order_sheet.rejected') AND o.payload->'runSeq' = to_jsonb(r.seq)))
    FROM %1$I.events r WHERE r.type = 'agent.run' AND r.payload->'agentId' = $1 AND r.payload->'inputSeqs' = $2$q$, sch) INTO post_runs, order_runs, settled USING s.agent, s.inputs;
  IF post_runs <> 1 OR order_runs > 1 THEN
    RETURN 'decision_unclear';
  END IF;
  IF order_runs = 0 OR settled IS NOT TRUE THEN
    RETURN 'sheet_not_settled';
  END IF;
  EXECUTE format($q$
    SELECT EXISTS (SELECT 1 FROM %1$I.events r JOIN %1$I.stored_values v ON v.hash = r.payload->>'outputHash' AND v.kind = 'body'
                   WHERE r.type = 'agent.run' AND r.payload->'agentId' = $1 AND r.payload->'inputSeqs' IS DISTINCT FROM $2
                     AND %1$I.output_has_body(v.content #>> '{}', $3))$q$, sch) INTO settled USING s.agent, s.inputs, s.body;
  IF settled THEN
    RETURN 'text_outside_decision';
  END IF;
  RETURN NULL;
END $$;

-- 投稿 target_seq の本文を持つ、同じ判断の出力の行のハッシュ（上の「消す出力」）。残っている行だけ。本文の行がなければ何も返さない
CREATE OR REPLACE FUNCTION withdrawn_post_outputs(sch text, target_seq bigint) RETURNS SETOF text LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  s record;
BEGIN
  EXECUTE format('SELECT * FROM %I.withdrawn_post_source($1, $2)', sch) INTO s USING sch, target_seq;
  IF s.run_seq IS NULL OR s.body IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE format($q$
    SELECT DISTINCT v.hash
    FROM %1$I.events r JOIN %1$I.stored_values v ON v.hash = r.payload->>'outputHash' AND v.kind = 'body'
    WHERE r.type = 'agent.run' AND r.payload->'agentId' = $1 AND r.payload->'inputSeqs' = $2 AND %1$I.output_has_body(v.content #>> '{}', $3)
    ORDER BY v.hash$q$, sch) USING s.agent, s.inputs, s.body;
END $$;

-- 出力 h を消してよいか（上の条件）。表は schema を指定して引く
CREATE OR REPLACE FUNCTION stored_values_output_erasable(sch text, h text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  groups int;
  agent jsonb;
  inputs jsonb;
  ok boolean;
  elsewhere boolean;
BEGIN
  EXECUTE format($q$
    SELECT count(DISTINCT jsonb_build_array(r.payload->'agentId', r.payload->'inputSeqs'))::int, (array_agg(r.payload->'agentId'))[1], (array_agg(r.payload->'inputSeqs'))[1]
    FROM %1$I.events r WHERE r.type = 'agent.run' AND r.payload->>'outputHash' = $1$q$, sch) INTO groups, agent, inputs USING h;
  IF groups <> 1 OR agent IS NULL OR inputs IS NULL THEN
    RETURN false;
  END IF;
  -- その判断から出た投稿のうち、本文を消す印つきで取り下げられ、確かめに当たらず、h を「消す出力」に含むものがあるか
  EXECUTE format($q$
    SELECT EXISTS (
      SELECT 1 FROM %1$I.events p
      WHERE p.type = 'post.published'
        AND EXISTS (SELECT 1 FROM %1$I.events r WHERE r.type = 'agent.run' AND to_jsonb(r.seq) = p.payload->'runSeq'
                    AND r.payload->'agentId' = $1 AND r.payload->'inputSeqs' = $2)
        AND (SELECT w.payload->'bodyErased' FROM %1$I.events w
             WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%%' AND w.payload->'targetSeq' = to_jsonb(p.seq)
             ORDER BY w.seq DESC LIMIT 1) = 'true'::jsonb
        AND %1$I.withdrawn_post_problem($4, p.seq) IS NULL
        AND $3 IN (SELECT %1$I.withdrawn_post_outputs($4, p.seq)))$q$, sch) INTO ok USING agent, inputs, h, sch;
  IF ok IS NOT TRUE THEN
    RETURN false;
  END IF;
  EXECUTE format($q$
    SELECT EXISTS (SELECT 1 FROM %1$I.events e
                   WHERE ((CASE WHEN e.type = 'agent.run' AND jsonb_typeof(e.payload) = 'object' THEN e.payload - 'outputHash' ELSE e.payload END)::text
                          || e.keys::text || e.refs::text) LIKE '%%' || $1 || '%%')$q$, sch) INTO elsewhere USING h;
  RETURN NOT elsewhere;
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

-- 投稿 target_seq の判断の出力のうち、本文を持つ行を消し、消した行のハッシュを返す（なければ何も返さない。何度呼んでも同じ結果）。
-- 投稿が本文を消す印つきで取り下げられていない・消す前の確かめに当たる・消す行のどれかが消してよい条件に合わないときは例外で、何も消さない。
-- 本文の行がもうなければ、何も消さない（output_unverifiable は手順書の2つ目の文に出る）。ふつうは erase_withdrawn_body が呼ぶ
CREATE OR REPLACE FUNCTION erase_withdrawn_outputs(target_seq bigint) RETURNS SETOF text LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  sch text := current_schema();
  targets text[];
  source text;
  withdrawn boolean;
  problem text;
  h text;
  gone text;
BEGIN
  EXECUTE format('SELECT 1 FROM %I.events WHERE seq = $1 AND type = ''post.published''', sch) INTO gone USING target_seq;
  IF gone IS NULL THEN
    RAISE EXCEPTION 'seq % is not a post.published', target_seq;
  END IF;
  SELECT coalesce(array_agg(o), '{}') INTO targets FROM withdrawn_post_outputs(sch, target_seq) AS o;
  -- 消すのは、この投稿自身が本文を消す印つきで取り下げられているときだけ（同じ判断のほかの投稿の取り下げでは消さない）
  EXECUTE format($q$SELECT (SELECT w.payload->'bodyErased' FROM %I.events w
                            WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%%' AND w.payload->'targetSeq' = to_jsonb($1::bigint)
                            ORDER BY w.seq DESC LIMIT 1) = 'true'::jsonb$q$, sch) INTO withdrawn USING target_seq;
  IF withdrawn IS NOT TRUE THEN
    IF cardinality(targets) > 0 THEN
      RAISE EXCEPTION 'the outputs of the run behind seq % may not be erased: the post needs content.withdrawn with bodyErased = true', target_seq;
    END IF;
    RETURN;
  END IF;
  problem := withdrawn_post_problem(sch, target_seq);
  IF problem IS NOT NULL AND problem <> 'output_unverifiable' THEN
    RAISE EXCEPTION 'the outputs of the run behind seq % may not be erased: %', target_seq, problem;
  END IF;
  IF cardinality(targets) = 0 THEN
    RETURN;
  END IF;
  FOREACH h IN ARRAY targets LOOP
    IF NOT stored_values_output_erasable(sch, h) THEN
      RAISE EXCEPTION 'the outputs of the run behind seq % may not be erased: each output must be pointed to only by agent.run of one decision, and by no other record', target_seq;
    END IF;
  END LOOP;
  -- 元の run の出力は最後に消す（見張りが、ほかの行を消すときに、元の run の出力が本文を持つことを確かめられるように）
  SELECT out_hash INTO source FROM withdrawn_post_source(sch, target_seq);
  FOREACH h IN ARRAY array_remove(targets, source) || (CASE WHEN source = ANY(targets) THEN ARRAY[source] ELSE '{}'::text[] END) LOOP
    PERFORM set_config('ffr.erase_body', h, true);
    EXECUTE format('DELETE FROM %I.stored_values WHERE hash = $1 AND kind = ''body'' RETURNING hash', sch) INTO gone USING h;
    RETURN NEXT gone;
  END LOOP;
  PERFORM set_config('ffr.erase_body', '', true);
END $$;

-- 投稿 target_seq の本文と乱数を消し、同じ判断の出力に残る同じ文（上）も消す。返すのは、消した本文のハッシュ（003 と同じ）。
-- 本文の行がなければ（消し済み・値の行を指す・もともとない）NULL を返し、何も消さない。
-- 投稿がない・本文か出力が消してよい条件に合わない・消す前の確かめに当たるときは例外で、何も消さない
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
  IF gone IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT stored_values_erasable(sch, h) THEN
    RAISE EXCEPTION 'the body of seq % may not be erased: every post with this body needs content.withdrawn with bodyErased = true, and no other record may point to it', target_seq;
  END IF;
  -- 出力を先に消す（出力を選ぶのに、本文の文を使うため）
  PERFORM erase_withdrawn_outputs(target_seq);
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
