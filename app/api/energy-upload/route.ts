import { NextResponse } from 'next/server';
import { createAccumulator, createNveFileParser, summarize } from '@/lib/nveImport';
import { holdUpload } from '@/lib/nveUploadStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Step 1 of the NV Energy import: parse the uploaded CSVs in memory and return
// a preview. Nothing is written anywhere; the parsed rows wait in memory for
// POST /api/energy-upload/confirm. CSV only (no ZIP reader in this project).
// Like the other routes here it has no auth of its own: the deployment is LAN-only.
const MAX_BYTES = 80 * 1024 * 1024;

export async function POST(req: Request) {
  let form: FormData;
  try { form = await req.formData(); }
  catch { return NextResponse.json({ error: 'Send the files as multipart form data.' }, { status: 400 }); }
  const files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
  if (!files.length) return NextResponse.json({ error: 'Choose at least one NV Energy CSV file.' }, { status: 400 });
  if (files.reduce((n, f) => n + f.size, 0) > MAX_BYTES) {
    return NextResponse.json({ error: 'Files are too large (80 MB total).' }, { status: 413 });
  }
  const acc = createAccumulator();
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      return NextResponse.json({ error: 'ZIP files are not supported. Unzip it and choose the CSV files.' }, { status: 400 });
    }
    try {
      const parser = createNveFileParser(acc);
      const decoder = new TextDecoder();
      const reader = file.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.end();
    } catch (e) {
      // The message comes from our own parser and quotes only a time string, never a row.
      return NextResponse.json({ error: `${file.name}: ${e instanceof Error ? e.message : 'could not read file'}` }, { status: 422 });
    }
  }
  return NextResponse.json({ token: holdUpload(acc), summary: summarize(acc) });
}
