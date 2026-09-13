/* Temporary Prompt 4 helper. It is deleted after the catalog artifacts are generated. */
const fs = require("fs");
const path = require("path");
const { Client } = require(process.env.CATALOG_PG_MODULE);

const outputSql = path.resolve("docs/reachagent-live-schema-only.sql");
const outputJson = path.join(process.env.TEMP, "reachagent-live-catalog.json");

const qident = (value) => `"${String(value).replaceAll('"', '""')}"`;
const qliteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const aclGrantee = (value) => value === "PUBLIC" ? "PUBLIC" : qident(value);
const arrayText = (value) => Array.isArray(value) ? value.join(",") : String(value || "").replace(/^\{|\}$/g, "");

async function rows(client, text) {
  return (await client.query(text)).rows;
}

async function main() {
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: { rejectUnauthorized: false },
    application_name: "reachagent_prompt4_readonly_catalog",
  });
  await client.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const readOnly = await rows(client, "select current_setting('transaction_read_only') as transaction_read_only, current_database() as database_name, version() as server_version, now() as captured_at");
  if (readOnly[0].transaction_read_only !== "on") throw new Error("Catalog transaction is not read-only");

  const catalog = { metadata: readOnly[0] };
  catalog.extensions = await rows(client, `
    select e.extname, e.extversion, n.nspname as schema_name, pg_get_userbyid(e.extowner) as owner
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace
    order by e.extname`);
  catalog.types = await rows(client, `
    select n.nspname as schema_name, t.typname as type_name, t.typtype,
           case when t.typtype='e' then (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid) end as enum_labels,
           case when t.typtype='d' then format_type(t.typbasetype,t.typtypmod) end as domain_base_type,
           case when t.typtype='d' then t.typnotnull end as domain_not_null,
           case when t.typtype='d' then pg_get_expr(t.typdefaultbin,0) end as domain_default,
           pg_get_userbyid(t.typowner) as owner
    from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where n.nspname in ('public','extensions') and t.typtype in ('e','d')
    order by n.nspname,t.typname`);
  catalog.relations = await rows(client, `
    select n.nspname as schema_name, c.relname, c.relkind, pg_get_userbyid(c.relowner) as owner,
           c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
           obj_description(c.oid,'pg_class') as comment
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','extensions') and c.relkind in ('r','p','v','m','S','f')
    order by n.nspname,c.relkind,c.relname`);
  catalog.columns = await rows(client, `
    select n.nspname as schema_name, c.relname as table_name, a.attnum, a.attname as column_name,
           format_type(a.atttypid,a.atttypmod) as data_type, a.attnotnull as not_null,
           pg_get_expr(d.adbin,d.adrelid) as default_expression, a.attidentity as identity_kind,
           a.attgenerated as generated_kind, col_description(c.oid,a.attnum) as comment,
           coll.collname as collation
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    left join pg_collation coll on coll.oid=a.attcollation and a.attcollation<>(select oid from pg_collation where collname='default' and collencoding=-1 limit 1)
    where n.nspname in ('public','extensions') and c.relkind in ('r','p','v','m','f') and a.attnum>0 and not a.attisdropped
    order by n.nspname,c.relname,a.attnum`);
  catalog.constraints = await rows(client, `
    select n.nspname as schema_name, c.relname as table_name, con.conname as constraint_name,
           con.contype, pg_get_constraintdef(con.oid,true) as definition, con.condeferrable,
           con.condeferred, con.convalidated, rn.nspname as referenced_schema,
           rc.relname as referenced_table, con.confdeltype, con.confupdtype
    from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_class rc on rc.oid=con.confrelid left join pg_namespace rn on rn.oid=rc.relnamespace
    where n.nspname in ('public','extensions')
    order by n.nspname,c.relname,con.contype,con.conname`);
  catalog.indexes = await rows(client, `
    select n.nspname as schema_name, t.relname as table_name, i.relname as index_name,
           am.amname as method, x.indisunique as is_unique, x.indisprimary as is_primary,
           x.indisexclusion as is_exclusion, x.indisvalid as is_valid, x.indisready as is_ready,
           pg_get_indexdef(i.oid) as definition, pg_get_expr(x.indpred,x.indrelid) as predicate,
           pg_get_expr(x.indexprs,x.indrelid) as expressions,
           array(select opc.opcname from unnest(x.indclass::oid[]) with ordinality u(oid,ord) join pg_opclass opc on opc.oid=u.oid order by u.ord) as opclasses,
           con.conname as backing_constraint
    from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid
    join pg_namespace n on n.oid=t.relnamespace join pg_am am on am.oid=i.relam
    left join pg_constraint con on con.conindid=i.oid
    where n.nspname in ('public','extensions')
    order by n.nspname,t.relname,i.relname`);
  catalog.functions = await rows(client, `
    select n.nspname as schema_name, p.proname as function_name,
           pg_get_function_identity_arguments(p.oid) as identity_arguments,
           pg_get_function_result(p.oid) as result_type, l.lanname as language,
           p.provolatile as volatility, p.proparallel as parallel_safety,
           p.prosecdef as security_definer, p.proleakproof as leakproof,
           p.proisstrict as strict, p.proconfig as configuration,
           pg_get_userbyid(p.proowner) as owner, p.proacl::text as acl,
           pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname in ('public','extensions')
    order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`);
  catalog.views = await rows(client, `
    select n.nspname as schema_name, c.relname as view_name, c.relkind,
           pg_get_userbyid(c.relowner) as owner, pg_get_viewdef(c.oid,true) as definition,
           c.reloptions
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','extensions') and c.relkind in ('v','m')
    order by n.nspname,c.relname`);
  catalog.triggers = await rows(client, `
    select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name,
           t.tgenabled as enabled_mode, t.tgisinternal as is_internal,
           pg_get_triggerdef(t.oid,true) as definition,
           pn.nspname as function_schema, p.proname as function_name,
           pg_get_function_identity_arguments(p.oid) as function_arguments
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
    where n.nspname in ('public','auth') and not t.tgisinternal
    order by n.nspname,c.relname,t.tgname`);
  catalog.policies = await rows(client, `
    select n.nspname as schema_name, c.relname as table_name, pol.polname as policy_name,
           pol.polpermissive as permissive, pol.polcmd as command,
           array(select case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end from unnest(pol.polroles) r) as roles,
           pg_get_expr(pol.polqual,pol.polrelid) as using_expression,
           pg_get_expr(pol.polwithcheck,pol.polrelid) as with_check_expression
    from pg_policy pol join pg_class c on c.oid=pol.polrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','extensions')
    order by n.nspname,c.relname,pol.polname`);
  catalog.table_grants = await rows(client, `
    select table_schema as schema_name, table_name, grantor, grantee, privilege_type, is_grantable
    from information_schema.role_table_grants where table_schema in ('public','extensions')
    union all
    select table_schema, table_name, grantor, 'PUBLIC', privilege_type, is_grantable
    from information_schema.table_privileges where table_schema in ('public','extensions') and grantee='PUBLIC'
    order by 1,2,4,5`);
  catalog.routine_grants = await rows(client, `
    select routine_schema as schema_name, routine_name, specific_name, grantor, grantee, privilege_type, is_grantable
    from information_schema.role_routine_grants where routine_schema in ('public','extensions')
    union all
    select routine_schema, routine_name, specific_name, grantor, 'PUBLIC', privilege_type, is_grantable
    from information_schema.routine_privileges where routine_schema in ('public','extensions') and grantee='PUBLIC'
    order by 1,2,3,5,6`);
  catalog.schema_grants = await rows(client, `
    select n.nspname as schema_name, grantor.rolname as grantor,
           case when x.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,
           x.privilege_type, x.is_grantable
    from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x
    join pg_roles grantor on grantor.oid=x.grantor left join pg_roles grantee on grantee.oid=x.grantee
    where n.nspname in ('public','extensions') order by 1,3,4`);
  catalog.default_privileges = await rows(client, `
    select pg_get_userbyid(d.defaclrole) as owner, coalesce(n.nspname,'*') as schema_name,
           d.defaclobjtype as object_type, grantor.rolname as grantor,
           case when x.grantee=0 then 'PUBLIC' else grantee.rolname end as grantee,
           x.privilege_type, x.is_grantable
    from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) x join pg_roles grantor on grantor.oid=x.grantor
    left join pg_roles grantee on grantee.oid=x.grantee
    where n.nspname in ('public','extensions') or d.defaclnamespace=0
    order by 1,2,3,5,6`);
  catalog.sequences = await rows(client, `
    select n.nspname as schema_name, c.relname as sequence_name, pg_get_userbyid(c.relowner) as owner,
           s.seqstart, s.seqincrement, s.seqmax, s.seqmin, s.seqcache, s.seqcycle,
           tn.nspname as owned_by_schema, tc.relname as owned_by_table, a.attname as owned_by_column
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_sequence s on s.seqrelid=c.oid
    left join pg_depend d on d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype in ('a','i')
    left join pg_class tc on tc.oid=d.refobjid left join pg_namespace tn on tn.oid=tc.relnamespace
    left join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
    where n.nspname in ('public','extensions') order by n.nspname,c.relname`);

  await client.query("COMMIT");
  await client.end();

  const lines = [];
  lines.push("-- ReachAgent production schema-only catalog representation");
  lines.push("-- Generated by read-only pg_catalog queries; contains no table row data and no credentials.");
  lines.push(`-- Captured at: ${catalog.metadata.captured_at}`);
  lines.push(`-- Database: ${catalog.metadata.database_name}`);
  lines.push(`-- Server: ${String(catalog.metadata.server_version).replaceAll("\n", " ")}`);
  lines.push("-- Transaction read-only: on", "");
  lines.push("SET statement_timeout = 0;", "SET lock_timeout = 0;", "SET client_encoding = 'UTF8';", "SET standard_conforming_strings = on;", "");

  lines.push("-- Extensions");
  for (const e of catalog.extensions) lines.push(`CREATE EXTENSION IF NOT EXISTS ${qident(e.extname)} WITH SCHEMA ${qident(e.schema_name)}; -- live version ${e.extversion}; owner ${e.owner}`);
  lines.push("");
  lines.push("-- User-defined enum/domain types");
  for (const t of catalog.types) {
    const name = `${qident(t.schema_name)}.${qident(t.type_name)}`;
    if (t.typtype === "e") lines.push(`CREATE TYPE ${name} AS ENUM (${t.enum_labels.map(qliteral).join(", ")});`);
    if (t.typtype === "d") lines.push(`CREATE DOMAIN ${name} AS ${t.domain_base_type}${t.domain_default ? ` DEFAULT ${t.domain_default}` : ""}${t.domain_not_null ? " NOT NULL" : ""};`);
  }
  lines.push("");
  lines.push("-- Sequences");
  for (const s of catalog.sequences) {
    lines.push(`CREATE SEQUENCE ${qident(s.schema_name)}.${qident(s.sequence_name)} INCREMENT BY ${s.seqincrement} MINVALUE ${s.seqmin} MAXVALUE ${s.seqmax} START WITH ${s.seqstart} CACHE ${s.seqcache}${s.seqcycle ? " CYCLE" : " NO CYCLE"};`);
    lines.push(`ALTER SEQUENCE ${qident(s.schema_name)}.${qident(s.sequence_name)} OWNER TO ${qident(s.owner)};`);
  }
  lines.push("");
  lines.push("-- Tables (schema only; no COPY or INSERT statements)");
  for (const rel of catalog.relations.filter(r => ["r","p","f"].includes(r.relkind))) {
    const cols = catalog.columns.filter(c => c.schema_name === rel.schema_name && c.table_name === rel.relname);
    const defs = cols.map(c => {
      let d = `  ${qident(c.column_name)} ${c.data_type}`;
      if (c.collation) d += ` COLLATE ${qident(c.collation)}`;
      if (c.generated_kind === "s") d += ` GENERATED ALWAYS AS (${c.default_expression}) STORED`;
      else if (c.identity_kind) d += ` GENERATED ${c.identity_kind === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
      else if (c.default_expression) d += ` DEFAULT ${c.default_expression}`;
      if (c.not_null) d += " NOT NULL";
      return d;
    });
    lines.push(`CREATE TABLE ${qident(rel.schema_name)}.${qident(rel.relname)} (\n${defs.join(",\n")}\n);`);
    lines.push(`ALTER TABLE ${qident(rel.schema_name)}.${qident(rel.relname)} OWNER TO ${qident(rel.owner)};`);
  }
  lines.push("");
  lines.push("-- Constraints");
  for (const c of catalog.constraints) lines.push(`ALTER TABLE ONLY ${qident(c.schema_name)}.${qident(c.table_name)} ADD CONSTRAINT ${qident(c.constraint_name)} ${c.definition}${c.convalidated ? "" : " NOT VALID"};`);
  lines.push("");
  lines.push("-- Indexes (constraint-backed definitions are retained as comments because constraints create them)");
  for (const i of catalog.indexes) {
    lines.push(`-- metadata: table=${i.schema_name}.${i.table_name}; unique=${i.is_unique}; partial=${Boolean(i.predicate)}; predicate=${i.predicate || "NULL"}; method=${i.method}; opclasses=${arrayText(i.opclasses)}; valid=${i.is_valid}; ready=${i.is_ready}; backing_constraint=${i.backing_constraint || "NULL"}`);
    lines.push(i.backing_constraint ? `-- ${i.definition};` : `${i.definition};`);
  }
  lines.push("");
  lines.push("-- Functions (full pg_get_functiondef output)");
  for (const f of catalog.functions) {
    lines.push(`-- metadata: owner=${f.owner}; language=${f.language}; volatility=${f.volatility}; parallel=${f.parallel_safety}; security_definer=${f.security_definer}; leakproof=${f.leakproof}; strict=${f.strict}; config=${JSON.stringify(f.configuration)}; acl=${f.acl || "NULL"}`);
    lines.push(f.definition.trimEnd() + ";");
  }
  lines.push("");
  lines.push("-- Views");
  for (const v of catalog.views) {
    const kind = v.relkind === "m" ? "MATERIALIZED VIEW" : "VIEW";
    lines.push(`CREATE ${kind} ${qident(v.schema_name)}.${qident(v.view_name)} AS\n${v.definition.trimEnd()};`);
    lines.push(`ALTER ${kind} ${qident(v.schema_name)}.${qident(v.view_name)} OWNER TO ${qident(v.owner)};`);
  }
  lines.push("");
  lines.push("-- Triggers (public and ReachAgent auth integration)");
  for (const t of catalog.triggers) {
    lines.push(`${t.definition};`);
    if (t.enabled_mode === "D") lines.push(`ALTER TABLE ${qident(t.schema_name)}.${qident(t.table_name)} DISABLE TRIGGER ${qident(t.trigger_name)};`);
    if (t.enabled_mode === "A") lines.push(`ALTER TABLE ${qident(t.schema_name)}.${qident(t.table_name)} ENABLE ALWAYS TRIGGER ${qident(t.trigger_name)};`);
    if (t.enabled_mode === "R") lines.push(`ALTER TABLE ${qident(t.schema_name)}.${qident(t.table_name)} ENABLE REPLICA TRIGGER ${qident(t.trigger_name)};`);
  }
  lines.push("");
  lines.push("-- Row-level security and policies");
  for (const rel of catalog.relations.filter(r => ["r","p"].includes(r.relkind) && (r.rls_enabled || r.rls_forced))) {
    lines.push(`ALTER TABLE ${qident(rel.schema_name)}.${qident(rel.relname)} ENABLE ROW LEVEL SECURITY;`);
    if (rel.rls_forced) lines.push(`ALTER TABLE ${qident(rel.schema_name)}.${qident(rel.relname)} FORCE ROW LEVEL SECURITY;`);
  }
  const cmd = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };
  for (const p of catalog.policies) {
    let ddl = `CREATE POLICY ${qident(p.policy_name)} ON ${qident(p.schema_name)}.${qident(p.table_name)} AS ${p.permissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${cmd[p.command]} TO ${p.roles.map(aclGrantee).join(", ")}`;
    if (p.using_expression) ddl += ` USING (${p.using_expression})`;
    if (p.with_check_expression) ddl += ` WITH CHECK (${p.with_check_expression})`;
    lines.push(ddl + ";");
  }
  lines.push("");
  lines.push("-- Schema grants");
  for (const g of catalog.schema_grants) lines.push(`GRANT ${g.privilege_type} ON SCHEMA ${qident(g.schema_name)} TO ${aclGrantee(g.grantee)}${g.is_grantable ? " WITH GRANT OPTION" : ""}; -- grantor ${g.grantor}`);
  lines.push("");
  lines.push("-- Table/view grants");
  for (const g of catalog.table_grants) lines.push(`GRANT ${g.privilege_type} ON TABLE ${qident(g.schema_name)}.${qident(g.table_name)} TO ${aclGrantee(g.grantee)}${g.is_grantable === "YES" ? " WITH GRANT OPTION" : ""}; -- grantor ${g.grantor}`);
  lines.push("");
  lines.push("-- Function grants (specific_name records exact overloaded routine identity in catalog JSON)");
  for (const g of catalog.routine_grants) lines.push(`-- ${g.schema_name}.${g.specific_name}: GRANT ${g.privilege_type} TO ${g.grantee}${g.is_grantable === "YES" ? " WITH GRANT OPTION" : ""}; grantor ${g.grantor}`);
  lines.push("");
  lines.push("-- Default privileges (catalog representation; object_type codes: r=table, S=sequence, f=function, T=type, n=schema)");
  for (const g of catalog.default_privileges) lines.push(`-- owner=${g.owner}; schema=${g.schema_name}; object_type=${g.object_type}; grantor=${g.grantor}; grantee=${g.grantee}; privilege=${g.privilege_type}; grantable=${g.is_grantable}`);
  lines.push("");
  lines.push("-- End schema-only catalog representation. Production row data statements: 0.");

  fs.writeFileSync(outputSql, lines.join("\n") + "\n", "utf8");
  fs.writeFileSync(outputJson, JSON.stringify(catalog, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    outputSql,
    outputJson,
    capturedAt: catalog.metadata.captured_at,
    counts: Object.fromEntries(Object.entries(catalog).filter(([,v]) => Array.isArray(v)).map(([k,v]) => [k,v.length])),
  }, null, 2));
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
