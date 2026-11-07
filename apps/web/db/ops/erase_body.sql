-- 非表示にした投稿の本文を消す（権利・法的な理由のとき。docs/EVENT_LOG.md §5.2・§6.1。仕組みは db/003_erase_body.sql）。
-- 運営者が、表の持ち主の接続（DATABASE_ADMIN_URL）で流す。アプリの接続（ffr_app）からは呼べない。
-- 消すのは、ログの外に置いた本文と乱数だけ。イベント（投稿の記録と本文のハッシュ）は残り、ハッシュの連鎖は壊れない。
-- 画面には「非表示（理由）」が同じ位置に残る。消した本文は元に戻せない。
--
-- 本文は、003 の決まり（同じ本文の投稿すべてが本文を消す印つきで取り下げられ、ほかの記録が本文のハッシュを指していない）に合えば、必ず消える。
-- AI の判断の出力（agent.run の出力。投稿用と注文用の2行）のうち、本文を JSON の文字列の値として丸ごと含むもの（または全体が本文と同じもの）は、
-- 次の確かめがすべて通るときだけ、同じ関数が一緒に消す（db/004_erase_outputs.sql。#179）。出力の行も、ログの外の本文と乱数で、ハッシュは agent.run に残る。
-- 確かめに当たれば、出力は残し、本文だけを消す（#179 の lead の判断 6）。名前は 1つ目の文の outputs_kept_because と、2つ目の文の problem に出る。
-- 意味は 004 の先頭のコメント：
--   run_has_many_posts（投稿の元の run を、別の本文の投稿も指している）、output_missing・output_without_body（元の run の出力がない・本文を含まない）、
--   decision_unclear（同じ判断の run の数が合わない）、sheet_not_settled（その日の注文票がまだ確定していない）、
--   post_after_order（投稿か元の run が、その日の注文用の run より後に書かれている。あとから足した記録の印）、
--   not_daily_run（投稿用の run・投稿・注文用の run が、毎日の実行の書き方どおりに続いていない。足した記録の印）、
--   text_outside_decision（同じ AI の別の判断の出力にも同じ文がある）、output_not_erasable（出力のハッシュをほかの記録も指している など）
-- 本文を消したあとは、出力が本文を含むかを確かめられないので、関数は出力を消さない。元の run の出力が残っていれば、2つ目の文に
-- output_unverifiable として出続ける（確かめに当たって出力を残した投稿や、003 の版で本文だけを消した投稿）。
--
-- 手順
--   1. 先に、その投稿の content.withdrawn を、bodyErased = true で記録しておく（運営者の記録。これがない本文は消せない）。
--      その日の注文票の確定（毎日の実行の判断の段）が済んでから消す（済む前に消すと、出力は sheet_not_settled で残る）。
--   2. 1つ目の文で、消してよい本文が残っている投稿を、最後の非表示の記録（seq・時刻・書き手・理由）と、一緒に消える判断の出力の
--      件数（outputs_to_erase）と先頭の部分（outputs_preview。1件80文字まで）と、出力を残す理由（outputs_kept_because）と一緒に出す。
--      非表示の記録が自分の書いたものか（アプリの接続でも、運営者を名乗る行を直接入れられるため）と、消える出力がその投稿の判断のもので、
--      本文と同じ文を含んでいるかを、目で確かめる。ふつうは2件（投稿用と注文用で、中身は同じ）で、outputs_kept_because は空
--   3. 3つ目の文の <seq> を、消す投稿の seq（post.published の通し番号）に置き換えて流す。消した本文のハッシュが返る
--      （確かめが通れば、同じ判断の出力も一緒に消える。本文が条件に合わなければ例外になり、何も消えない。NULL は消す本文の行がないとき。
--      消し済みのほか、値の行を指す投稿や、本文の行がもともとない投稿でも NULL になるので、2つ目の文の missing・output_unverifiable で確かめる）
--   4. 2つ目の文で、食い違いがないことを確かめる（何も出なければよい）。アプリの接続で daily verify を流し、照合が通ることを確かめる
--   5. 動いているアプリのプロセス（画面・毎日の実行）は、再起動するまで、消した本文をメモリに持っている。必要なら再起動する
--   2つ目の文に not_erased のほか、上の確かめの名前・output_unverifiable が出続けるときは、lead に知らせる
--   （判断の出力に同じ文が残っている。偽の投稿で、本物の判断の出力などを消そうとした跡の可能性もある）。
--
-- 非表示の理由（reason）などの文に、ハッシュを書かない。ほかの記録がハッシュを指していると見なされ、その本文を消せなくなる。
--
-- 守りの範囲：条件に合わない本文・値は、持ち主でも消せない。条件に合う本文は、持ち主なら関数を通らずに直接でも消せる（持ち主は守りの対象外）。

-- 1つ目：消してよいのに本文がまだ残っている投稿と、その最後の非表示の記録と、一緒に消える判断の出力（と、出力を残す理由）
-- （最後の記録が bodyErased 真で、本文が残っている候補に絞ってから、消してよいかの判定（記録を全部読む）を呼ぶ）
WITH latest AS (
  SELECT DISTINCT ON (w.payload->'targetSeq') w.payload->'targetSeq' AS target, w.seq AS withdrawn_seq, to_timestamp(w.recorded_at / 1000.0) AS withdrawn_at, w.actor, w.payload->>'reason' AS reason, w.payload->'bodyErased' = 'true'::jsonb AS body_erased
  FROM events w WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%'
  ORDER BY w.payload->'targetSeq', w.seq DESC
), candidates AS MATERIALIZED (
  SELECT p.seq, p.payload->>'bodyHash' AS body_hash, l.withdrawn_seq, l.withdrawn_at, l.actor, l.reason
  FROM events p
  JOIN latest l ON l.target = to_jsonb(p.seq) AND l.body_erased
  JOIN stored_values v ON v.hash = p.payload->>'bodyHash' AND v.kind = 'body'
  WHERE p.type = 'post.published'
), erasable AS MATERIALIZED (
  SELECT c.*, withdrawn_post_skip(current_schema(), c.seq) AS kept_because FROM candidates c WHERE stored_values_erasable(current_schema(), c.body_hash)
), listed AS MATERIALIZED (
  SELECT e.*, CASE WHEN e.kept_because IS NULL THEN ARRAY(SELECT withdrawn_post_outputs(current_schema(), e.seq)) ELSE '{}'::text[] END AS outputs FROM erasable e
)
SELECT seq, body_hash, withdrawn_seq, withdrawn_at, actor, reason, cardinality(outputs) AS outputs_to_erase,
       ARRAY(SELECT left(v.content #>> '{}', 80) FROM unnest(outputs) o JOIN stored_values v ON v.hash = o AND v.kind = 'body' ORDER BY o) AS outputs_preview,
       kept_because AS outputs_kept_because
FROM listed
ORDER BY seq;

-- 2つ目：食い違い。最後の記録が bodyErased 真なのに本文が残っている投稿（not_erased）、同じく判断の出力に同じ文が残っている投稿
-- （output_not_erased）、本文がないのに最後の記録が真でない投稿（missing）、最後の記録が bodyErased 真で、出力を残す理由がある投稿
-- （上の確かめの名前）か、本文がないのに元の run の出力が残っている投稿（output_unverifiable）
WITH latest AS (
  SELECT DISTINCT ON (w.payload->'targetSeq') w.payload->'targetSeq' AS target, w.payload->'bodyErased' = 'true'::jsonb AS body_erased
  FROM events w WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%'
  ORDER BY w.payload->'targetSeq', w.seq DESC
), erased AS MATERIALIZED (
  SELECT p.seq, p.payload->>'bodyHash' AS body_hash, withdrawn_post_skip(current_schema(), p.seq) AS problem,
         EXISTS (SELECT 1 FROM withdrawn_post_outputs(current_schema(), p.seq)) AS outputs_left
  FROM events p
  JOIN latest l ON l.target = to_jsonb(p.seq) AND l.body_erased
  WHERE p.type = 'post.published'
)
SELECT p.seq, p.payload->>'bodyHash' AS body_hash, CASE WHEN v.hash IS NULL THEN 'missing' ELSE 'not_erased' END AS problem
FROM events p
LEFT JOIN latest l ON l.target = to_jsonb(p.seq)
LEFT JOIN stored_values v ON v.hash = p.payload->>'bodyHash' AND v.kind = 'body'
WHERE p.type = 'post.published' AND ((l.body_erased AND v.hash IS NOT NULL) OR (l.body_erased IS NOT TRUE AND v.hash IS NULL))
UNION ALL
SELECT seq, body_hash, 'output_not_erased' AS problem FROM erased WHERE outputs_left
UNION ALL
SELECT seq, body_hash, problem FROM erased WHERE problem IS NOT NULL
ORDER BY seq, problem;

-- 3つ目：本文を消す
SELECT erase_withdrawn_body(<seq>);
