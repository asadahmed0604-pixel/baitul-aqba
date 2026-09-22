import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDates, parseReceipt, parseAmount, accountsMatch, weekOfMonth, weekRanges, addMonths,
} from '../public/shared/receipt-parser.js';
import { splitAmount, normalizeMonth } from '../src/payments.js';
import { parseCsv, toCsv } from '../src/csv.js';

test('parses common receipt date formats', () => {
  const iso = (t) => parseDates(t).map((d) => d.iso);
  assert.deepEqual(iso('Date: 05/09/2026'), ['2026-09-05']); // day first
  assert.deepEqual(iso('09/22/2026'), ['2026-09-22']); // unambiguous month first
  assert.deepEqual(iso('2026-09-03 14:22'), ['2026-09-03']);
  assert.deepEqual(iso('On 3rd September, 2026'), ['2026-09-03']);
  assert.deepEqual(iso('Sep 21, 2026'), ['2026-09-21']);
  assert.deepEqual(iso('22-Sep-26'), ['2026-09-22']);
  assert.deepEqual(iso('31/02/2026'), []);
});

test('extracts beneficiary, sender, amount and reference', () => {
  const r = parseReceipt(`HBL Mobile
Transfer successful
PKR 5,000
From Account: 1111 2222 3333 44
To
Bait-ul-Aqba Trust
Account Number
1234 5678 9012 34
Date & Time
22/09/2026 11:05
TID: 874512369`);
  assert.equal(r.beneficiaryName, 'Bait-ul-Aqba Trust');
  assert.equal(r.beneficiaryAccount, '12345678901234');
  assert.equal(r.senderAccount, '11112222333344');
  assert.equal(r.amount, 5000);
  assert.equal(r.transactionRef, '874512369');
  assert.equal(r.paymentDate, '2026-09-22');

  const w = parseReceipt('JazzCash\nRs 3000 sent to\nReceiver: ZAINAB BIBI 0300****567\nTrx ID 12345678901');
  assert.equal(w.beneficiaryName, 'ZAINAB BIBI');
  assert.equal(w.beneficiaryAccount, '0300****567');
  assert.equal(parseAmount('Total Amount: Rs. 12,500.50'), 12500.5);
});

test('account matching handles IBANs and masked numbers', () => {
  assert.ok(accountsMatch('PK36MEZN0001230104567890', '0001230104567890'));
  assert.ok(accountsMatch('PK36 MEZN 0001 2301 0456 7890', 'pk36mezn0001230104567890'));
  assert.ok(accountsMatch('****7890', 'PK36MEZN0001230104567890'));
  assert.ok(!accountsMatch('****7891', 'PK36MEZN0001230104567890'));
  assert.ok(!accountsMatch('12345', '99912345'));
});

test('month and week helpers', () => {
  assert.equal(addMonths('2026-11', 3), '2027-02');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(weekOfMonth('2026-09-07'), 1);
  assert.equal(weekOfMonth('2026-09-08'), 2);
  assert.equal(weekOfMonth('2026-09-30'), 5);
  assert.equal(weekRanges('2026-02').length, 4);
  assert.deepEqual(splitAmount(10000, 3), [3333.33, 3333.33, 3333.34]);
  assert.equal(normalizeMonth('Sep 2026'), '2026-09');
  assert.equal(normalizeMonth('9/2026'), '2026-09');
});

test('csv round trip and formula neutralising', () => {
  const out = toCsv([{ key: 'a', label: 'A' }, { key: 'b', label: 'B b' }], [{ a: 'x,"y"', b: '=HYPERLINK(1)' }, { a: '-5', b: 'line\nbreak' }]);
  const rows = parseCsv(out);
  assert.deepEqual(rows, [{ a: 'x,"y"', b_b: '=HYPERLINK(1)' }, { a: '-5', b_b: 'line\nbreak' }]);
  assert.match(out, /'=HYPERLINK/);
});
