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
import { Dict, Name, Ref } from "../../src/core/primitives.js";
import { inspectEmbeddedFiles } from "../../src/core/embedded_file_inspection.js";
import { MissingDataException } from "../../src/core/core_utils.js";
import { StringStream } from "../../src/core/stream.js";

// No renderer or fixtures needed: malformed PDF objects stay observable.
describe("Embedded file inspection", function () {
  function fixture() {
    const objects = new Map();
    const xref = {
      inspectionState: { recoveryMode: false, xrefSectionsComplete: true },
      fetchIfRef(value) {
        return value instanceof Ref ? this.fetch(value) : value;
      },
      fetch(ref) {
        return objects.get(ref.toString()) ?? null;
      },
    };
    function dict(entries) {
      const value = new Dict(xref);
      for (const [key, entry] of Object.entries(entries)) {
        value.set(key, entry);
      }
      return value;
    }
    function register(number, value) {
      const ref = Ref.get(number, 0);
      if (value instanceof Dict) {
        value.objId = ref.toString();
      }
      objects.set(ref.toString(), value);
      return ref;
    }
    const bytes = new StringStream(
      "\xef\xbb\xbf<Invoice>\r\n</Invoice>\r\n",
      dict({
        Type: Name.get("EmbeddedFile"),
        Subtype: Name.get("application/xml"),
      })
    );
    const ef = dict({ F: register(5, bytes), UF: Ref.get(5, 0) });
    const spec = dict({
      Type: Name.get("Filespec"),
      F: "factur-x.xml",
      UF: "factur-x.xml",
      AFRelationship: Name.get("Alternative"),
      EF: ef,
    });
    const specRef = register(4, spec);
    const tree = dict({ Names: ["factur-x.xml", specRef] });
    const catalog = dict({
      Names: dict({ EmbeddedFiles: tree }),
      AF: [specRef],
    });
    const inspect = () => inspectEmbeddedFiles(catalog, xref);
    return {
      xref,
      dict,
      register,
      bytes,
      ef,
      spec,
      specRef,
      tree,
      catalog,
      inspect,
    };
  }

  it("joins name-tree and AF entries by object identity and preserves bytes", function () {
    const f = fixture();
    f.bytes.getByte();
    const result = f.inspect();
    expect(result.files.length).toBe(1);
    expect(result.associatedFiles[0].fileId).toBe(
      result.nameTreeEntries[0].fileId
    );
    expect(result.files[0].relationship).toEqual({
      type: "name",
      value: "Alternative",
      ref: null,
    });
    const streams = result.files[0].embeddedFiles;
    expect(streams[0].stream.subtype.value).toBe("application/xml");
    expect(Array.from(streams[0].stream.bytes).slice(0, 3)).toEqual([
      239, 187, 191,
    ]);
    expect(streams[0].stream).toBe(streams[1].stream);
    expect(f.bytes.pos).toBe(1);
    expect(result.issues).toEqual([]);
    expect(result.parser.diagnosticsComplete).toBeFalse();
    streams[0].stream.bytes.fill(0);
    expect(f.inspect().files[0].embeddedFiles[0].stream.bytes[0]).toBe(239);
  });

  it("keeps duplicate names and duplicate document associations", function () {
    const f = fixture();
    f.tree.set("Names", ["same.xml", f.specRef, "same.xml", f.specRef]);
    f.catalog.set("AF", [f.specRef, f.specRef]);
    expect(f.inspect().nameTreeEntries.length).toBe(2);
    expect(f.inspect().associatedFiles.length).toBe(2);
  });

  it("finds an AF-only file and distinguishes a missing name tree", function () {
    const f = fixture();
    f.catalog.set("Names", f.dict({}));
    const result = f.inspect();
    expect(result.nameTreePresent).toBeFalse();
    expect(result.files.length).toBe(1);
  });

  it("does not equate two file specifications with matching filenames", function () {
    const f = fixture();
    f.catalog.set("AF", [f.register(6, f.spec.clone())]);
    expect(f.inspect().files.length).toBe(2);
  });

  it("preserves incorrectly typed relationship and MIME values", function () {
    const f = fixture();
    f.spec.set("AFRelationship", "Alternative");
    f.bytes.dict.set("Subtype", "application/xml");
    const result = f.inspect();
    expect(result.files[0].relationship.type).toBe("string");
    expect(result.files[0].embeddedFiles[0].stream.subtype.type).toBe("string");
  });

  it("preserves conflicting F and UF streams", function () {
    const f = fixture();
    f.ef.set("UF", f.register(6, new StringStream("different", f.bytes.dict)));
    const streams = f.inspect().files[0].embeddedFiles;
    expect(streams[0].stream.ref).not.toBe(streams[1].stream.ref);
    expect(streams[0].stream.bytes).not.toEqual(streams[1].stream.bytes);
  });

  it("returns raw metadata without repairing malformed XML", function () {
    const f = fixture();
    f.catalog.set(
      "Metadata",
      f.register(
        7,
        new StringStream(
          "<broken>&",
          f.dict({ Type: Name.get("Metadata"), Subtype: Name.get("XML") })
        )
      )
    );
    expect(new TextDecoder().decode(f.inspect().metadata.bytes)).toBe(
      "<broken>&"
    );
  });

  it("terminates circular name trees", function () {
    const f = fixture();
    f.tree.set("Kids", [f.tree]);
    expect(f.inspect().issues.map(i => i.code)).toContain(
      "repeated-name-tree-node"
    );
  });

  it("reports dangling file references and odd name arrays", function () {
    const f = fixture();
    f.tree.set("Names", ["bad.xml", Ref.get(99, 0), "orphan.xml"]);
    const result = f.inspect();
    expect(result.nameTreeEntries[0].fileId).toBeNull();
    expect(result.issues.map(i => i.code)).toContain(
      "invalid-file-specification"
    );
    expect(result.issues.map(i => i.code)).toContain("odd-name-tree-entries");
  });

  it("reports unreadable EF while retaining the file evidence", function () {
    const f = fixture();
    f.ef.set("F", Ref.get(99, 0));
    const result = f.inspect();
    expect(result.files[0].embeddedFiles[0].stream.bytes).toBeNull();
    expect(result.issues.map(i => i.code)).toContain("invalid-stream");
  });

  it("reports malformed AF arrays", function () {
    const f = fixture();
    f.catalog.set("AF", Name.get("wrong"));
    expect(f.inspect().issues.map(i => i.code)).toContain(
      "invalid-associated-files"
    );
  });

  it("bounds entry traversal", function () {
    const f = fixture();
    f.tree.set(
      "Names",
      Array.from({ length: 600 }, () => ["a", f.specRef]).flat()
    );
    const result = f.inspect();
    expect(result.nameTreeEntries.length).toBe(512);
    expect(result.issues.map(i => i.code)).toContain("entry-limit");
  });

  it("bounds metadata bytes without returning a truncated XML as complete", function () {
    const f = fixture();
    f.catalog.set(
      "Metadata",
      f.register(
        7,
        new StringStream("x".repeat(2 * 1024 * 1024 + 1), f.dict({}))
      )
    );
    const result = f.inspect();
    expect(result.metadata.bytes).toBeNull();
    expect(result.issues.map(i => i.code)).toContain("byte-limit");
  });

  it("propagates missing-data requests for range loading", function () {
    const f = fixture();
    f.xref.fetch = () => {
      throw new MissingDataException(0, 100);
    };
    expect(f.inspect).toThrowError(MissingDataException);
  });

  it("reports xref recovery without suggesting comprehensive diagnostics", function () {
    const f = fixture();
    f.xref.inspectionState = {
      recoveryMode: true,
      xrefSectionsComplete: false,
    };
    expect(f.inspect().parser).toEqual({
      recoveryMode: true,
      xrefSectionsComplete: false,
      diagnosticsComplete: false,
    });
  });
});
