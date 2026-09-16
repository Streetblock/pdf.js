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
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { getDocument } from "../build/generic-legacy/build/pdf.mjs";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const XML =
  '\xef\xbb\xbf<?xml version="1.0"?><Invoice>\r\n  <Amount>11804.80</Amount>\r\n</Invoice>\r\n';
const XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="3" pdfaid:conformance="B"/></rdf:RDF></x:xmpmeta>';
const bytes = text => Uint8Array.from(Buffer.from(text, "latin1"));
const hash = value => createHash("sha256").update(value).digest("hex");

// Byte-accurate, synthetic test PDFs; no invoice or font/rendering dependency.
function fixture(options = {}) {
  const stream = (data, dict) => {
    if (options.compressed) {
      data = deflateSync(Buffer.from(data, "latin1")).toString("latin1");
      dict += " /Filter /FlateDecode";
    }
    return `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
  };
  const spec = `<< /Type /Filespec /F (factur-x.xml) /UF (factur-x.xml) /AFRelationship ${options.wrongRelationship ? "(Alternative)" : "/Alternative"} /EF << /F 5 0 R /UF ${options.conflictingStreams ? 9 : 5} 0 R >> >>`;
  const catalog = `<< /Type /Catalog /Pages 2 0 R ${options.afOnly ? "" : "/Names << /EmbeddedFiles 7 0 R >>"} ${options.missingAF ? "" : "/AF [4 0 R]"} /Metadata 6 0 R >>`;
  const objects = new Map([
    [1, options.incremental ? "<< /Type /Catalog /Pages 2 0 R >>" : catalog],
    [2, "<< /Type /Pages /Count 1 /Kids [3 0 R] >>"],
    [
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>",
    ],
    [4, spec],
    [
      5,
      stream(
        XML,
        `/Type /EmbeddedFile /Subtype /${options.wrongMime ? "text#2fplain" : "application#2fxml"}`
      ),
    ],
    [
      6,
      stream(
        options.brokenXMP ? "<x:broken>" : XMP,
        "/Type /Metadata /Subtype /XML"
      ),
    ],
    [
      7,
      options.cycle
        ? "<< /Kids [7 0 R] >>"
        : `<< /Names [(factur-x.xml) 4 0 R ${options.duplicate ? "(factur-x.xml) 8 0 R" : ""}] >>`,
    ],
  ]);
  if (options.duplicate) {
    objects.set(8, spec);
  }
  if (options.conflictingStreams) {
    objects.set(
      9,
      stream("<Other/>", "/Type /EmbeddedFile /Subtype /text#2fxml")
    );
  }
  if (options.objectStream) {
    objects.delete(4);
    objects.set(10, stream(`4 0 ${spec}`, "/Type /ObjStm /N 1 /First 4"));
  }
  let pdf = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets = new Map();
  function append(number, body) {
    offsets.set(number, pdf.length);
    pdf += `${number} 0 obj\n${body}\nendobj\n`;
  }
  for (const [number, body] of objects) {
    append(number, body);
  }
  let xref = pdf.length;
  if (options.objectStream) {
    const entries = Buffer.alloc(12 * 7);
    for (let i = 0; i < 12; i++) {
      let type = 0,
        offset = offsets.get(i) || 0;
      if (i === 4) {
        type = 2;
        offset = 10;
      } else if (i === 11) {
        type = 1;
        offset = xref;
      } else if (offsets.has(i)) {
        type = 1;
      }
      entries[i * 7] = type;
      entries.writeUInt32BE(offset, i * 7 + 1);
      entries.writeUInt16BE(i === 0 ? 65535 : 0, i * 7 + 5);
    }
    append(
      11,
      stream(
        entries.toString("latin1"),
        "/Type /XRef /Size 12 /Root 1 0 R /W [1 4 2]"
      )
    );
  } else {
    const size = Math.max(...objects.keys()) + 1;
    pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) {
      pdf += `${String(offsets.get(i) || 0).padStart(10, "0")} 00000 ${offsets.has(i) ? "n" : "f"} \n`;
    }
    pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\n`;
  }
  pdf += `startxref\n${options.recovery ? 1 : xref}\n%%EOF\n`;
  if (options.incremental) {
    append(1, catalog);
    append(
      5,
      stream(
        XML.replace("11804.80", "99999.99"),
        "/Type /EmbeddedFile /Subtype /application#2fxml"
      )
    );
    const previous = xref;
    xref = pdf.length;
    pdf += `xref\n1 1\n${String(offsets.get(1)).padStart(10, "0")} 00000 n \n5 1\n${String(offsets.get(5)).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 8 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${xref}\n%%EOF\n`;
  }
  return bytes(pdf);
}

const cases = [
  ["plain", {}],
  [
    "compressed streams and file specification in object stream",
    { compressed: true, objectStream: true },
  ],
  ["incremental attachment update", { incremental: true, compressed: true }],
  ["missing document association", { missingAF: true }],
  ["AF-only attachment", { afOnly: true }],
  ["wrong MIME", { wrongMime: true }],
  ["wrong relationship type", { wrongRelationship: true }],
  ["duplicate filename", { duplicate: true }],
  ["conflicting EF mappings", { conflictingStreams: true }],
  ["malformed XMP", { brokenXMP: true }],
  ["circular name tree", { cycle: true }],
  ["recovered cross-reference table", { recovery: true }],
];
const results = new Map();
const normalize = value =>
  JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array ? Array.from(v) : v
    )
  );

for (const [name, options] of cases) {
  test(name, async () => {
    const data = fixture(options);
    const originalHash = hash(data);
    const task = getDocument({ data: data.slice(), isEvalSupported: false });
    try {
      const doc = await task.promise;
      const result = await doc.getEmbeddedFileInspection();
      results.set(name, normalize(result));
      assert.equal(result.version, 1);
      assert.equal(result.parser.diagnosticsComplete, false);
      assert.equal(result.parser.recoveryMode, !!options.recovery);
      const expectedXML = options.incremental
        ? XML.replace("11804.80", "99999.99")
        : XML;
      assert.equal(
        hash(result.files[0].embeddedFiles[0].stream.bytes),
        hash(bytes(expectedXML))
      );
      assert.equal(hash(data), originalHash);
      assert.equal(hash(await doc.getData()), originalHash);
      assert.equal(result.files.length, options.duplicate ? 2 : 1);
      assert.equal(result.nameTreePresent, !options.afOnly);
      if (options.missingAF) {
        assert.equal(result.associatedFiles, null);
      } else {
        assert.equal(result.associatedFiles[0].fileId, result.files[0].id);
      }
      assert.equal(
        result.files[0].relationship.type,
        options.wrongRelationship ? "string" : "name"
      );
      assert.equal(
        result.files[0].embeddedFiles[0].stream.subtype.value,
        options.wrongMime ? "text/plain" : "application/xml"
      );
      assert.equal(
        new TextDecoder().decode(result.metadata.bytes),
        options.brokenXMP ? "<x:broken>" : XMP
      );
      if (options.cycle) {
        assert.ok(
          result.issues.some(i => i.code === "repeated-name-tree-node")
        );
      } else {
        assert.deepEqual(result.issues, []);
      }
      if (options.duplicate) {
        assert.equal(result.nameTreeEntries.length, 2);
      }
      if (options.conflictingStreams) {
        assert.notEqual(
          hash(result.files[0].embeddedFiles[0].stream.bytes),
          hash(result.files[0].embeddedFiles[1].stream.bytes)
        );
      }
      // Inspection must not consume attachment streams.
      if (!options.afOnly && !options.cycle) {
        const attachments = await doc.getAttachments();
        assert.equal(
          hash(await doc.getAttachmentContent("factur-x.xml")),
          hash(bytes(options.conflictingStreams ? "<Other/>" : expectedXML))
        );
        assert.ok(attachments.has("factur-x.xml"));
      }
      await doc.getMetadata();
      const again = await doc.getEmbeddedFileInspection();
      assert.deepEqual(normalize(again), normalize(result));
    } finally {
      await task.destroy();
    }
  });
}

test(
  "browser worker and Node return identical evidence",
  { skip: !process.env.PDFJS_TEST_BROWSER },
  async () => {
    const { default: puppeteer } = await import("puppeteer");
    const server = createServer(async (request, response) => {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><title>PDF inspection test</title>");
      } else if (["/pdf.mjs", "/pdf.worker.mjs"].includes(request.url)) {
        response.setHeader("Content-Type", "text/javascript");
        response.end(
          await readFile(
            new URL(`../build/generic/build${request.url}`, import.meta.url)
          )
        );
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise(resolve => {
      server.listen(0, "127.0.0.1", resolve);
    });
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: process.env.PDFJS_TEST_BROWSER,
        headless: true,
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const browserResults = await page.evaluate(
        async inputs => {
          // Fixed module URL served by the local test server.
          // eslint-disable-next-line no-unsanitized/method
          const { getDocument: load, GlobalWorkerOptions } = await import(
            new URL("/pdf.mjs", location.href).href
          );
          GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
          const output = [];
          for (const [name, data] of inputs) {
            const task = load({
              data: new Uint8Array(data),
              isEvalSupported: false,
            });
            try {
              const doc = await task.promise;
              const evidence = await doc.getEmbeddedFileInspection();
              output.push([
                name,
                JSON.parse(
                  JSON.stringify(evidence, (_key, v) =>
                    v instanceof Uint8Array ? Array.from(v) : v
                  )
                ),
              ]);
            } finally {
              await task.destroy();
            }
          }
          return output;
        },
        cases.map(([name, options]) => [name, Array.from(fixture(options))])
      );
      assert.equal(browserResults.length, cases.length);
      for (const [name, result] of browserResults) {
        assert.deepEqual(result, results.get(name), name);
      }
    } finally {
      await browser?.close();
      await new Promise(resolve => {
        server.close(resolve);
      });
    }
  }
);

test(
  "optional Mustang/PDFBox attachment reference",
  { skip: !process.env.PDFJS_REFERENCE_ADAPTER },
  async () => {
    // Trusted developer-selected adapter path; never taken from a PDF.
    // eslint-disable-next-line no-unsanitized/method
    const { checkValidator, validate } = await import(
      pathToFileURL(process.env.PDFJS_REFERENCE_ADAPTER).href
    );
    assert.ok(
      await checkValidator(),
      "Pinned Mustang JAR and Java 17+ required"
    );
    const selected = cases.filter(
      ([_name, options]) =>
        !options.duplicate &&
        !options.conflictingStreams &&
        !options.cycle &&
        !options.recovery &&
        !options.brokenXMP &&
        !options.wrongRelationship
    );
    for (const [name, options] of selected) {
      const reference = await validate(fixture(options), "pdf");
      const actual = results.get(name);
      assert.ok(actual, name);
      const associated = new Set(
        actual.associatedFiles?.map(a => a.fileId) || []
      );
      const attachments = actual.files.map(f => {
        const stream = (
          f.embeddedFiles.find(e => e.key === "UF") ||
          f.embeddedFiles.find(e => e.key === "F")
        ).stream;
        return {
          filename: f.unicodeFilename.value || f.filename.value,
          mime: stream.subtype.value,
          relationship: f.relationship.value,
          associated: associated.has(f.id),
          sha256: hash(new Uint8Array(stream.bytes)),
        };
      });
      assert.deepEqual(attachments, reference.attachments, name);
    }
  }
);
