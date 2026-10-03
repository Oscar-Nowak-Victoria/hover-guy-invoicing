import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupAbn, searchNames, parseJsonp } from '../src/abr.js';

process.env.ABR_GUID = 'test-guid';

const reply = (obj) => async (url) => {
  reply.last = String(url);
  return { ok: true, status: 200, text: async () => `c(${JSON.stringify(obj)})` };
};

test('parses JSONP', () => {
  assert.deepEqual(parseJsonp('c({"a":1})'), { a: 1 });
  assert.throws(() => parseJsonp('<html>'), /Unexpected reply/);
});

test('ABN details are normalised', async () => {
  const d = await lookupAbn('90 473 894 126', reply({
    Abn: '90473894126', AbnStatus: 'Active', AddressPostcode: '3350', AddressState: 'VIC',
    BusinessName: ['Hover Guy'], EntityName: 'NOWAK, OSCAR', EntityTypeName: 'Individual/Sole Trader', Gst: '2024-07-01', Message: '',
  }));
  assert.match(reply.last, /AbnDetails\.aspx\?abn=90473894126&callback=c&guid=test-guid/);
  assert.deepEqual(d, {
    abn: '90 473 894 126', active: true, status: 'Active', entityName: 'NOWAK, OSCAR', businessNames: ['Hover Guy'],
    entityType: 'Individual/Sole Trader', gstRegistered: true, gstFrom: '2024-07-01', state: 'VIC', postcode: '3350',
  });
});

test('not registered for GST and cancelled ABNs are flagged', async () => {
  const d = await lookupAbn('11111111111', reply({ Abn: '11111111111', AbnStatus: 'Cancelled', Gst: null, BusinessName: [], EntityName: 'X', Message: '' }));
  assert.equal(d.active, false);
  assert.equal(d.gstRegistered, false);
});

test('ABR error messages surface', async () => {
  await assert.rejects(lookupAbn('1', reply({ Message: 'Search text is not a valid ABN or ACN' })), /ABR: Search text is not a valid ABN/);
});

test('name search', async () => {
  const r = await searchNames('skyline survey', reply({ Message: '', Names: [{ Abn: '53004085616', Name: 'SKYLINE SURVEY PTY LTD', NameType: 'Entity Name', IsCurrent: true, State: 'VIC', Postcode: '3355', Score: 100 }] }));
  assert.match(reply.last, /MatchingNames\.aspx\?name=skyline\+survey&maxResults=10/);
  assert.deepEqual(r, [{ abn: '53 004 085 616', name: 'SKYLINE SURVEY PTY LTD', nameType: 'Entity Name', current: true, state: 'VIC', postcode: '3355' }]);
});

test('missing GUID gives a clear message', async () => {
  const g = process.env.ABR_GUID; delete process.env.ABR_GUID;
  await assert.rejects(lookupAbn('1', reply({})), /Add ABR_GUID/);
  process.env.ABR_GUID = g;
});
