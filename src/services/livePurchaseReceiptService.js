const crypto = require('node:crypto');
const { supabaseAdmin } = require('../config/supabaseAdmin');

const RECEIPT_BUCKET = 'live-purchase-receipts';

function pdfEscape(value) {
  return String(value == null ? '' : value)
    .replace(/₦/g, 'NGN ')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function createReceiptPdf({
  receiptNumber,
  reference,
  packageId,
  sparks,
  amountMinor,
  currency,
  paymentDate,
  paymentChannel,
}) {
  const amount = (Number(amountMinor) / 100).toFixed(2);
  const date = new Date(paymentDate);
  const dateText = Number.isFinite(date.getTime()) ? date.toISOString() : 'Not available';
  const lines = [
    { text: 'ZannyChat LIVE Purchase Receipt', size: 18 },
    { text: 'Receipt Number: ' + receiptNumber, size: 11 },
    { text: 'Payment Status: PAID', size: 11 },
    { text: 'Transaction Reference: ' + reference, size: 11 },
    { text: 'Product: LIVE Sparks', size: 11 },
    { text: 'Package: ' + packageId, size: 11 },
    { text: 'Sparks Purchased: ' + Number(sparks).toLocaleString('en-US'), size: 11 },
    { text: 'Amount Paid: ' + currency + ' ' + amount, size: 11 },
    { text: 'Payment Channel: ' + (paymentChannel || 'Paystack'), size: 11 },
    { text: 'Payment Date: ' + dateText, size: 11 },
    { text: 'This receipt confirms a verified digital Sparks purchase.', size: 10 },
    { text: 'Sparks are in-app digital credits and are not cash or directly withdrawable.', size: 9 },
  ];

  const commands = ['BT'];
  let y = 790;
  for (const line of lines) {
    commands.push('/F1 ' + line.size + ' Tf');
    commands.push('1 0 0 1 50 ' + y + ' Tm');
    commands.push('(' + pdfEscape(line.text) + ') Tj');
    y -= line.size >= 18 ? 34 : 24;
  }
  commands.push('ET');
  const stream = Buffer.from(commands.join('\n'), 'ascii');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream.toString('ascii') + '\nendstream',
  ];

  const parts = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets = [0];
  let byteLength = parts[0].length;
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(byteLength);
    const part = Buffer.from((i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n', 'ascii');
    parts.push(part);
    byteLength += part.length;
  }
  const xrefOffset = byteLength;
  let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const trailer = 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF';
  parts.push(Buffer.from(xref + trailer, 'ascii'));
  return Buffer.concat(parts);
}

async function ensureLivePurchaseReceipt(reference, transaction) {
  if (!reference || transaction?.reference !== reference || transaction?.status !== 'success') {
    throw new Error('Receipt requires an independently verified successful transaction');
  }
  const { data: purchase, error: purchaseError } = await supabaseAdmin
    .from('live_spark_purchases')
    .select('id,package_id,sparks,amount_minor,currency,status,provider_reference,verified_at,created_at')
    .eq('provider_reference', reference)
    .maybeSingle();
  if (purchaseError) throw purchaseError;
  if (!purchase || purchase.status !== 'paid') throw new Error('Paid LIVE Sparks purchase was not found for receipt generation');
  if (Number(transaction.amount) !== Number(purchase.amount_minor)
      || String(transaction.currency || '').toUpperCase() !== String(purchase.currency).toUpperCase()) {
    throw new Error('Receipt transaction amount or currency does not match the purchase');
  }

  const receiptNumber = 'ZC-LIVE-' + purchase.id.replace(/-/g, '').slice(0, 12).toUpperCase();
  const storagePath = purchase.id + '.pdf';
  const pdf = createReceiptPdf({
    receiptNumber,
    reference,
    packageId: purchase.package_id,
    sparks: purchase.sparks,
    amountMinor: purchase.amount_minor,
    currency: purchase.currency,
    paymentDate: transaction.paid_at || transaction.paidAt || purchase.verified_at || purchase.created_at,
    paymentChannel: transaction.channel || 'Paystack',
  });
  const fileSha256 = crypto.createHash('sha256').update(pdf).digest('hex');

  const { error: uploadError } = await supabaseAdmin.storage.from(RECEIPT_BUCKET)
    .upload(storagePath, pdf, {
      contentType: 'application/pdf',
      cacheControl: '3600',
      upsert: true,
    });
  if (uploadError) throw uploadError;

  const { error: receiptError } = await supabaseAdmin.from('live_spark_purchase_receipts')
    .upsert({
      purchase_id: purchase.id,
      receipt_number: receiptNumber,
      storage_path: storagePath,
      file_sha256: fileSha256,
      mime_type: 'application/pdf',
    }, { onConflict: 'purchase_id' });
  if (receiptError) throw receiptError;

  return { purchaseId: purchase.id, receiptNumber, storagePath, fileSha256 };
}

module.exports = { createReceiptPdf, ensureLivePurchaseReceipt, RECEIPT_BUCKET };
