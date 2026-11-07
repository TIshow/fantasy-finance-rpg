-- ffr_reader の権限を確かめる（ffr_reader の接続で、migrate のあとに流す）。想定の結果はコメントのとおり。読むだけで、何も変えない。
SELECT current_user AS who,                                                          -- ffr_reader
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,    -- false
       pg_has_role(current_user, 'pg_write_all_data', 'USAGE') AS write_all_data,   -- false
       has_table_privilege('events', 'SELECT') AS can_select,                        -- true
       has_table_privilege('events', 'INSERT') AS can_insert,                        -- false
       has_table_privilege('events', 'UPDATE') AS can_update,                        -- false
       has_table_privilege('events', 'DELETE') AS can_delete,                        -- false
       has_table_privilege('events', 'TRUNCATE') AS can_truncate,                    -- false
       has_table_privilege('stored_values', 'SELECT') AS values_can_select,          -- true
       has_table_privilege('stored_values', 'INSERT') AS values_can_insert,          -- false
       has_table_privilege('stored_values', 'UPDATE') AS values_can_update,          -- false
       has_table_privilege('stored_values', 'DELETE') AS values_can_delete,          -- false
       has_table_privilege('stored_values', 'TRUNCATE') AS values_can_truncate,      -- false
       has_function_privilege('erase_withdrawn_body(bigint)', 'EXECUTE') AS can_erase_body,  -- false（本文を消す関数）
       has_database_privilege(current_database(), 'TEMP') AS can_create_temp,       -- false（一時テーブル）
       has_schema_privilege(current_schema(), 'CREATE') AS can_create_in_schema;    -- false（表などを作る）
