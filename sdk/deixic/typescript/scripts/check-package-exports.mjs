import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const entry = "./dist/sdk/deixic/typescript/src/index.js";
assert.equal(manifest.exports["."].import, entry);
assert.equal(manifest.main, entry);
assert.equal(manifest.exports["."].types, entry.replace(/\.js$/, ".d.ts"));
await access(resolve(root, entry));
await access(resolve(root, manifest.exports["."].types));
const protocolEntry = "./dist/sdk/deixic/typescript/src/protocol.js";
assert.equal(manifest.exports["./protocol"].import, protocolEntry);
assert.equal(manifest.exports["./protocol"].types, protocolEntry.replace(/\.js$/, ".d.ts"));
await access(resolve(root, protocolEntry));
await access(resolve(root, manifest.exports["./protocol"].types));

const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
let checked = 0;
for (const file of await files(resolve(root, "dist"))) {
  if (!file.endsWith(".js") && !file.endsWith(".d.ts")) continue;
  const source = await readFile(file, "utf8");
  const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g);
  for (const [, specifier] of imports) {
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier);
      const within = relative(resolve(root, "dist"), target);
      assert(!within.startsWith("..") && !isAbsolute(within), `${file}: import escapes packaged dist: ${specifier}`);
      await access(target);
    } else {
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      assert(dependencies.has(packageName), `${file}: undeclared runtime dependency: ${specifier}`);
    }
  }
  checked += 1;
}
assert(checked > 4, "the generated descriptor closure must be compiled into dist");
console.log(`Package exports and imports resolve within the artifact (${checked} modules).`);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assert(!entry.isSymbolicLink(), `packaged output cannot contain a symlink: ${path}`);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
