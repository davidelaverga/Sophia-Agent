// Offline instrument check against an existing disposable PGlite runtime.
// Pass its module entry path; this installs nothing and opens no production DB.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const query = await readFile(new URL('../docs/campaigns/mem00-durable-memory/schema-attestation.sql', import.meta.url), 'utf8');
const db = new PGlite();
try {
  await db.exec(`CREATE TABLE public.sophia_memory_contract(singleton boolean PRIMARY KEY, schema_version text, contract_epoch bigint, mode text);
    INSERT INTO public.sophia_memory_contract VALUES(true,'mem00.v1',1,'enforced');
    CREATE TABLE public.sophia_memories(id uuid PRIMARY KEY, content text);
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
  const observe = async () => (await db.query(query)).rows[0].mem00_schema_attestation;
  const baseline = await observe();
  assert.match(baseline.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(baseline.contract, {schema_version:'mem00.v1', contract_epoch:1, mode:'enforced'});
  assert.equal((await observe()).sha256, baseline.sha256);
  await db.exec('ALTER TABLE public.sophia_memories ADD COLUMN synthetic_revision bigint');
  assert.notEqual((await observe()).sha256, baseline.sha256);
  await db.exec('ALTER TABLE public.sophia_memories DROP COLUMN synthetic_revision');
  assert.equal((await observe()).sha256, baseline.sha256);
  await db.exec('GRANT SELECT ON public.sophia_memories TO anon');
  assert.notEqual((await observe()).sha256, baseline.sha256);
  console.log(JSON.stringify({schema:'mem00.schema-query-instrument-test.v1', passed:true, checks:['syntax','contract','stable_digest','column_change_detected','column_rollback_restores','acl_change_detected'], query_sha256:createHash('sha256').update(query).digest('hex'), production_mutations:0}));
} finally {
  await db.close();
}
