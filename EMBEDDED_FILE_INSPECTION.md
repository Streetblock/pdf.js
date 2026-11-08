# Embedded-file inspection prototype

This Streetblock extension exposes document-level embedded-file evidence through
`PDFDocumentProxy.getEmbeddedFileInspection()`. It is a read-only inspection API,
**not a PDF/A, ZUGFeRD, Factur-X or EN 16931 validator**. No validity status is
returned. An empty `issues` array is not a conformity result.

Baseline: Mozilla PDF.js commit `58550d5b43b01e35154fc4aa15de5ff62602b4f3`.
Work branch: `feat/invoice-pdf-inspection`.
No production dependencies have been added. The fork uses the existing PDF.js
build and development dependencies. The ZUGFeRD Viewer has not been migrated.

## API

```js
const loadingTask = getDocument({
  data: originalPdfBytes.slice(),
  isEvalSupported: false,
});
try {
  const pdf = await loadingTask.promise;
  const evidence = await pdf.getEmbeddedFileInspection();
  // Apply version/profile-specific rules in the invoice validator, not here.
} finally {
  await loadingTask.destroy();
}
```

The API is additive: `getAttachments()`, `getAttachmentContent()` and
`getMetadata()` retain their existing behavior. Inspection does not re-save the
PDF and restores the position of every stream it reads. The caller should keep
or hash the original PDF bytes before transferring a copy to PDF.js's worker.

The version-1 result contains:

- `files`: distinct file-specification dictionaries with a local `id`, PDF `ref`,
  `/Type`, `/F`, `/UF`, `/AFRelationship`, and all present platform `/EF` mappings.
  Both `/F` and `/UF` streams are returned, including conflicting mappings.
- `nameTreeEntries`: entries in traversal order with key, raw file reference and
  `fileId`. Duplicate names are preserved. Consumers must check uniqueness,
  name-tree ordering and limits; this API does not certify the name tree.
- `associatedFiles`: document catalog `/AF` entries, retaining duplicate
  associations and references. `null` means no `/AF`; invalid structures produce
  an issue. Files present only in `/AF` are also inspected.
- `metadata`: the catalog XMP stream's reference, type, subtype and decoded bytes.
  XMP is not parsed, repaired or serialized. Malformed XML remains malformed.
- `issues`: stable codes and PDF paths for structures that could not be inspected,
  repeated/circular nodes, dangling links or exceeded traversal/byte limits.
- `parser`: `recoveryMode`, `xrefSectionsComplete`, and
  **`diagnosticsComplete: false`**. The first two flags expose xref state only;
  other parser tolerances and repairs are not comprehensively instrumented.
- `limits`: the fixed limits applied by this prototype.

Scalar fields use `{ type, value, ref }` so a PDF Name and a PDF String remain
distinguishable. Missing, null and incorrectly typed fields are retained. PDF
name escapes are decoded by the existing parser; filenames retain paths and
slashes. Inspection errors have `issues`, rather than silently becoming success.

Embedded streams contain their **decoded original bytes** after PDF stream
filters/decryption, including XML BOM, line endings and whitespace. These bytes
must be passed unchanged to the XML engine and hashed to bind its result to the
PDF. They are not the compressed stream bytes in the PDF file. Stream read
errors and limits never return a truncated byte array as a complete attachment.

## PDF/A file trailer evidence

The separate experimental PDFDocumentProxy.getPdfAFileInspection() method
returns the parser diagnostics and the effective trailer's typed ID and Encrypt
key evidence for PDF/A file rules. The ID array length and the type and byte
length of its first two elements are reported without disclosing their contents.
Indirect ID values remain unresolved. The trailer is null when the cross-
reference parse is incomplete or used recovery. Linearized files use the
first-page trailer selected by the existing PDF.js parser.

This method requires a loaded document. PDF.js rejects a password-protected
document without its password before the method can be called. Neither this
trailer snapshot nor a successful document load establishes PDF/A conformance.

## Limits and unimplemented checks

Traversal is capped at 256 name-tree nodes, depth 32, and 512 combined name-tree
and `/AF` entries. Per-stream limit: 20 MiB; XMP: 2 MiB; total decoded bytes:
32 MiB. Upstream decoder blocks may allocate beyond the requested output size:
these are inspection output limits, not a complete decompression memory sandbox.

This prototype covers the catalog's embedded-files name tree and catalog `/AF`.
Page-, annotation- and structure-level associations are outside this API's scope.
It reads the effective latest PDF revision; it is not a revision-history or
signature validator. Range-loading retries propagate to PDF.js, but have not yet
been exercised end-to-end. Encrypted files are not part of the verified corpus.

Still required before a conformity claim:

1. Format/version/profile-specific filename, MIME and relationship rules.
2. XML selection and SHA-256 binding in the shared invoice validation library.
3. Strict XMP parsing, PDF/A identification and invoice metadata/XML consistency.
4. More complete parser repair diagnostics and a broader real-world corpus.
5. Separate, full PDF/A-3 validation (fonts, colors, prohibited features,
   conformance-level requirements, etc.). Metadata identification is no proof.

## Reproduce tests

Install the existing dependencies with `npm ci`. No Java runtime is required by
the extension. Build the browser and Node variants:

```sh
npx gulp generic
npx gulp generic-legacy
```

Use `build/generic/build/pdf.mjs` in modern browsers and
`build/generic-legacy/build/pdf.mjs` in Node. Keep each build paired with its own
`pdf.worker.mjs`. The current upstream generic build requires newer JavaScript
features than Node 24.14 provides; the legacy build supplies the upstream
compatibility code. The Viewer's former Node >=20 promise has not been validated
for this fork.

Focused core tests (using the existing upstream core-js polyfills for direct
source imports on Node):

```sh
node --import core-js/actual/index.js node_modules/jasmine/bin/jasmine.js test/unit/embedded_file_inspection_spec.js test/unit/name_number_tree_spec.js test/unit/primitives_spec.js test/unit/stream_spec.js
```

The new Jasmine suite is also registered in the normal CLI and browser runners.

End-to-end synthetic PDF tests:

```sh
node --test test/embedded_file_inspection_test.mjs
```

Set `PDFJS_TEST_BROWSER` to an installed Chromium/Chrome executable to compare
Node against a real browser worker for every fixture. Without it, the browser
comparison is explicitly skipped. No browser download is required.

Set `PDFJS_REFERENCE_ADAPTER` to the existing ZUGFeRD Viewer's
`tools/mustang.mjs` for the optional Java/PDFBox attachment comparison. This
requires the adapter's pinned Mustang JAR and Java 17+. Only attachment filename,
MIME, relationship, association and decoded-byte SHA-256 are compared. Synthetic
fixtures are deliberately **not** complete PDF/A or EN 16931 invoices; agreement
on attachment evidence is not agreement on full document validity.

Cases include uncompressed files, Flate streams, a file specification inside a
compressed object stream with an xref stream, incremental attachment updates,
missing `/AF`, AF-only files, wrong MIME/type, duplicate filenames, conflicting
`/F` and `/UF`, malformed XMP, cyclic name trees and xref reconstruction.

## Verified prototype run

Windows, Node 24.14.0, Chrome 151.0.7922.176, pinned Mustang 2.26.0:

- Generic browser and generic-legacy Node builds completed.
- 89 focused Jasmine specs: zero failures, one existing OffscreenCanvas-dependent
  spec pending in Node. Includes all 15 new inspection specs.
- 14 end-to-end tests: all passed, including real browser-worker equality for
  all 12 fixtures and the optional Mustang/PDFBox comparison for six fixtures.
- Both input PDF hashes and decoded attachment hashes are checked in the tests.

This is targeted prototype verification, not the entire Mozilla regression suite
or a certification of PDF/A conformance. No viewer dependencies were changed.

Additional smoke check: the Node inspection API successfully extracted an XML
attachment with native `@napi-rs/canvas` loading explicitly disabled. Rendering
was not exercised; the inspection path needs no additional native graphics
library. Existing PDF.js dependencies and lockfile remain unchanged.

Current unminified API + worker build sizes (excluding source maps/assets):
modern browser 3,105,227 bytes (658,783 bytes summed gzip), Node legacy
3,502,383 bytes (738,489 bytes summed gzip). These are full PDF.js builds,
not yet a reduced parser-only distribution.

New source files retain Streetblock copyright under Apache 2.0. The upstream
license-header check accepts that holder as well as Mozilla Foundation.

The same result now carries an additive xref member with checks and counts.
It inspects the raw startxref target, classic subsection and fixed-width row
syntax (including PDF/A rule 6.1.4-2), type-1 object offsets, XRef stream
ranges and decoded lengths, primary Prev links, hybrid XRefStm links, and
compressed index membership in ObjStm headers. These checks cover the
footer-reachable chain, even if the renderer used recovery and could open the
document. They do not examine detached or unreachable revisions.

Statuses are pass, fail, unknown, or not-applicable for each check. The
PDF-XREF and PDF-OBJECT identifiers describe local structural checks, rather
than additional rule IDs from ISO 19005-3. Unknown includes unsupported
filters and indirect stream lengths, linearized layouts, unreadable data,
and exhausted inspection budgets. Structural decoding uses direct raw or
Flate stream bytes with optional bounded TIFF/PNG prediction. Limits include
a 20 MiB file, 128 primary revisions, 100,000 rows, 512 object streams,
2 MiB decoded per stream and 8 MiB decoded in total. No normalized output
replaces the original bytes. The result does not certify PDF/A conformance.

The version-1 file inspection result also contains an additive document
member with checks and counts. It inspects the effective catalog and page-tree
topology, annotation dictionary shape, PDF/A subtype and flags, appearance
presence and keys, and forbidden action entries and action types. Actions
are read from the catalog, page, annotation, JavaScript name tree, outline,
form-field and chained Next paths. No action is executed and script content
is not included in the report.

The graph uses raw PDF dictionary entries and verifies indirect references.
It is limited to 48 traversal levels and 16,384 visits. Results remain
unknown after cross-reference repair or if relevant objects or action paths
cannot be established. A known failure takes precedence over unknown
evidence from another path. This stage does not validate appearance streams,
inherited appearance states, all possible PDF extensions, or full PDF/A
conformance.

### PDF/A-3 embedded files and metadata-only evidence

The version-1 file inspection result includes an optional `embeddedFiles`
group of bounded checks for PDF 1.7 file specification and stream dictionaries
and PDF/A-3 rules 6.8-1 through 6.8-4. It does not read or return attachment
contents. A catalog, page, annotation, structure element, image or Form
XObject may supply an association. The EmbeddedFiles name tree alone supplies
discovery, but not an association. Missing associations stay open if damaged
references, traversal limits or uninspected content could hide another path.
Unsupported marked-content and resource paths remain outside this partial
inspection. There is no verdict about modification dates or exhaustive
name-tree coverage. Non-predefined AFRelationship names remain open.

`getEmbeddedFileInspection({ metadataOnly: true })` preserves the existing
evidence format and reads only the original decoded XMP metadata stream.
Attachment and association arrays are left empty in this mode.
