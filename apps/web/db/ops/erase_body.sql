-- 非表示にした投稿の本文を消す（権利・法的な理由のとき。docs/EVENT_LOG.md §5.2・§6.1。仕組みは db/003_erase_body.sql）。
-- 運営者が、表の持ち主の接続（DATABASE_ADMIN_URL）で流す。アプリの接続（ffr_app）からは呼べない。
-- 消すのは、ログの外に置いた本文と乱数だけ。イベント（投稿の記録と本文のハッシュ）は残り、ハッシュの連鎖は壊れない。
-- 画面には「非表示（理由）」が同じ位置に残る。消した本文は元に戻せない。
--
-- 【注意】AI の判断の出力（agent.run の出力。投稿用と注文用の2行）には、同じ文が残る。これを消すかは lead の判断待ち（#25）。
--         この手順で消えるのは、投稿の本文の行だけ。
--
-- 手順
--   1. 先に、その投稿の content.withdrawn を、bodyErased = true で記録しておく（運営者の記録。これがない本文は消せない）。
--      投稿の本文の項目のほかに同じハッシュを指す記録（判断の出力・訂正など）があれば、消せない。そのときは 2つ目の文に not_erased として
--      出続けるので、lead に知らせる（偽の投稿で、判断の出力などを消そうとした跡の可能性がある）
--   2. 1つ目の文で、消してよい本文がまだ残っている投稿を、最後の非表示の記録（seq・時刻・書き手・理由）と一緒に出す。
--      その記録が自分の書いたものかを目で確かめる（アプリの接続でも、運営者を名乗る行を直接入れられるため）
--   3. 3つ目の文の <seq> を、消す投稿の seq（post.published の通し番号）に置き換えて流す。消した本文のハッシュが返る
--      （条件に合わなければ例外になり、何も消えない。NULL は消す本文の行がないとき。消し済みのほか、値の行を指す投稿や、
--      本文の行がもともとない投稿でも NULL になるので、2つ目の文の missing で確かめる）
--   4. 2つ目の文で、食い違いがないことを確かめる（何も出なければよい）。アプリの接続で daily verify を流し、照合が通ることを確かめる
--   5. 動いているアプリのプロセス（画面・毎日の実行）は、再起動するまで、消した本文をメモリに持っている。必要なら再起動する
--
-- 非表示の理由（reason）などの文に、ハッシュを書かない。ほかの記録がハッシュを指していると見なされ、その本文を消せなくなる。
--
-- 守りの範囲：条件に合わない本文・値は、持ち主でも消せない。条件に合う本文は、持ち主なら関数を通らずに直接でも消せる（持ち主は守りの対象外）。

-- 1つ目：消してよいのに、本文がまだ残っている投稿と、その最後の非表示の記録
-- （最後の記録が bodyErased 真で本文が残っている候補に絞ってから、消してよいかの判定（記録を全部読む）を呼ぶ）
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
)
SELECT * FROM candidates WHERE stored_values_erasable(current_schema(), body_hash)
ORDER BY seq;

-- 2つ目：食い違い。最後の記録が bodyErased 真なのに本文が残っている投稿（not_erased）、本文がないのに最後の記録が真でない投稿（missing）
WITH latest AS (
  SELECT DISTINCT ON (w.payload->'targetSeq') w.payload->'targetSeq' AS target, w.payload->'bodyErased' = 'true'::jsonb AS body_erased
  FROM events w WHERE w.type = 'content.withdrawn' AND w.actor LIKE 'operator:%'
  ORDER BY w.payload->'targetSeq', w.seq DESC
)
SELECT p.seq, p.payload->>'bodyHash' AS body_hash, CASE WHEN v.hash IS NULL THEN 'missing' ELSE 'not_erased' END AS problem
FROM events p
LEFT JOIN latest l ON l.target = to_jsonb(p.seq)
LEFT JOIN stored_values v ON v.hash = p.payload->>'bodyHash' AND v.kind = 'body'
WHERE p.type = 'post.published' AND ((l.body_erased AND v.hash IS NOT NULL) OR (l.body_erased IS NOT TRUE AND v.hash IS NULL))
ORDER BY p.seq;

-- 3つ目：本文を消す
SELECT erase_withdrawn_body(<seq>);
