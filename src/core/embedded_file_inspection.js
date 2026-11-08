/* Copyright 2026 Streetblock
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Dict, Name, Ref } from "./primitives.js";
import { BaseStream } from "./base_stream.js";
import { MissingDataException } from "./core_utils.js";
import { PasswordException } from "../shared/util.js";
import { stringToPDFString } from "./string_utils.js";

const LIMITS = Object.freeze({
  treeNodes: 256,
  treeDepth: 32,
  entries: 512,
  streamBytes: 20 * 1024 * 1024,
  metadataBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
});

// Evidence only: this deliberately makes no PDF/A or invoice validity claim.
// Preserve duplicate name-tree entries and both /F and /UF stream mappings.
function inspectEmbeddedFiles(catalog, xref, metadataOnly = false) {
  const result = {
    version: 1,
    files: [],
    nameTreePresent: false,
    nameTreeEntries: [],
    associatedFiles: null,
    metadata: null,
    issues: [],
    limits: { ...LIMITS },
    parser: null,
  };
  const files = new Map();
  const streams = new Map();
  const visitedNodes = new Set();
  let totalBytes = 0;
  let entryCount = 0;

  function issue(code, path) {
    result.issues.push({ code, path });
  }

  function attempt(path, fn) {
    try {
      return fn();
    } catch (ex) {
      // NetworkPdfManager must be able to request missing ranges and retry.
      if (
        ex instanceof MissingDataException ||
        ex instanceof PasswordException
      ) {
        throw ex;
      }
      issue("unreadable-object", path);
      return null;
    }
  }

  function atom(raw) {
    const value = xref.fetchIfRef(raw);
    const ref = raw instanceof Ref ? raw.toString() : null;
    if (value instanceof Name) {
      return { type: "name", value: value.name, ref };
    }
    if (typeof value === "string") {
      // No path stripping or slash replacement: consumers compare exact names.
      return { type: "string", value: stringToPDFString(value, true), ref };
    }
    let type = typeof value;
    if (value === undefined) {
      type = "missing";
    } else if (value === null) {
      type = "null";
    } else if (Array.isArray(value)) {
      type = "array";
    } else if (value instanceof BaseStream) {
      type = "stream";
    } else if (value instanceof Dict) {
      type = "dictionary";
    }
    return {
      type,
      value:
        typeof value === "number" || typeof value === "boolean" ? value : null,
      ref,
    };
  }

  function field(dict, key, path) {
    return attempt(`${path}/${key}`, () => atom(dict.getRaw(key)));
  }

  function readStream(raw, path, maxBytes, metadata = false) {
    const ref = raw instanceof Ref ? raw.toString() : null;
    // Honor /EncryptMetadata in the same way as Catalog.metadata.
    const stream = xref.fetchIfRef(
      raw,
      metadata && !xref.encrypt?.encryptMetadata
    );
    if (!(stream instanceof BaseStream)) {
      issue("invalid-stream", path);
      return { ref, bytes: null };
    }
    const cacheKey = ref ? `${metadata}:${ref}` : stream;
    if (streams.has(cacheKey)) {
      return streams.get(cacheKey);
    }
    const record = {
      ref,
      type: field(stream.dict, "Type", path),
      subtype: field(stream.dict, "Subtype", path),
      bytes: null,
    };
    streams.set(cacheKey, record);
    const encrypt = xref.encrypt;
    if (encrypt?.encryptionKey === null) {
      issue("encrypted-stream-unavailable", path);
      return record;
    }
    const allowance = Math.min(maxBytes, LIMITS.totalBytes - totalBytes);
    if (allowance <= 0) {
      issue("byte-limit", path);
      return record;
    }
    const position = stream.pos;
    try {
      stream.reset();
      // Copy decoded bytes without parsing/re-serializing the XML. Reading is
      // bounded; upstream decoding can allocate larger internal blocks.
      const bytes = stream.getBytes(allowance + 1);
      totalBytes += bytes.length;
      if (bytes.length > allowance) {
        issue("byte-limit", path);
      } else {
        record.bytes = bytes.slice();
      }
    } finally {
      stream.pos = position;
    }
    return record;
  }

  function file(raw, path) {
    const dict = xref.fetchIfRef(raw);
    if (!(dict instanceof Dict)) {
      issue("invalid-file-specification", path);
      return null;
    }
    const identity = dict.objId || dict;
    if (files.has(identity)) {
      return files.get(identity).id;
    }
    const record = {
      id: `file-${result.files.length}`,
      ref: raw instanceof Ref ? raw.toString() : null,
      type: field(dict, "Type", path),
      filename: field(dict, "F", path),
      unicodeFilename: field(dict, "UF", path),
      relationship: field(dict, "AFRelationship", path),
      embeddedFiles: [],
    };
    files.set(identity, record);
    result.files.push(record);
    const ef = dict.get("EF");
    if (!(ef instanceof Dict)) {
      issue("invalid-embedded-file-dictionary", `${path}/EF`);
      return record.id;
    }
    for (const key of ["F", "UF", "DOS", "Mac", "Unix"]) {
      if (!ef.has(key)) {
        continue;
      }
      const streamPath = `${path}/EF/${key}`;
      record.embeddedFiles.push({
        key,
        stream: attempt(streamPath, () =>
          readStream(ef.getRaw(key), streamPath, LIMITS.streamBytes)
        ),
      });
    }
    if (!record.embeddedFiles.length) {
      issue("missing-embedded-stream", `${path}/EF`);
    }
    return record.id;
  }

  function reserveEntry(path) {
    if (++entryCount > LIMITS.entries) {
      issue("entry-limit", path);
      return false;
    }
    return true;
  }

  function walk(raw, path, depth) {
    if (depth > LIMITS.treeDepth || visitedNodes.size >= LIMITS.treeNodes) {
      issue("tree-limit", path);
      return;
    }
    const node = xref.fetchIfRef(raw);
    if (!(node instanceof Dict)) {
      issue("invalid-name-tree-node", path);
      return;
    }
    const identity = node.objId || node;
    if (visitedNodes.has(identity)) {
      issue("repeated-name-tree-node", path);
      return;
    }
    visitedNodes.add(identity);
    if (node.has("Kids") && node.has("Names")) {
      issue("mixed-name-tree-node", path);
    }
    if (node.has("Names")) {
      const entries = node.get("Names");
      if (!Array.isArray(entries)) {
        issue("invalid-name-tree-entries", path);
      } else {
        if (entries.length % 2) {
          issue("odd-name-tree-entries", path);
        }
        for (let i = 0; i < entries.length; i += 2) {
          const entryPath = `${path}/Names/${i}`;
          if (!reserveEntry(entryPath)) {
            break;
          }
          const key = attempt(entryPath, () => atom(entries[i]));
          if (key?.type !== "string") {
            issue("invalid-name-tree-key", entryPath);
          }
          result.nameTreeEntries.push({
            key,
            ref:
              entries[i + 1] instanceof Ref ? entries[i + 1].toString() : null,
            fileId: attempt(entryPath, () => file(entries[i + 1], entryPath)),
          });
        }
      }
    }
    if (node.has("Kids")) {
      const kids = node.get("Kids");
      if (!Array.isArray(kids)) {
        issue("invalid-name-tree-kids", path);
      } else {
        for (let i = 0; i < kids.length; i++) {
          if (visitedNodes.size >= LIMITS.treeNodes || i >= LIMITS.treeNodes) {
            issue("tree-limit", path);
            break;
          }
          attempt(`${path}/Kids/${i}`, () =>
            walk(kids[i], `${path}/Kids/${i}`, depth + 1)
          );
        }
      }
    }
    if (!node.has("Kids") && !node.has("Names")) {
      issue("empty-name-tree-node", path);
    }
  }

  if (!metadataOnly) {
    inspectAttachmentReferences();
  }
  function inspectAttachmentReferences() {
    attempt("/Names", () => {
      if (!catalog.has("Names")) {
        return;
      }
      const names = catalog.get("Names");
      if (!(names instanceof Dict)) {
        issue("invalid-names-dictionary", "/Names");
      } else if (names.has("EmbeddedFiles")) {
        result.nameTreePresent = true;
        walk(names.getRaw("EmbeddedFiles"), "/Names/EmbeddedFiles", 0);
      }
    });
    attempt("/AF", () => {
      if (!catalog.has("AF")) {
        return;
      }
      result.associatedFiles = [];
      const af = catalog.get("AF");
      if (!Array.isArray(af)) {
        issue("invalid-associated-files", "/AF");
        return;
      }
      for (let i = 0; i < af.length; i++) {
        const path = `/AF/${i}`;
        if (!reserveEntry(path)) {
          break;
        }
        result.associatedFiles.push({
          ref: af[i] instanceof Ref ? af[i].toString() : null,
          fileId: attempt(path, () => file(af[i], path)),
        });
      }
    });
  }
  if (catalog.has("Metadata")) {
    result.metadata = attempt("/Metadata", () =>
      readStream(
        catalog.getRaw("Metadata"),
        "/Metadata",
        LIMITS.metadataBytes,
        true
      )
    );
  }
  // These two flags describe xref recovery only, NOT every tolerance in PDF.js.
  result.parser = {
    ...xref.inspectionState,
    diagnosticsComplete: false,
  };
  return result;
}

export { inspectEmbeddedFiles };
