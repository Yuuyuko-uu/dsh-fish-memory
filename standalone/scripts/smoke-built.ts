import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=mkdtempSync(join(tmpdir(),'fish-built-smoke-'));
const cwd=fileURLToPath(new URL('../',import.meta.url));
function run(args:string[]):void {
  const result=spawnSync(process.execPath,['dist/cli.js',...args],{cwd,encoding:'utf8',windowsHide:true,timeout:15000});
  if(result.error) throw result.error;
  assert.equal(result.status,0,result.stderr);
}
try {
  const home=join(root,'home'),snapshot=join(root,'backup'),restored=join(root,'restored');
  run(['init','--home',home,'--port','0']);
  run(['backup','--home',home,'--out',snapshot]);
  run(['restore','--from',snapshot,'--home',restored]);
  run(['init','--home',restored]);
  process.stdout.write('Built JavaScript CLI: init, offline backup, restore and reopen passed.\n');
} finally {
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));
  rmSync(root,{recursive:true,force:true});
}
