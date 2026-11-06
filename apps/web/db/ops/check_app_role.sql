-- ffr_app の権限を確かめる（ffr_app の接続で流す）。想定の結果はコメントのとおり。読むだけで、何も変えない。
SELECT current_user AS who,                                               -- ffr_app
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,   -- false
       pg_has_role(current_user, 'pg_write_all_data', 'USAGE') AS write_all_data,   -- false
       has_table_privilege('events', 'SELECT') AS can_select,             -- true
       has_table_privilege('events', 'INSERT') AS can_insert,             -- true
       has_table_privilege('events', 'UPDATE') AS can_update,             -- false
       has_table_privilege('events', 'DELETE') AS can_delete,             -- false
       has_table_privilege('events', 'TRUNCATE') AS can_truncate;         -- false
