// Cloudflare Worker — BIN lookup proxy
// Deploys to: https://bin-lookup.<your-subdomain>.workers.dev
// Only proxies BIN lookups to pk.uchet.kz and e-Qazyna. No data stored.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const bin = url.searchParams.get('bin');

    if (!bin || !/^\d{12}$/.test(bin)) {
      return jsonResponse({ error: 'Invalid BIN. Must be 12 digits.' }, 400);
    }

    // Run both lookups in parallel
    const [addressResult, govResult] = await Promise.allSettled([
      fetchAddress(bin),
      fetchGovParticipation(bin),
    ]);

    const result = {
      bin,
      address: addressResult.status === 'fulfilled' ? addressResult.value : null,
      gov: govResult.status === 'fulfilled' ? govResult.value : null,
    };

    return jsonResponse(result, 200);
  },
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ===== pk.uchet.kz — address lookup =====
async function fetchAddress(bin) {
  const resp = await fetch('https://pk.uchet.kz/api/web/company/search/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Referer': 'https://pk.uchet.kz/',
    },
    body: JSON.stringify({ page: '1', size: 10, value: bin }),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  const companies = data.data || data.results || data || [];
  const list = Array.isArray(companies) ? companies : [companies];
  const company = list.find(c => c.bin === bin);

  if (!company) return null;

  return {
    name: company.name || null,
    address: company.address || null,
    head: company.head_fullname || null,
    status: company.status || null,
  };
}

// ===== e-Qazyna — gov participation lookup =====
async function fetchGovParticipation(bin) {
  const EQAZYNA_URL = 'https://gr5.e-qazyna.kz/p/ru/gr-search/search-objects';

  // Step 1: GET page to obtain CSRF token and cookies
  const pageResp = await fetch(EQAZYNA_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  if (!pageResp.ok) return null;

  const pageHtml = await pageResp.text();

  // Extract CSRF token
  const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/);
  if (!tokenMatch) return null;
  const token = tokenMatch[1];

  // Extract cookies from response
  const cookies = pageResp.headers.getAll ? pageResp.headers.getAll('set-cookie') : [];
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

  // Step 2: Build search query XML
  const queryXml = `<LogicGroup GroupOperatorValue="And" GroupOperatorText="И" ><Condition IsStaticCondition="True" FieldName="tbGrObjects_flBin" FieldText="БИН" ConditionOperatorValue="StartWith" ConditionOperatorText="Начинается с" Value="${bin}" ValueText="${bin}" /><Condition IsStaticCondition="True" FieldName="tbGrObjects_flNameRu" FieldText="Наименование (рус. яз)" ConditionOperatorValue="ContainsWord" ConditionOperatorText="Содержит фразу" Value="" ValueText="[Не задано]" /><Condition IsStaticCondition="True" FieldName="tbGrObjects_flOpf" FieldText="ОПФ" ConditionOperatorValue="In" ConditionOperatorText="Входит в" Value="" ValueText="[Не задано]" /><Condition IsStaticCondition="True" FieldName="tbGrObjects_flKfsL2" FieldText="КФС (уровень 3)" ConditionOperatorValue="In" ConditionOperatorText="Входит в" Value="" ValueText="[Не задано]" /><Condition IsStaticCondition="True" FieldName="tbGrObjects_flKfsL4" FieldText="КФС" ConditionOperatorValue="In" ConditionOperatorText="Входит в" Value="" ValueText="[Не задано]" /><Condition IsStaticCondition="True" FieldName="tbGrObjects_flBlock" FieldText="Блокировка" ConditionOperatorValue="In" ConditionOperatorText="Входит в" Value="CONS,CROT,FREE,LIKV,REAB,REST,SELL,SPLT,TOAO,TOGP,TOKS,TOND,TORS,TOTO,ZALG" ValueText="Слияние; Банкротство; Свободно; Ликвидация; Реабилитация; Остаток; Продан и неоформлена продажа; Сегментация; Акционирование; Преобразование в гп; Перевод в коммунальную собственность; Перевод в номинальное держание; Перевод в республиканскую собственность; Преобразование в тоо; Залоговый фонд" /><Condition IsStaticCondition="True" FieldName="contacts_flAdrReg" FieldText="Регион" ConditionOperatorValue="In" ConditionOperatorText="Входит в" Value="" ValueText="[Не задано]" /></LogicGroup>`;

  // Step 3: Build multipart form body
  const boundary = '----WebKitFormBoundary' + Date.now();
  const fields = {
    '__RequestVerificationToken': token,
    'yoda_form_id': 'GrObjectsnode-search-objects-form',
    'query-structure-search-GrObjectsHeadRevisions': queryXml,
    'search-GrObjectsHeadRevisionstextEditor': bin,
    'search-GrObjectsHeadRevisions-intEditor': '',
    'search-GrObjectsHeadRevisions-longEditor': '',
    'search-GrObjectsHeadRevisions-moneyEditor': '',
    'search-GrObjectsHeadRevisionsdate-datebox': '',
    'search-GrObjectsHeadRevisionsdatetime-datetimebox': '',
    'search-GrObjectsHeadRevisionsrangeDate-from-datebox': '',
    'search-GrObjectsHeadRevisionsrangeDate-to-datebox': '',
    'search-GrObjectsHeadRevisionsrangeDateTime-from-datetimebox': '',
    'search-GrObjectsHeadRevisionsrangeDateTime-to-datetimebox': '',
    'search-GrObjectsHeadRevisions_from_IntRangeFilterEditor': '',
    'search-GrObjectsHeadRevisions_to_IntRangeFilterEditor': '',
    'search-GrObjectsHeadRevisions_from_LongRangeFilterEditor': '',
    'search-GrObjectsHeadRevisions_to_LongRangeFilterEditor': '',
    'search-GrObjectsHeadRevisions_from_MoneyRangeFilterEditor': '',
    'search-GrObjectsHeadRevisions_to_MoneyRangeFilterEditor': '',
    'search-GrObjectsHeadRevisions-text-list-list': '',
    'pager-page-index_search-GrObjectsHeadRevisions': '0',
    'search-search-GrObjectsHeadRevisions': 'Поиск',
  };

  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  // Step 4: POST search
  const searchResp = await fetch(EQAZYNA_URL, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Origin': 'https://gr5.e-qazyna.kz',
      'Referer': EQAZYNA_URL,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Cookie': cookieHeader,
    },
    body,
    redirect: 'follow',
  });

  if (!searchResp.ok) return null;

  const resultHtml = await searchResp.text();

  // Step 5: Parse results
  const totalMatch = resultHtml.match(/pager-total-rows[^>]*>(\d+)</);
  if (!totalMatch || totalMatch[1] === '0') {
    return { found: false, share: null, name: null, status: null };
  }

  // Parse table rows
  const tableMatch = resultHtml.match(/<table[^>]*id="search-GrObjectsHeadRevisions"[\s\S]*?<\/table>/);
  if (!tableMatch) {
    return { found: true, share: null, name: null, status: null };
  }

  // Find row matching our BIN
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;
  let match;
  while ((match = rowRegex.exec(tableMatch[0])) !== null) {
    const row = match[0];
    if (!row.includes(bin)) continue;

    // Extract all td contents
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(row)) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]*>/g, '').trim());
    }

    if (cells.length >= 9) {
      const name = decodeHtmlEntities(cells[2] || '');
      const share = cells[7] || '';
      const status = cells[8] || '';
      return { found: true, share: share ? share + '%' : null, name, status };
    }
  }

  return { found: true, share: null, name: null, status: null };
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}
