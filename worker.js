export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/history') {
      return handleHistory(url, env);
    }

    if (url.pathname === '/api/company') {
      return handleCompany(url, env);
    }

    if (url.pathname === '/api/stocks') {
      const symbols = url.searchParams.get('symbols');
      if (!symbols) {
        return jsonResponse({ error: 'symbols required' }, 400);
      }

      const tickers = [...new Set(
        symbols
          .split(',')
          .map(symbol => symbol.trim().toUpperCase())
          .filter(symbol => /^[A-Z0-9.^-]{1,12}$/.test(symbol))
      )].slice(0, 30);

      if (!tickers.length) {
        return jsonResponse({ error: 'no valid symbols' }, 400);
      }

      let result = await withTimeout(fetchTradingViewQuotes(tickers), 4000, []);

      if (!result.length) {
        const settled = await mapWithConcurrency(
          tickers,
          4,
          symbol => withTimeout(fetchStockQuote(symbol, env), 3500, null)
        );
        result = settled.filter(Boolean);
      }
      const returnedSymbols = new Set(result.map(quote => quote.symbol));
      const failedSymbols = tickers.filter(symbol => !returnedSymbols.has(symbol));

      if (!result.length) {
        return jsonResponse(
          { error: 'stock provider unavailable', failedSymbols },
          502,
          { 'Cache-Control': 'no-store' }
        );
      }

      return new Response(
        JSON.stringify({
          quoteResponse: { result },
          failedSymbols,
          fetchedAt: new Date().toISOString(),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=30',
          },
        }
      );
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleHistory(url, env) {
  const symbols = parseSymbols(url.searchParams.get('symbols'), 10);
  if (!symbols.length) return jsonResponse({ error: 'symbols required' }, 400);

  const results = await mapWithConcurrency(symbols, 3, async symbol => {
    const points = await fetchYahooHistory(symbol);
    return { symbol, points };
  });

  const history = {};
  const failedSymbols = [];
  for (const { symbol, points } of results) {
    history[symbol] = points;
    if (!points.length) failedSymbols.push(symbol);
  }

  return jsonResponse(
    { history, failedSymbols },
    failedSymbols.length === symbols.length ? 502 : 200,
    { 'Cache-Control': 'public, max-age=1800' }
  );
}

async function fetchYahooHistory(symbol) {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
      '?interval=1d&range=1mo&includePrePost=false';
    const data = await withTimeout(
      fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        .then(r => r.ok ? r.json() : null).catch(() => null),
      6000, null
    );
    const result = data?.chart?.result?.[0];
    if (!result) continue;
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points = timestamps
      .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter(p => Number.isFinite(p.close));
    if (points.length) return points;
  }
  return fetchStooqHistory(symbol);
}

async function fetchStooqHistory(symbol) {
  const stooqSymbol = `${symbol.toLowerCase()}.us`;
  const csv = await withTimeout(
    fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).then(r => r.ok ? r.text() : null).catch(() => null),
    8000, null
  );
  if (!csv) return [];
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const cutoff = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return lines.slice(1)
    .map(line => {
      const [date, , , , close] = line.split(',');
      return { date: date?.trim(), close: Number(close?.trim()) };
    })
    .filter(p => p.date >= cutoff && Number.isFinite(p.close) && p.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function handleCompany(url, env) {
  const [symbol] = parseSymbols(url.searchParams.get('symbol'), 1);
  if (!symbol) return jsonResponse({ error: 'valid symbol required' }, 400);
  if (!env.ALPHA_VANTAGE_API_KEY) {
    return jsonResponse({ error: 'Alpha Vantage API key is not configured' }, 503);
  }

  const key = env.ALPHA_VANTAGE_API_KEY;
  const [overview, cik] = await Promise.all([
    fetchAlpha('OVERVIEW', { symbol }, key),
    lookupEdgarCIK(symbol),
  ]);

  const overviewError = overview?.Information || overview?.Note;
  if (overviewError && !overview?.Symbol) {
    return jsonResponse({ error: overviewError }, 429, { 'Cache-Control': 'no-store' });
  }

  const submissions = cik ? await fetchEdgarSubmissions(cik) : null;
  const normalizedOverview = normalizeOverview(overview);
  if (normalizedOverview && submissions) {
    normalizedOverview.Website = submissions.website || submissions.investorWebsite || null;
  }

  return jsonResponse(
    {
      symbol,
      overview: normalizedOverview,
      history: [],
      news: [],
    },
    200,
    { 'Cache-Control': 'public, max-age=3600' }
  );
}

function parseSymbols(value, limit) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map(symbol => symbol.trim().toUpperCase())
      .filter(symbol => /^[A-Z0-9.^-]{1,12}$/.test(symbol))
  )].slice(0, limit);
}

async function fetchAlphaHistory(symbol, key) {
  const data = await fetchAlpha('TIME_SERIES_DAILY', {
    symbol,
    outputsize: 'compact',
  }, key);
  const series = data?.['Time Series (Daily)'] || {};
  return Object.entries(series)
    .map(([date, values]) => ({ date, close: Number(values['4. close']) }))
    .filter(point => Number.isFinite(point.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);
}

async function fetchAlpha(functionName, params, key) {
  const query = new URLSearchParams({ function: functionName, ...params, apikey: key });
  const resp = await withTimeout(
    fetch(`https://www.alphavantage.co/query?${query}`).then(result => {
      if (!result.ok) throw new Error(`Alpha Vantage HTTP ${result.status}`);
      return result.json();
    }),
    8000,
    null
  );
  return resp || {};
}

function normalizeOverview(data) {
  if (!data?.Symbol) return null;
  const fields = [
    'Symbol', 'Name', 'Description', 'Exchange', 'Currency', 'Country', 'Sector',
    'Industry', 'MarketCapitalization', 'PERatio', 'PEGRatio', 'BookValue',
    'DividendYield', 'EPS', 'RevenueTTM', 'ProfitMargin', 'OperatingMarginTTM',
    'ReturnOnEquityTTM', 'QuarterlyEarningsGrowthYOY', 'QuarterlyRevenueGrowthYOY',
    'AnalystTargetPrice', '52WeekHigh', '52WeekLow', '50DayMovingAverage',
    '200DayMovingAverage',
  ];
  return Object.fromEntries(fields.map(field => [field, data[field] ?? null]));
}

function normalizeNews(feed) {
  return feed.slice(0, 8).map(item => ({
    title: item.title,
    url: item.url,
    source: item.source,
    summary: item.summary,
    timePublished: item.time_published,
    sentiment: item.overall_sentiment_label,
    sentimentScore: Number(item.overall_sentiment_score),
  }));
}

async function lookupEdgarCIK(ticker) {
  const tickers = await withTimeout(
    fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'yingyun.ai aiyingyun@gmail.com' },
      cf: { cacheTtl: 86400, cacheEverything: true },
    })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),
    10000,
    null
  );
  if (!tickers) return null;
  const upper = ticker.toUpperCase();
  const entry = Object.values(tickers).find(e => e.ticker === upper);
  return entry ? String(entry.cik_str).padStart(10, '0') : null;
}

async function fetchEdgarSubmissions(cik) {
  return withTimeout(
    fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': 'yingyun.ai aiyingyun@gmail.com' },
    })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),
    8000,
    null
  );
}

async function fetchEdgarConcept(cik, concept) {
  return withTimeout(
    fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`, {
      headers: { 'User-Agent': 'yingyun.ai aiyingyun@gmail.com' },
    })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null),
    8000,
    null
  );
}

async function fetchRevenueConcept(cik) {
  const data = await fetchEdgarConcept(cik, 'Revenues');
  if (data?.units?.USD?.length) return data;
  return fetchEdgarConcept(cik, 'RevenueFromContractWithCustomerExcludingAssessedTax');
}

function getLatestAnnualValue(data, unit = 'USD') {
  const entries = data?.units?.[unit];
  if (!Array.isArray(entries)) return null;
  const annuals = entries
    .filter(e => (e.form === '10-K' || e.form === '20-F') && e.fp === 'FY')
    .sort((a, b) => b.end.localeCompare(a.end));
  return annuals[0]?.val ?? null;
}

function buildEdgarOverview(submissions, revenueData, netIncomeData, epsData) {
  const revenue = getLatestAnnualValue(revenueData);
  const netIncome = getLatestAnnualValue(netIncomeData);
  const eps = getLatestAnnualValue(epsData, 'USD/shares');
  return {
    Name: submissions?.name ?? null,
    Exchange: submissions?.exchanges?.[0] ?? null,
    Country: submissions?.stateOfIncorporation ?? null,
    Sector: submissions?.sicDescription ?? null,
    Industry: submissions?.sicDescription ?? null,
    Website: submissions?.website || submissions?.investorWebsite || null,
    RevenueTTM: revenue != null ? String(revenue) : null,
    ProfitMargin: (revenue && netIncome != null) ? String(netIncome / revenue) : null,
    EPS: eps != null ? String(eps) : null,
    MarketCapitalization: null,
    PERatio: null,
    PEGRatio: null,
    BookValue: null,
    DividendYield: null,
    OperatingMarginTTM: null,
    ReturnOnEquityTTM: null,
    QuarterlyEarningsGrowthYOY: null,
    QuarterlyRevenueGrowthYOY: null,
    AnalystTargetPrice: null,
    '52WeekHigh': null,
    '52WeekLow': null,
    '50DayMovingAverage': null,
    '200DayMovingAverage': null,
    Description: null,
  };
}

async function fetchTradingViewQuotes(symbols) {
  const exchanges = ['NASDAQ', 'NYSE', 'AMEX'];
  const tickers = symbols.flatMap(symbol =>
    exchanges.map(exchange => `${exchange}:${symbol}`)
  );
  const resp = await fetch('https://scanner.tradingview.com/america/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbols: { tickers, query: { types: [] } },
      columns: ['name', 'close', 'change'],
    }),
  });
  if (!resp.ok) return [];

  const data = await resp.json();
  const requested = new Set(symbols);
  const quotes = new Map();

  for (const row of data?.data || []) {
    const [symbol, price, changePct] = row.d || [];
    if (!requested.has(symbol) || !Number.isFinite(price) || quotes.has(symbol)) continue;
    quotes.set(symbol, {
      symbol,
      regularMarketPrice: price,
      regularMarketChangePercent: Number.isFinite(changePct) ? changePct : null,
    });
  }

  return [...quotes.values()];
}

async function fetchStockQuote(symbol, env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const yahooUrl =
          `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
          '?interval=1d&range=1d&includePrePost=false';
        const resp = await fetch(yahooUrl, { signal: controller.signal });
        if (!resp.ok) continue;

        const data = await resp.json();
        const meta = data?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        const prev = meta?.previousClose ?? meta?.chartPreviousClose;
        if (price == null) continue;

        return {
          symbol,
          regularMarketPrice: price,
          regularMarketChangePercent:
            prev != null && prev !== 0 ? ((price - prev) / prev) * 100 : null,
        };
      } catch {
        if (controller.signal.aborted) break;
      }
    }

    const nasdaqQuote = await fetchNasdaqQuote(symbol, controller.signal);
    if (nasdaqQuote) return nasdaqQuote;

    if (env?.API_NINJAS_KEY) {
      const ninjasQuote = await fetchApiNinjasQuote(symbol, env.API_NINJAS_KEY);
      if (ninjasQuote) return ninjasQuote;
    }
  } finally {
    clearTimeout(timeout);
  }

  return null;
}

async function fetchApiNinjasQuote(symbol, key) {
  try {
    const resp = await withTimeout(
      fetch(`https://api.api-ninjas.com/v1/stockprice?ticker=${encodeURIComponent(symbol)}`, {
        headers: { 'X-Api-Key': key },
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      5000, null
    );
    if (!resp?.price) return null;
    return {
      symbol,
      regularMarketPrice: resp.price,
      regularMarketChangePercent: null,
    };
  } catch {
    return null;
  }
}

async function fetchNasdaqQuote(symbol, signal) {
  try {
    const url =
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info` +
      '?assetclass=stocks';
    const resp = await fetch(url, {
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const primary = data?.data?.primaryData;
    const price = parseMarketNumber(primary?.lastSalePrice);
    const changePct = parseMarketNumber(primary?.percentageChange);
    if (price == null) return null;

    return {
      symbol,
      regularMarketPrice: price,
      regularMarketChangePercent: changePct,
    };
  } catch {
    return null;
  }
}

function parseMarketNumber(value) {
  if (value == null || value === 'N/A') return null;
  const number = Number(String(value).replace(/[$,%+\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function withTimeout(promise, milliseconds, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise(resolve => setTimeout(() => resolve(fallback), milliseconds)),
  ]);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
