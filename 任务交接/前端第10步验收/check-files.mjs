import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../../ai-data/',import.meta.url));
const require=createRequire(join(root,'package.json'));
const prettier=require('prettier');
const files=[];
async function walk(path){for(const item of await readdir(join(root,path),{withFileTypes:true})){const child=path+'/'+item.name;if(item.isDirectory())await walk(child);else if(/\.(ts|vue|css)$/.test(child))files.push(child);}}
for(const dir of ['apps/web/src/features/knowledge','apps/web/src/features/preferences','apps/web/src/features/tasks','apps/web/tests/features/knowledge'])await walk(dir);
files.push(...[
 'packages/contracts/src/knowledge/knowledge-management.ts','packages/contracts/src/knowledge/knowledge-management-types.ts','packages/contracts/src/memory/preference-management.ts','packages/contracts/src/memory/preference-management-types.ts','packages/contracts/src/index.ts','packages/contracts/tests/knowledge/knowledge-management.test.ts',
 'apps/api/src/knowledge/knowledge-records.ts','apps/api/src/knowledge/knowledge-types.ts','apps/api/src/knowledge/knowledge-service.ts','apps/api/src/knowledge/sql-knowledge-repository.ts','apps/api/src/preferences/preference-service.ts','apps/api/src/reports/report-template-service.ts','apps/api/src/index.ts','apps/api/src/app-types.ts',
 'apps/api/src/routes/knowledge-routes.ts','apps/api/src/routes/preference-routes.ts','apps/api/src/routes/memory-event-routes.ts','apps/api/src/routes/report-management-routes.ts','apps/api/src/routes/metric-report-routes.ts',
 'apps/api/tests/preferences/preference-edit-state.test.ts','apps/api/tests/knowledge/knowledge-management.test.ts','apps/api/tests/routes/knowledge-management-routes.test.ts','apps/api/tests/knowledge/memory-knowledge-repository.ts','apps/api/tests/support/api-fixtures.ts','apps/api/tests/routes/preference-routes.test.ts','apps/api/tests/knowledge/report-template-knowledge.test.ts','apps/api/tests/integration/knowledge.integration.ts','apps/api/tests/integration/preferences.integration.ts',
 'apps/web/src/app/router.ts','apps/web/src/main.ts','apps/web/src/features/reports/components/report-template-submit.vue','apps/web/src/features/reports/stores/report-editor.ts','apps/web/src/features/reports/pages/report-editor.vue','apps/web/src/features/reports/pages/report-detail.vue','apps/web/src/features/reports/pages/report-center.vue','apps/web/tests/features/reports/editor.test.ts','apps/web/tests/support/knowledge-fixture.ts','apps/web/tests/e2e/knowledge.spec.ts']);
const results=[];
for(const file of files){const path=join(root,file),before=await readFile(path,'utf8'),options={...await prettier.resolveConfig(path),filepath:path};
 if(process.argv.includes('--write')){const after=await prettier.format(before,options);if(after!==before)await writeFile(path,after);}
 results.push({file,formatted:await prettier.check(await readFile(path,'utf8'),options)});
}
await writeFile(new URL('变更文件.json',import.meta.url),JSON.stringify(files,null,2));
await writeFile(new URL('format.json',import.meta.url),JSON.stringify(results,null,2));
console.log({files:files.length,passed:results.every(x=>x.formatted)});
if(results.some(x=>!x.formatted))process.exitCode=1;
