// Australian Business Register (ABN Lookup) JSON web services.
// Needs the GUID the ABR issues, in the ABR_GUID environment variable.
// Docs: https://abr.business.gov.au/Tools/WebServices
const BASE = process.env.ABR_BASE || 'https://abr.business.gov.au/json';

export const abrConfigured = () => Boolean(process.env.ABR_GUID);

// The JSON services answer as JSONP: callback({...}). Strip the wrapper.
export function parseJsonp(text) {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end < start) throw new Error('Unexpected reply from the ABR');
  return JSON.parse(text.slice(start + 1, end));
}

async function call(path, params, fetchImpl = fetch) {
  if (!abrConfigured()) throw new Error('ABR lookup is not set up. Add ABR_GUID in Railway Variables.');
  const qs = new URLSearchParams({ ...params, callback: 'c', guid: process.env.ABR_GUID });
  const res = await fetchImpl(`${BASE}/${path}?${qs}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`The ABR didn't respond (HTTP ${res.status}). Try again shortly.`);
  const data = parseJsonp(await res.text());
  if (data.Message) throw new Error(`ABR: ${data.Message}`);
  return data;
}

const formatAbn = (abn) => String(abn).replace(/\D/g, '').replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');

export async function lookupAbn(abn, fetchImpl) {
  const d = await call('AbnDetails.aspx', { abn: String(abn).replace(/\D/g, '') }, fetchImpl);
  const businessNames = Array.isArray(d.BusinessName) ? d.BusinessName.filter(Boolean) : [];
  return {
    abn: formatAbn(d.Abn),
    active: d.AbnStatus === 'Active',
    status: d.AbnStatus || '',
    entityName: d.EntityName || '',
    businessNames,
    entityType: d.EntityTypeName || '',
    gstRegistered: Boolean(d.Gst),
    gstFrom: d.Gst || null,
    state: d.AddressState || '',
    postcode: d.AddressPostcode || '',
  };
}

export async function searchNames(name, fetchImpl) {
  const d = await call('MatchingNames.aspx', { name, maxResults: '10' }, fetchImpl);
  return (d.Names ?? []).map((n) => ({
    abn: formatAbn(n.Abn),
    name: n.Name || '',
    nameType: n.NameType || '',
    current: n.IsCurrent !== false,
    state: n.State || '',
    postcode: n.Postcode || '',
  }));
}
