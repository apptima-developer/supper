import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
it("selects the verified webpack build only for ai_development and leaves other branch commands unchanged",()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"supper-build-dispatch-"));
  try {
    writeFileSync(path.join(directory,"npm"),'#!/bin/sh\nprintf "%s " "$@"\n',{mode:0o700});
    const config=JSON.parse(readFileSync("vercel.json","utf8"));
    for(const [branch,expected] of [["ai_development","run build -- --webpack "],["main","run build "]]) {
      const result=spawnSync("/bin/sh",["-c",config.buildCommand],{env:{NODE_ENV:"test",PATH:directory,VERCEL_GIT_COMMIT_REF:branch},encoding:"utf8"});
      expect(result.status).toBe(0);expect(result.stdout).toBe(expected);
    }
  }finally{rmSync(directory,{recursive:true});}
});
