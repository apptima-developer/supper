"""Read-only verification of the isolated SUPPER recovery; prints aggregate metadata only."""
import json
import subprocess

CONTAINER = "supper-recovery-pg17"


def query(sql):
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-X", "-qAt", "-U",
         "supper_recovery_admin", "-d", "supper_restore", "-v", "ON_ERROR_STOP=1"],
        input="BEGIN READ ONLY; SET LOCAL statement_timeout='120s'; SELECT coalesce(json_agg(q),'[]') FROM (" + sql + ") q; ROLLBACK;",
        text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError("Read-only verification query failed; database output withheld for privacy")
    return json.loads(result.stdout)


def ident(value):
    return '"' + value.replace('"', '""') + '"'


assert ident('a"b') == '"a""b"'
inspection = json.loads(subprocess.check_output(["docker", "inspect", CONTAINER]))[0]
assert inspection["HostConfig"]["PortBindings"]["5432/tcp"][0]["HostIp"] == "127.0.0.1"
assert any(m["Destination"] == "/recovery-data" and
           m["Source"].startswith("/Volumes/Vault/storage/supper/") for m in inspection["Mounts"])

report = {}
report["database"] = query("SELECT current_database() AS name, version(), pg_database_size(current_database()) AS bytes, current_setting('server_encoding') AS encoding")
report["schemas"] = query("SELECT nspname FROM pg_namespace WHERE NOT starts_with(nspname,'pg_') AND nspname<>'information_schema' ORDER BY 1")
relations = query("SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,pg_table_size(c.oid) AS table_bytes,pg_indexes_size(c.oid) AS index_bytes,pg_total_relation_size(c.oid) AS total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT starts_with(n.nspname,'pg_') AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m') ORDER BY total_bytes DESC")
tables = [r for r in relations if r["kind"] in ("r", "p")]
counts = query(" UNION ALL ".join("SELECT " + "'" + r["schema"].replace("'", "''") + "." + r["name"].replace("'", "''") + "' AS name,count(*) AS rows FROM " + ident(r["schema"]) + "." + ident(r["name"]) for r in tables))
row_counts = {r["name"]: r["rows"] for r in counts}
for r in tables:
    r["rows"] = row_counts[r["schema"] + "." + r["name"]]
report["relations"] = relations
report["extensions"] = query("SELECT extname,extversion FROM pg_extension ORDER BY 1")
report["functions"] = query("SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE NOT starts_with(n.nspname,'pg_') AND n.nspname<>'information_schema'")
report["triggers"] = query("SELECT n.nspname AS schema,c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal")
report["event_triggers"] = query("SELECT evtname,evtevent,evtenabled FROM pg_event_trigger")
report["indexes"] = query("SELECT n.nspname AS schema,c.relname AS table_name,i.relname AS name,x.indisprimary,x.indisunique,x.indisvalid,x.indisready FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT starts_with(n.nspname,'pg_') AND n.nspname<>'information_schema'")
report["policies"] = query("SELECT schemaname,tablename,policyname,cmd,roles FROM pg_policies")
report["rls"] = query("SELECT n.nspname AS schema,c.relname AS name,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth','storage','realtime','vault') AND c.relkind IN ('r','p')")
report["columns"] = query("SELECT table_schema,table_name,column_name,data_type,is_nullable,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema IN ('public','auth','storage','realtime','vault') ORDER BY table_schema,table_name,ordinal_position")
fks = query("SELECT conname,convalidated,conrelid::regclass::text AS child,confrelid::regclass::text AS parent,ARRAY(SELECT a.attname FROM unnest(conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=conrelid AND a.attnum=k.num ORDER BY k.ord) AS child_keys,ARRAY(SELECT a.attname FROM unnest(confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=confrelid AND a.attnum=k.num ORDER BY k.ord) AS parent_keys FROM pg_constraint WHERE contype='f'")
for fk in fks:
    # Relation names come from PostgreSQL's quoted regclass representation.
    nonnull = " AND ".join("c." + ident(k) + " IS NOT NULL" for k in fk["child_keys"])
    match = " AND ".join("c." + ident(c) + "=p." + ident(p) for c, p in zip(fk["child_keys"], fk["parent_keys"]))
    fk["orphans"] = query("SELECT count(*) AS n FROM " + fk["child"] + " c WHERE " + nonnull + " AND NOT EXISTS(SELECT 1 FROM " + fk["parent"] + " p WHERE " + match + ")")[0]["n"]
report["foreign_keys"] = fks
report["active_json"] = query("SELECT key,jsonb_typeof(value) AS type,CASE WHEN jsonb_typeof(value)='array' THEN jsonb_array_length(value) END AS records,pg_column_size(value) AS stored_bytes FROM public.app_store WHERE key NOT LIKE 'backups/%' AND key NOT LIKE 'imports/snapshots/%' ORDER BY key")
report["storage_by_area"] = query("SELECT split_part(key,'/',1) AS area,count(*) AS rows,sum(pg_column_size(value)) AS stored_json_bytes FROM public.app_store GROUP BY 1 ORDER BY 3 DESC")
report["ticket_fields"] = query("SELECT DISTINCT jsonb_object_keys(t) AS field FROM public.app_store a CROSS JOIN LATERAL jsonb_array_elements(a.value) t WHERE a.key='core/tickets.json' ORDER BY 1")
report["customer_fields"] = query("SELECT DISTINCT jsonb_object_keys(t) AS field FROM public.app_store a CROSS JOIN LATERAL jsonb_array_elements(a.value) t WHERE a.key='core/customers.json' ORDER BY 1")
print(json.dumps(report, indent=2, ensure_ascii=False))
