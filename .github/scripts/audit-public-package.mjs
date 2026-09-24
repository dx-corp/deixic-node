#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const [archive, packageRoot] = process.argv.slice(2);
assert(archive?.endsWith(".tgz"), "provide the built npm tarball");
assert(packageRoot, "provide the SDK package root");

const requireFromSdk = createRequire(path.resolve(packageRoot, "package.json"));
const { fromBinary } = await import(requireFromSdk.resolve("@bufbuild/protobuf"));
const { FileDescriptorProtoSchema } = await import(requireFromSdk.resolve("@bufbuild/protobuf/wkt"));
const temporary = mkdtempSync(path.join(tmpdir(), "deixic-public-audit-"));

function filesBelow(directory) {
  return readdirSync(directory).flatMap((name) => {
    const absolute = path.join(directory, name);
    return statSync(absolute).isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

try {
  const unpack = spawnSync("tar", ["-xzf", path.resolve(archive), "-C", temporary], { encoding: "utf8" });
  assert.equal(unpack.status, 0, unpack.stderr || "cannot unpack npm tarball");

  const root = path.join(temporary, "package");
  const files = filesBelow(root);
  const relative = files.map((file) => path.relative(root, file));
  assert(relative.includes("package.json"), "tarball is missing package.json");
  assert(relative.includes("dist/sdk/deixic/typescript/src/protocol.js"), "tarball is missing the public protocol");
  assert(relative.every((file) => !file.endsWith(".map")), "source map in public tarball");
  assert(relative.every((file) => !/\.(proto|ya?ml|openapi\.json)$/i.test(file)), "raw schema in public tarball");

  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@evalops/deixic-sdk");
  assert.equal(manifest.repository?.url, "git+https://github.com/dx-corp/deixic-node.git");
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
    "@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-web",
  ]);

  const descriptors = [];
  const internal = /\b(?:agentruntime|remoterunner|toolexecution|orbcontrol|evalops_platform)\b|\b(?:console|connectors|memory|meter|objectives|vfs)\.v1\b/i;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    assert(!internal.test(code), `internal namespace in ${path.relative(root, file)}`);
    if (!file.endsWith(".js")) continue;
    assert(!code.includes("sourceMappingURL="), `source map reference in ${path.relative(root, file)}`);
    const calls = code.match(/\bfileDesc\(/g) ?? [];
    const matches = [...code.matchAll(/\bfileDesc\(\s*["']([A-Za-z0-9+/=]+)["']\s*,\s*\[([^\]]*)\]/g)];
    assert.equal(matches.length, calls.length, `unrecognized descriptor encoding in ${path.relative(root, file)}`);
    for (const match of matches) {
      assert(code.includes('from "@bufbuild/protobuf/wkt"'), "unexpected descriptor import source");
      descriptors.push({
        proto: fromBinary(FileDescriptorProtoSchema, Buffer.from(match[1], "base64")),
        imports: match[2].split(",").map((value) => value.trim()).filter(Boolean),
      });
    }
  }
  assert.equal(descriptors.length, 1, "public package must contain exactly one embedded protobuf descriptor");
  const [{ proto: descriptor, imports }] = descriptors;
  assert.equal(descriptor.name, "deixicpublic/v1/sdk.proto");
  assert.equal(descriptor.package, "deixicpublic.v1");
  assert.deepEqual(descriptor.dependency, []);
  assert.deepEqual(imports, ["file_google_protobuf_timestamp"]);
  assert.deepEqual(descriptor.service.map((service) => service.name), ["DeixicPublicService"]);

  console.log(JSON.stringify({
    artifact: archive,
    files: relative.length,
    descriptor: descriptor.name,
    package: descriptor.package,
    dependencies: ["google/protobuf/timestamp.proto"],
    services: descriptor.service.map((service) => service.name),
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
