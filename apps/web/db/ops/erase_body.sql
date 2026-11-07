-- 非表示にした投稿の本文を消す（権利・法的な理由のとき。docs/EVENT_LOG.md §5.2・§6.1。仕組みは db/003_erase_body.sql）。
-- 運営者が、表の持ち主の接続（DATABASE_ADMIN_URL）で流す。アプリの接続（ffr_app）からは呼べない。
-- 消すのは、ログの外に置いた本文と乱数だけ。イベント（投稿の記録と本文のハッシュ）は残り、ハッシュの連鎖は壊れない。
-- 画面には「非表示（理由）」が同じ位置に残る。消した本文は元に戻せない。
--
-- 手順
--   1. 先に、その投稿の content.withdrawn を、bodyErased = true で記録しておく（運営者の記録。これがない本文は消せない）
--   2. 下の 1 つ目の文で、消してよい本文がまだ残っている投稿を確かめる
--   3. 2 つ目の文の <seq> を、消す投稿の seq（post.published の通し番号）に置き換えて流す。消した本文のハッシュが返る
--      （すでに消えていれば NULL。条件に合わなければ例外になり、何も消えない）
--   4. アプリの接続で daily verify を流し、照合が通ることを確かめる

-- 2. 消してよいのに、本文がまだ残っている投稿
SELECT p.seq, p.payload->>'bodyHash' AS body_hash
FROM events p
JOIN stored_values v ON v.hash = p.payload->>'bodyHash' AND v.kind = 'body'
WHERE p.type = 'post.published' AND stored_values_erasable(current_schema(), p.payload->>'bodyHash')
ORDER BY p.seq;

-- 3. 本文を消す
SELECT erase_withdrawn_body(<seq>);
