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

import { CIRCULAR_REF, Dict, isName, Name, Ref } from "./primitives.js";
import { BaseStream } from "./base_stream.js";
import { MissingDataException } from "./core_utils.js";

const RULES = ["PDF-EMBEDDED-FILE", "6.8-1", "6.8-2", "6.8-3", "6.8-4"];
const RELATIONSHIPS = new Set([
  "Source",
  "Data",
  "Alternative",
  "Supplement",
  "Unspecified",
]);
const RANK = { "not-applicable": 0, pass: 1, unknown: 2, fail: 3 };
const FILE_KEYS = ["F", "UF", "DOS", "Mac", "Unix"];
const UNREADABLE = Symbol("unreadable");
const MAX_DEPTH = 48;
const MAX_VISITS = 16_384;

function isAbsent(value) {
  return value === undefined || value === null;
}

class PdfAEmbeddedFileInspection {
  constructor(xref) {
    this.xref = xref;
    this.checks = new Map();
    this.files = new Map();
    this.streams = new Set();
    this.visited = new Map();
    this.visits = 0;
    this.incomplete = false;
    this.counts = {
      fileSpecifications: 0,
      streams: 0,
      associations: 0,
      contentPathsUninspected: 0,
    };
  }

  note(id, status, location, detail) {
    if (RANK[status] > (RANK[this.checks.get(id)?.status] ?? -1)) {
      this.checks.set(id, { id, status, location, detail });
    }
  }

  check(id, value, valid, path, detail) {
    let status = "unknown";
    if (value !== UNREADABLE) {
      status = valid ? "pass" : "fail";
    }
    this.note(id, status, path, valid ? "Requirement checked." : detail);
  }

  unknown(path, detail) {
    this.incomplete = true;
    for (const id of RULES) {
      this.note(id, "unknown", path, detail);
    }
  }

  take(path, depth = 0) {
    if (depth <= MAX_DEPTH && this.visits < MAX_VISITS) {
      this.visits++;
      return true;
    }
    this.unknown(path, "Embedded file inspection traversal limit exceeded.");
    return false;
  }

  resolve(raw) {
    if (!(raw instanceof Ref)) {
      return raw === CIRCULAR_REF ? UNREADABLE : raw;
    }
    try {
      const entry = this.xref.getEntry(raw.num);
      if (!entry || (entry.uncompressed ? entry.gen : 0) !== raw.gen) {
        return UNREADABLE;
      }
      const value = this.xref.fetch(raw);
      return isAbsent(value) || value === CIRCULAR_REF ? UNREADABLE : value;
    } catch (error) {
      if (error instanceof MissingDataException) {
        throw error;
      }
      return UNREADABLE;
    }
  }

  location(raw, path) {
    return raw instanceof Ref ? `${path} (${raw.num} ${raw.gen} R)` : path;
  }

  enter(kind, value) {
    let set = this.visited.get(kind);
    if (!set) {
      set = new Set();
      this.visited.set(kind, set);
    }
    if (set.has(value)) {
      return false;
    }
    set.add(value);
    return true;
  }

  // These values are evidence only. Resolving the stream dictionary never reads
  // or transfers its payload, including for embedded non-PDF files.
  stream(raw, path) {
    const value = this.resolve(raw);
    if (value === UNREADABLE) {
      this.note(
        "PDF-EMBEDDED-FILE",
        "unknown",
        path,
        "Embedded stream reference is unreadable."
      );
      this.note(
        "6.8-1",
        "unknown",
        path,
        "Embedded stream MIME type could not be inspected."
      );
      return;
    }
    if (!(value instanceof BaseStream)) {
      this.note(
        "PDF-EMBEDDED-FILE",
        "fail",
        path,
        "An /EF entry must identify an embedded file stream."
      );
      return;
    }
    this.streams.add(raw instanceof Ref ? raw.toString() : value);
    const type = this.resolve(value.dict.getRaw("Type"));
    this.check(
      "PDF-EMBEDDED-FILE",
      type,
      isAbsent(type) || isName(type, "EmbeddedFile"),
      `${path}/Type`,
      "An embedded file stream /Type, when specified, must be /EmbeddedFile."
    );
    const mime = this.resolve(value.dict.getRaw("Subtype"));
    this.check(
      "6.8-1",
      mime,
      mime instanceof Name && /^[-\w+.]+\/[-\w+.]+$/.test(mime.name),
      `${path}/Subtype`,
      "The embedded file stream requires a PDF Name containing its MIME type."
    );
  }

  file(raw, path, associated, requireEmbedded) {
    path = this.location(raw, path);
    if (!this.take(path)) {
      return;
    }
    const dict = this.resolve(raw);
    if (dict === UNREADABLE) {
      this.unknown(path, "File specification reference is unreadable.");
      return;
    }
    if (!(dict instanceof Dict)) {
      if (requireEmbedded || typeof dict !== "string") {
        this.note(
          "PDF-EMBEDDED-FILE",
          "fail",
          path,
          "Expected an embedded file specification dictionary."
        );
      }
      return;
    }
    const ef = this.resolve(dict.getRaw("EF"));
    if (isAbsent(ef) && !requireEmbedded) {
      return;
    }
    const identity = raw instanceof Ref ? raw.toString() : dict.objId || dict;
    if (this.files.has(identity)) {
      if (associated) {
        this.files.get(identity).associated = true;
      }
      return;
    }
    this.files.set(identity, { path, associated });
    if (!(ef instanceof Dict)) {
      this.note(
        "PDF-EMBEDDED-FILE",
        ef === UNREADABLE ? "unknown" : "fail",
        `${path}/EF`,
        "Expected a readable embedded file dictionary."
      );
      this.note(
        "6.8-1",
        "unknown",
        `${path}/EF`,
        "Embedded file streams could not be identified."
      );
    } else {
      const type = this.resolve(dict.getRaw("Type"));
      this.check(
        "PDF-EMBEDDED-FILE",
        type,
        isName(type, "Filespec"),
        `${path}/Type`,
        "An embedded file specification must identify itself as /Filespec."
      );
      let entries = 0;
      for (const key of FILE_KEYS) {
        const ref = ef.getRaw(key);
        if (!isAbsent(ref)) {
          entries++;
          this.stream(ref, `${path}/EF/${key}`);
        }
      }
      if (!entries) {
        this.note(
          "PDF-EMBEDDED-FILE",
          "fail",
          `${path}/EF`,
          "No embedded file stream mapping was found."
        );
      }
    }
    for (const key of ["F", "UF"]) {
      const value = this.resolve(dict.getRaw(key));
      this.check(
        "6.8-2",
        value,
        typeof value === "string",
        `${path}/${key}`,
        "An embedded file specification requires both /F and /UF file name strings."
      );
    }
    const relationship = this.resolve(dict.getRaw("AFRelationship"));
    const relationshipPath = `${path}/AFRelationship`;
    if (relationship instanceof Name && !RELATIONSHIPS.has(relationship.name)) {
      this.note(
        "6.8-3",
        "unknown",
        relationshipPath,
        "This relationship is outside the predefined PDF/A-3 relationship names."
      );
    } else {
      this.check(
        "6.8-3",
        relationship,
        relationship instanceof Name,
        relationshipPath,
        "An embedded file specification requires an /AFRelationship Name."
      );
    }
  }

  associations(dict, path) {
    const raw = dict.getRaw("AF");
    if (isAbsent(raw)) {
      return;
    }
    const afPath = `${path}/AF`;
    const array = this.resolve(raw);
    if (!Array.isArray(array)) {
      if (array === UNREADABLE) {
        this.unknown(afPath, "Associated file array reference is unreadable.");
      } else {
        this.note(
          "PDF-EMBEDDED-FILE",
          "fail",
          afPath,
          "An /AF entry must be an array of file specifications."
        );
      }
      return;
    }
    for (let index = 0; index < array.length; index++) {
      if (this.visits >= MAX_VISITS) {
        this.unknown(afPath, "Associated file traversal limit exceeded.");
        break;
      }
      this.counts.associations++;
      this.file(array[index], `${afPath}[${index}]`, true, true);
    }
  }

  dictionary(raw, path, depth, kind) {
    if (!this.take(path, depth)) {
      return null;
    }
    const dict = this.resolve(raw);
    if (!(dict instanceof Dict)) {
      this.unknown(path, "A potential embedded file location is unreadable.");
      return null;
    }
    if (this.enter(kind, dict)) {
      return dict;
    }
    if (kind === "name tree" || kind === "page tree") {
      this.unknown(path, "The tree contains a repeated or cyclic node.");
    }
    return null;
  }

  names(raw, path, depth) {
    const dict = this.dictionary(raw, path, depth, "name tree");
    if (!dict) {
      return;
    }
    const entries = this.resolve(dict.getRaw("Names"));
    if (!isAbsent(entries)) {
      if (!Array.isArray(entries) || entries.length % 2 !== 0) {
        this.unknown(path, "Embedded file name tree entries are incomplete.");
      }
      if (Array.isArray(entries)) {
        for (let i = 1; i < entries.length; i += 2) {
          if (this.visits >= MAX_VISITS) {
            this.unknown(
              path,
              "Embedded file name tree traversal limit exceeded."
            );
            break;
          }
          this.file(entries[i], `${path}/Names[${i}]`, false, true);
        }
      }
    }
    this.array(dict.getRaw("Kids"), `${path}/Kids`, (kid, kidPath) => {
      this.names(kid, kidPath, depth + 1);
    });
  }

  array(raw, path, visit) {
    if (isAbsent(raw)) {
      return;
    }
    const values = this.resolve(raw);
    if (!Array.isArray(values)) {
      this.unknown(
        path,
        "A potential embedded file path is not a readable array."
      );
      return;
    }
    for (let i = 0; i < values.length; i++) {
      const itemPath = `${path}[${i}]`;
      if (!this.take(itemPath)) {
        return;
      }
      visit(values[i], itemPath);
    }
  }

  annotation(raw, path, depth = 0) {
    const dict = this.dictionary(raw, path, depth, "annotation");
    if (!dict) {
      return;
    }
    this.associations(dict, path);
    const fs = dict.getRaw("FS");
    if (!isAbsent(fs)) {
      this.file(fs, `${path}/FS`, false, false);
    }
    const appearance = dict.getRaw("AP");
    if (!isAbsent(appearance)) {
      this.appearances(appearance, `${path}/AP`, depth + 1);
    }
    const popup = dict.getRaw("Popup");
    if (!isAbsent(popup)) {
      this.annotation(popup, `${path}/Popup`, depth + 1);
    }
  }

  appearances(raw, path, depth) {
    const dict = this.dictionary(raw, path, depth, "appearance");
    if (!dict) {
      return;
    }
    for (const key of ["N", "R", "D"]) {
      const rawValue = dict.getRaw(key);
      if (isAbsent(rawValue)) {
        continue;
      }
      const value = this.resolve(rawValue);
      const appearancePath = `${path}/${key}`;
      if (value instanceof Dict) {
        let index = 0;
        for (const state of value.getRawValues()) {
          if (this.visits >= MAX_VISITS) {
            this.unknown(
              appearancePath,
              "Appearance traversal limit exceeded."
            );
            return;
          }
          this.xobject(state, `${appearancePath}[${index++}]`, depth + 1);
        }
      } else {
        this.xobject(value, appearancePath, depth + 1);
      }
    }
  }

  page(raw, path, depth) {
    const dict = this.dictionary(raw, path, depth, "page tree");
    if (!dict) {
      return;
    }
    const type = this.resolve(dict.getRaw("Type"));
    if (isName(type, "Page")) {
      this.associations(dict, path);
      this.array(
        dict.getRaw("Annots"),
        `${path}/Annots`,
        (annotation, annotationPath) =>
          this.annotation(annotation, annotationPath)
      );
      const contents = dict.getRaw("Contents");
      if (
        !isAbsent(contents) &&
        !(Array.isArray(contents) && !contents.length)
      ) {
        this.counts.contentPathsUninspected++;
      }
    } else if (isName(type, "Pages")) {
      if (isAbsent(dict.getRaw("Kids"))) {
        this.unknown(
          `${path}/Kids`,
          "Page-tree children could not be established."
        );
      }
      this.array(dict.getRaw("Kids"), `${path}/Kids`, (kid, kidPath) =>
        this.page(kid, kidPath, depth + 1)
      );
    } else {
      this.unknown(path, "Page type is unreadable or invalid.");
    }
    this.resources(dict.getRaw("Resources"), `${path}/Resources`, depth);
  }

  resources(raw, path, depth) {
    if (isAbsent(raw)) {
      return;
    }
    const resources = this.dictionary(raw, path, depth, "resources");
    if (!isAbsent(resources?.getRaw("Pattern"))) {
      this.counts.contentPathsUninspected++;
    }
    const xobjects = resources?.getRaw("XObject");
    if (isAbsent(xobjects)) {
      return;
    }
    const dict = this.dictionary(
      xobjects,
      `${path}/XObject`,
      depth,
      "XObject collection"
    );
    if (!dict) {
      return;
    }
    let index = 0;
    for (const value of dict.getRawValues()) {
      const objectPath = `${path}/XObject[${index++}]`;
      if (!this.take(objectPath, depth)) {
        break;
      }
      this.xobject(value, objectPath, depth + 1);
    }
  }

  xobject(raw, path, depth) {
    if (!this.take(path, depth)) {
      return;
    }
    const stream = this.resolve(raw);
    if (!(stream instanceof BaseStream)) {
      this.unknown(path, "A potential XObject association is unreadable.");
      return;
    }
    const { dict } = stream;
    if (!this.enter("XObject", dict)) {
      return;
    }
    const subtype = this.resolve(dict.getRaw("Subtype"));
    if (isName(subtype, "Form") || isName(subtype, "Image")) {
      this.associations(dict, path);
      if (isName(subtype, "Form")) {
        this.counts.contentPathsUninspected++;
        this.resources(dict.getRaw("Resources"), `${path}/Resources`, depth);
      } else {
        for (const key of ["Mask", "SMask"]) {
          const mask = this.resolve(dict.getRaw(key));
          if (mask instanceof BaseStream) {
            this.xobject(mask, `${path}/${key}`, depth + 1);
          } else if (mask === UNREADABLE) {
            this.unknown(path, "Image mask association is unreadable.");
          }
        }
        if (!isAbsent(dict.getRaw("Alternates"))) {
          this.counts.contentPathsUninspected++;
        }
      }
    } else if (!isName(subtype, "PS")) {
      this.unknown(path, "XObject subtype is unreadable or unsupported.");
    }
  }

  structure(raw, path, depth) {
    if (isAbsent(raw) || Number.isInteger(raw)) {
      return;
    }
    if (!this.take(path, depth)) {
      return;
    }
    const value = this.resolve(raw);
    if (Number.isInteger(value)) {
      return;
    }
    if (Array.isArray(value)) {
      this.array(value, path, (kid, kidPath) =>
        this.structure(kid, kidPath, depth + 1)
      );
      return;
    }
    if (!(value instanceof Dict)) {
      this.unknown(path, "Structure element reference is unreadable.");
      return;
    }
    if (!this.enter("structure", value)) {
      return;
    }
    const type = this.resolve(value.getRaw("Type"));
    if (type === UNREADABLE) {
      this.unknown(path, "Structure element type is unreadable.");
    }
    if (isName(type, "OBJR")) {
      const target = this.resolve(value.getRaw("Obj"));
      if (target instanceof BaseStream) {
        this.xobject(target, `${path}/Obj`, depth + 1);
      } else if (
        target instanceof Dict &&
        (isName(this.resolve(target.getRaw("Type")), "Annot") ||
          isName(this.resolve(target.getRaw("Subtype")), "FileAttachment") ||
          this.visited.get("annotation")?.has(target))
      ) {
        this.annotation(target, `${path}/Obj`, depth + 1);
      } else {
        this.unknown(path, "Structure object reference is unreadable.");
      }
    } else if (!isName(type, "MCR")) {
      if (
        isName(type, "StructElem") ||
        (isAbsent(type) && !isAbsent(value.getRaw("S")))
      ) {
        this.associations(value, path);
      }
      this.structure(value.getRaw("K"), `${path}/K`, depth + 1);
    }
  }

  inspect(trusted) {
    if (!trusted) {
      this.unknown(
        "/Root",
        "Recovered or incomplete cross-references do not establish embedded file evidence."
      );
      return;
    }
    const catalog = this.dictionary(
      this.xref.trailer.getRaw("Root"),
      "/Root",
      0,
      "catalog"
    );
    if (!catalog) {
      return;
    }
    this.associations(catalog, "/Root");
    const names = catalog.getRaw("Names");
    if (!isAbsent(names)) {
      const dict = this.dictionary(names, "/Root/Names", 0, "names");
      const embedded = dict?.getRaw("EmbeddedFiles");
      if (!isAbsent(embedded)) {
        this.names(embedded, "/Root/Names/EmbeddedFiles", 0);
      }
    }
    this.page(catalog.getRaw("Pages"), "/Root/Pages", 0);
    this.structure(catalog.getRaw("StructTreeRoot"), "/Root/StructTreeRoot", 0);
    if (!isAbsent(catalog.getRaw("AcroForm"))) {
      this.counts.contentPathsUninspected++;
    }
  }

  finish() {
    const incompleteAssociation =
      this.incomplete || this.counts.contentPathsUninspected > 0;
    if (!this.files.size && this.counts.contentPathsUninspected > 0) {
      this.unknown(
        "/Root",
        "No embedded file was found in the inspected paths. Other possible attachment paths remain open."
      );
    }
    for (const { path, associated } of this.files.values()) {
      if (associated) {
        this.note(
          "6.8-4",
          "pass",
          path,
          "An association was found in a permitted /AF location."
        );
      } else if (incompleteAssociation) {
        this.note(
          "6.8-4",
          "unknown",
          path,
          "No inspected /AF association was found. Other possible association paths remain open."
        );
      } else {
        this.note(
          "6.8-4",
          "fail",
          path,
          "The embedded file specification is not referenced by an /AF array in a permitted location."
        );
      }
    }
    this.counts.fileSpecifications = this.files.size;
    this.counts.streams = this.streams.size;
    return {
      checks: RULES.map(
        id =>
          this.checks.get(id) || {
            id,
            status: "not-applicable",
            location: "",
            detail:
              "No applicable embedded file evidence in the inspected document graph.",
          }
      ),
      counts: this.counts,
    };
  }
}

function inspectPdfAEmbeddedFiles(xref, trusted) {
  const inspector = new PdfAEmbeddedFileInspection(xref);
  inspector.inspect(trusted);
  return inspector.finish();
}

export { inspectPdfAEmbeddedFiles };
