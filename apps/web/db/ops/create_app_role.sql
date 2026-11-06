-- アプリ用の役割 ffr_app を作る（運営者が、表の持ち主の接続で一度だけ流す。migrate の前でも後でもよい）。
-- コンソールの「役割の作成」ではなく、この SQL で作る（コンソールの役割は pg_write_all_data などを持つことがあるため）。
-- <password> は流す人が決める値に置き換える。ファイルやログには残さない。
-- 役割を作ったあとで db/001_events.sql を流すと、events への SELECT と INSERT だけが与えられる。
CREATE ROLE ffr_app LOGIN PASSWORD '<password>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
-- 一時テーブルを作る権限を外す（トリガ側でも防いでいるが、二重に守る）。<db> は接続するデータベース名
REVOKE TEMP ON DATABASE <db> FROM PUBLIC;
REVOKE TEMP ON DATABASE <db> FROM ffr_app;
