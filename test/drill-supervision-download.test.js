import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDrill } from "../dist/drill.js";

test("runDrill emits download size and storage phase, leaving supervised scratch for its owner", async () => {
  const data=Buffer.from("dummy archive; abort before Docker");
  const hash=createHash("sha256").update(data).digest("hex");
  const manifest={tool:"backupdrill-cli",toolVersion:"test",createdAt:new Date().toISOString(),projectName:"test",
    database:{serverVersion:"17",pgDumpVersion:"17",schemas:["public"],tableCount:0,tables:[]},
    dump:{key:"dump",format:"custom",bytes:data.length,sha256:hash},
    storage:{fileCount:1,totalBytes:data.length,files:[{bucket:"assets",key:"item",bytes:data.length,sha256:hash}]}};
  const requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    const body=req.url.includes("manifest.json") ? Buffer.from(JSON.stringify(manifest)) : data;
    res.writeHead(200,{"content-length":body.length,etag:'"test"'});res.end(body);
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const workdir=await mkdtemp(join(tmpdir(),"bd-download-supervised-"));
  const config={projectName:"test",storage:{endpoint:`http://127.0.0.1:${server.address().port}`,region:"us-east-1",
    bucket:"backups",prefix:"prefix",accessKeyId:"test",secretAccessKey:"test",forcePathStyle:true}};
  try {
    const events=[];
    await assert.rejects(runDrill(config,{snapshot:"test",supervision:{workdir,resourceName:`bd-drill-${randomUUID()}`,
      observe:async event=>{events.push(event);if(event.phase==="sandbox")throw new Error("stop before Docker");}}}),/stop before Docker/);
    assert.deepEqual(events.map(e=>e.phase),["download","storage","sandbox"]);
    assert.equal(events[0].dumpBytes,data.length);
    assert.deepEqual(await readFile(join(workdir,"dump.pgcustom")),data);
    assert.ok(requests.some(url=>url.includes("storage/assets/item")));
    await access(workdir);
    requests.length=0;
    await assert.rejects(runDrill(config,{snapshot:"test",supervision:{workdir,resourceName:`bd-drill-${randomUUID()}`,
      observe:async event=>{if(event.phase==="download")throw new Error("budget rejected");}}}),/budget rejected/);
    assert.equal(requests.length,1,"budget rejection happens after manifest, before archive download");
  } finally {
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    await rm(workdir,{recursive:true,force:true});
  }
});
