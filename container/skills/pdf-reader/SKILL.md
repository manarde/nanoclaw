# PDF Reader

Read and extract text from PDF files using `pdftotext` (poppler-utils).

## Usage

### Extract text from a local PDF
```bash
pdftotext "sources/document.pdf" -  # outputs to stdout
pdftotext "sources/document.pdf" "sources/document.txt"  # outputs to file
```

### Get PDF metadata
```bash
pdfinfo "sources/document.pdf"
```

### Fetch and read a PDF from URL
```bash
curl -sLo sources/document.pdf "<url>"
pdftotext sources/document.pdf -
```

## Notes

- `pdftotext` handles text-based PDFs. Scanned/image-based PDFs will produce empty output — use image vision instead.
- For layout-sensitive documents (tables, columns), use `-layout` flag: `pdftotext -layout file.pdf -`
- Always save PDFs to `sources/` before extracting so the raw source is preserved.
