/**
 * Writes fixtures/inv-16-summit-pdf.pdf: a real, valid single-page PDF 1.4
 * (Helvetica text, correct xref offsets) - no dependencies.
 * Run: npx tsx invoice-extract/fixtures/makePdf.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const PDF_LINES = [
  'SUMMIT IT SERVICES',
  '2200 Mountain View Rd, Denver, CO 80202',
  '',
  'INVOICE  SIT-5520',
  'Invoice date: 2026-03-25      Terms: Net 30      Due: 2026-04-24',
  'Bill to: Northwind Traders LLC',
  '',
  'Description                         Qty     Unit        Amount',
  'Laptop setup and imaging              3    $75.00      $225.00',
  'Network cable Cat6 (5m)              10     $8.90       $89.00',
  '',
  'Subtotal                                              $314.00',
  'Sales tax 8%                                           $25.12',
  'TOTAL DUE (USD)                                       $339.12',
];

function esc(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdf(lines: string[]): Buffer {
  const content = ['BT', '/F1 10 Tf', '14 TL', '50 780 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'inv-16-summit-pdf.pdf');
  writeFileSync(file, buildPdf(PDF_LINES));
  console.log('wrote', file);
}
