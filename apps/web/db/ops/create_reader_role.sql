-- 画面用の、読むだけの役割 ffr_reader を作る（運営者が、表の持ち主の接続で一度だけ流す。migrate の前でも後でもよい）。
-- 許すのは events と stored_values を読むこと（SELECT）だけ。書く・消す・本文を消す関数を呼ぶ・表や一時テーブルを作ることはできない。
-- コンソールの「役割の作成」ではなく、この SQL で作る（コンソールの役割は pg_write_all_data などを持つことがあるため）。
-- <password> は流す人が決める値に置き換える。ファイルやログには残さない。<db> は接続するデータベース名。
-- migrate の前に流したとき：あとで migrate（db/001_events.sql など）を流すと、SELECT だけが与えられる。
-- migrate の後に流したとき：最後の文が、いまの search_path で見える events と stored_values に SELECT だけを与える。
--   表を別の schema（DATABASE_SCHEMA）に作ったときは、migrate をもう一度流す（何度流しても同じ結果になる）。
-- 流したあと、ffr_reader の接続で db/ops/check_reader_role.sql を流して確かめる。
CREATE ROLE ffr_reader LOGIN PASSWORD '<password>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
-- 一時テーブルを作る権限を外す。<db> は接続するデータベース名
REVOKE TEMP ON DATABASE <db> FROM PUBLIC;
REVOKE TEMP ON DATABASE <db> FROM ffr_reader;
DO $$
DECLARE
  t text;
  rel regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY['events', 'stored_values'] LOOP
    rel := to_regclass(t);
    IF rel IS NULL THEN
      RAISE NOTICE 'table % does not exist yet: the migration (db/*.sql) will grant SELECT', t;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO ffr_reader', (SELECT nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = rel));
    EXECUTE format('REVOKE ALL ON %s FROM ffr_reader', rel);
    EXECUTE format('GRANT SELECT ON %s TO ffr_reader', rel);
  END LOOP;
END $$;
