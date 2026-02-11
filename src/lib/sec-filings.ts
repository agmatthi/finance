import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import { isSelfHostedMode } from "./local-db/local-auth";

type TenKSectionKey =
  | "business_overview"
  | "risk_factors"
  | "mdna"
  | "liquidity_and_market_risk"
  | "financial_statements";

export interface SecFilingRequest {
  ticker?: string;
  cik?: string;
  companyName?: string;
  formType?: "10-K" | "13F-HR";
  filingDate?: string;
  filingYear?: number;
  includeSections?: TenKSectionKey[];
  limitHoldings?: number;
}

export interface SecFilingMetadata {
  companyName: string;
  ticker?: string;
  cik: string;
  formType: "10-K" | "13F-HR";
  accessionNumber: string;
  filingDate: string;
  reportDate?: string;
  primaryDocumentUrl: string;
  informationTableUrl?: string;
  cached: boolean;
  cachePath?: string;
}

export interface SecFilingSummary {
  metadata: SecFilingMetadata;
  sections: Record<string, string>;
  holdings?: Array<{
    nameOfIssuer?: string;
    titleOfClass?: string;
    cusip?: string;
    value?: number;
    shares?: number;
    shareType?: string;
    investmentDiscretion?: string;
    putCall?: string;
    otherManager?: string;
    votingAuthority?: {
      sole?: number;
      shared?: number;
      none?: number;
    };
  }>;
  holdingsStats?: {
    totalPositions: number;
    totalValueMillions: number;
  };
}

interface CompanyTickerRecord {
  cik_str: number;
  ticker: string;
  title: string;
}

interface SecFilingEntry {
  accessionNumber: string;
  filingDate: string;
  reportDate?: string;
  form: string;
  primaryDocument: string;
}

const CACHE_ROOT = path.join(process.cwd(), ".local-data", "sec-filings");
const TICKER_CACHE = path.join(CACHE_ROOT, "company-tickers.json");

/**
 * Well-known institutional 13F filers whose names don't appear in
 * company_tickers.json (because they're not exchange-listed) or whose
 * name collides with another EDGAR entity. Each entry maps one or more
 * search-friendly lowercase aliases → verified CIK.
 *
 * This map is checked first by searchCompanyByName() when the caller
 * requests a 13F-HR filing, which eliminates the ambiguity that the
 * EDGAR company-search CGI cannot resolve on its own.
 */
const KNOWN_13F_FILERS: Record<string, { cik: string; name: string }> = {
  // Vanguard Group — CIK 102909 files 13F; CIK 735286 is transfer-agent entity
  "vanguard": { cik: "102909", name: "VANGUARD GROUP INC" },
  "vanguard group": { cik: "102909", name: "VANGUARD GROUP INC" },
  "vanguard group inc": { cik: "102909", name: "VANGUARD GROUP INC" },
  "the vanguard group": { cik: "102909", name: "VANGUARD GROUP INC" },

  // BlackRock
  "blackrock": { cik: "1364742", name: "BlackRock Finance, Inc." },
  "blackrock inc": { cik: "1364742", name: "BlackRock Finance, Inc." },
  "blackrock finance": { cik: "1364742", name: "BlackRock Finance, Inc." },

  // State Street
  "state street": { cik: "93751", name: "STATE STREET CORP" },
  "state street corp": { cik: "93751", name: "STATE STREET CORP" },
  "state street corporation": { cik: "93751", name: "STATE STREET CORP" },

  // Fidelity (FMR)
  "fidelity": { cik: "315066", name: "FMR LLC" },
  "fmr": { cik: "315066", name: "FMR LLC" },
  "fmr llc": { cik: "315066", name: "FMR LLC" },
  "fidelity management": { cik: "315066", name: "FMR LLC" },
  "fidelity investments": { cik: "315066", name: "FMR LLC" },

  // Berkshire Hathaway
  "berkshire hathaway": { cik: "1067983", name: "BERKSHIRE HATHAWAY INC" },
  "berkshire hathaway inc": { cik: "1067983", name: "BERKSHIRE HATHAWAY INC" },
  "berkshire": { cik: "1067983", name: "BERKSHIRE HATHAWAY INC" },

  // Citadel
  "citadel": { cik: "1423053", name: "CITADEL ADVISORS LLC" },
  "citadel advisors": { cik: "1423053", name: "CITADEL ADVISORS LLC" },
  "citadel advisors llc": { cik: "1423053", name: "CITADEL ADVISORS LLC" },

  // Bridgewater
  "bridgewater": { cik: "1350694", name: "Bridgewater Associates, LP" },
  "bridgewater associates": { cik: "1350694", name: "Bridgewater Associates, LP" },

  // Two Sigma
  "two sigma": { cik: "1179392", name: "TWO SIGMA INVESTMENTS, LP" },
  "two sigma investments": { cik: "1179392", name: "TWO SIGMA INVESTMENTS, LP" },

  // Renaissance Technologies
  "renaissance": { cik: "1037389", name: "RENAISSANCE TECHNOLOGIES LLC" },
  "renaissance technologies": { cik: "1037389", name: "RENAISSANCE TECHNOLOGIES LLC" },
  "renaissance tech": { cik: "1037389", name: "RENAISSANCE TECHNOLOGIES LLC" },
  "rentec": { cik: "1037389", name: "RENAISSANCE TECHNOLOGIES LLC" },

  // D.E. Shaw
  "de shaw": { cik: "1009207", name: "D. E. Shaw & Co., Inc." },
  "d.e. shaw": { cik: "1009207", name: "D. E. Shaw & Co., Inc." },
  "d e shaw": { cik: "1009207", name: "D. E. Shaw & Co., Inc." },

  // Millennium Management
  "millennium": { cik: "1273087", name: "MILLENNIUM MANAGEMENT LLC" },
  "millennium management": { cik: "1273087", name: "MILLENNIUM MANAGEMENT LLC" },

  // Point72 (Steve Cohen)
  "point72": { cik: "1603466", name: "Point72 Asset Management, L.P." },
  "point72 asset management": { cik: "1603466", name: "Point72 Asset Management, L.P." },

  // AQR Capital
  "aqr": { cik: "1167557", name: "AQR CAPITAL MANAGEMENT LLC" },
  "aqr capital": { cik: "1167557", name: "AQR CAPITAL MANAGEMENT LLC" },
  "aqr capital management": { cik: "1167557", name: "AQR CAPITAL MANAGEMENT LLC" },

  // Tiger Global
  "tiger global": { cik: "1167483", name: "TIGER GLOBAL MANAGEMENT LLC" },
  "tiger global management": { cik: "1167483", name: "TIGER GLOBAL MANAGEMENT LLC" },

  // Baupost Group
  "baupost": { cik: "1061768", name: "BAUPOST GROUP LLC/MA" },
  "baupost group": { cik: "1061768", name: "BAUPOST GROUP LLC/MA" },

  // Third Point (Dan Loeb)
  "third point": { cik: "1040273", name: "Third Point LLC" },
  "third point llc": { cik: "1040273", name: "Third Point LLC" },

  // Lone Pine Capital
  "lone pine": { cik: "1061165", name: "LONE PINE CAPITAL LLC" },
  "lone pine capital": { cik: "1061165", name: "LONE PINE CAPITAL LLC" },

  // Pershing Square (Bill Ackman)
  "pershing square": { cik: "1336528", name: "Pershing Square Capital Management, L.P." },
  "pershing square capital": { cik: "1336528", name: "Pershing Square Capital Management, L.P." },

  // Soros Fund Management
  "soros": { cik: "1029160", name: "SOROS FUND MANAGEMENT LLC" },
  "soros fund management": { cik: "1029160", name: "SOROS FUND MANAGEMENT LLC" },

  // Coatue Management
  "coatue": { cik: "1135730", name: "COATUE MANAGEMENT LLC" },
  "coatue management": { cik: "1135730", name: "COATUE MANAGEMENT LLC" },

  // Viking Global
  "viking global": { cik: "1103804", name: "VIKING GLOBAL INVESTORS LP" },
  "viking global investors": { cik: "1103804", name: "VIKING GLOBAL INVESTORS LP" },

  // Elliott Investment Management
  "elliott": { cik: "1791786", name: "Elliott Investment Management L.P." },
  "elliott management": { cik: "1791786", name: "Elliott Investment Management L.P." },
  "elliott investment management": { cik: "1791786", name: "Elliott Investment Management L.P." },

  // Greenlight Capital (David Einhorn)
  "greenlight": { cik: "1079114", name: "GREENLIGHT CAPITAL INC" },
  "greenlight capital": { cik: "1079114", name: "GREENLIGHT CAPITAL INC" },

  // Paulson & Co
  "paulson": { cik: "1035674", name: "PAULSON & CO. INC." },
  "paulson & co": { cik: "1035674", name: "PAULSON & CO. INC." },
};
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
  parseTagValue: true,
});
const SECTION_PATTERNS: Array<{
  key: TenKSectionKey;
  label: string;
  pattern: RegExp;
  next?: RegExp;
}> = [
  {
    key: "business_overview",
    label: "Item 1. Business",
    pattern: /item\s+1\.\s*business/,
    next: /item\s+1a\./,
  },
  {
    key: "risk_factors",
    label: "Item 1A. Risk Factors",
    pattern: /item\s+1a\./,
    next: /item\s+1b\.|item\s+2\./,
  },
  {
    key: "mdna",
    label: "Item 7. Management's Discussion and Analysis",
    pattern: /item\s+7\./,
    next: /item\s+7a\./,
  },
  {
    key: "liquidity_and_market_risk",
    label: "Item 7A. Quantitative and Qualitative Disclosures About Market Risk",
    pattern: /item\s+7a\./,
    next: /item\s+8\./,
  },
  {
    key: "financial_statements",
    label: "Item 8. Financial Statements and Supplementary Data",
    pattern: /item\s+8\./,
    next: /item\s+9\./,
  },
];

let tickerMap: Record<string, CompanyTickerRecord> | null = null;
let lastRequestTime = 0;

function getUserAgent(): string {
  return (
    process.env.SEC_API_USER_AGENT ||
    "finance-app/0.1 (finance-sec-ingest@example.com)"
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function secFetch(url: string, init?: RequestInit) {
  const minDelay = 150;
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < minDelay) {
    await wait(minDelay - timeSinceLast);
  }
  lastRequestTime = Date.now();

  const headers = {
    "User-Agent": getUserAgent(),
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    ...init?.headers,
  };

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `SEC request failed (${response.status}): ${body.slice(0, 140)}`
    );
  }
  return response;
}

async function ensureCacheDir() {
  if (!isSelfHostedMode()) return;
  await fs.promises.mkdir(CACHE_ROOT, { recursive: true });
}

async function loadTickerDirectory(): Promise<
  Record<string, CompanyTickerRecord>
> {
  if (tickerMap) return tickerMap;

  if (isSelfHostedMode() && fs.existsSync(TICKER_CACHE)) {
    try {
      const file = await fs.promises.readFile(TICKER_CACHE, "utf-8");
      tickerMap = JSON.parse(file);
      return tickerMap!;
    } catch {
      // ignore and refetch
    }
  }

  const res = await secFetch("https://www.sec.gov/files/company_tickers.json");
  const data = (await res.json()) as Record<string, CompanyTickerRecord>;
  tickerMap = Object.values(data).reduce<Record<string, CompanyTickerRecord>>(
    (acc, entry) => {
      if (entry.ticker) {
        acc[entry.ticker.toUpperCase()] = entry;
      }
      return acc;
    },
    {}
  );

  if (isSelfHostedMode()) {
    await ensureCacheDir();
    await fs.promises.writeFile(
      TICKER_CACHE,
      JSON.stringify(tickerMap, null, 2),
      "utf-8"
    );
  }

  return tickerMap!;
}

/**
 * Search for a company by name using a multi-strategy approach:
 *
 * 1. **Known 13F filer map** – instant lookup for major institutional investors
 *    (Vanguard, BlackRock, Citadel, Bridgewater, etc.) whose names collide
 *    with other EDGAR entities or who are not in the public-company ticker file.
 *
 * 2. **Ticker directory** – searches company_tickers.json by title. Covers
 *    publicly traded companies (BlackRock Inc → BLK, State Street → STT).
 *
 * 3. **EDGAR CGI company search** – queries the SEC browse-edgar endpoint
 *    (Atom XML) as a final fallback for entities not covered above.
 */
export async function searchCompanyByName(
  name: string,
  formType?: "10-K" | "13F-HR"
): Promise<{ cik: string; companyName: string } | null> {
  const searchTerm = name.toLowerCase().trim();
  if (!searchTerm || searchTerm.length < 2) return null;

  // ── Step 1: Check curated 13F filer map (instant, no network) ──────────
  if (formType === "13F-HR" || !formType) {
    const known = KNOWN_13F_FILERS[searchTerm];
    if (known) {
      console.log("[SEC] Resolved via known-13F map:", {
        search: name,
        cik: known.cik,
        name: known.name,
      });
      return { cik: known.cik, companyName: known.name };
    }
    // Also try progressively shorter prefixes for partial matches
    // e.g. "vanguard group inc latest" → try "vanguard group inc", "vanguard group", "vanguard"
    const words = searchTerm.split(/\s+/);
    for (let len = words.length; len >= 1; len--) {
      const prefix = words.slice(0, len).join(" ");
      const knownPrefix = KNOWN_13F_FILERS[prefix];
      if (knownPrefix) {
        console.log("[SEC] Resolved via known-13F map (prefix):", {
          search: name,
          matchedPrefix: prefix,
          cik: knownPrefix.cik,
          name: knownPrefix.name,
        });
        return { cik: knownPrefix.cik, companyName: knownPrefix.name };
      }
    }
  }

  // ── Step 2: Search ticker directory by company title ───────────────────
  try {
    const directory = await loadTickerDirectory();
    let bestMatch: CompanyTickerRecord | null = null;
    let bestScore = 0;

    for (const entry of Object.values(directory)) {
      const title = entry.title.toLowerCase();
      if (title === searchTerm) {
        bestMatch = entry;
        bestScore = Infinity;
        break;
      }
      if (title.includes(searchTerm) && searchTerm.length > bestScore) {
        bestMatch = entry;
        bestScore = searchTerm.length;
      }
      if (searchTerm.includes(title) && title.length > bestScore) {
        bestMatch = entry;
        bestScore = title.length;
      }
    }

    if (bestMatch && bestScore >= 3) {
      console.log("[SEC] Found company by name in ticker directory:", {
        search: name,
        found: bestMatch.title,
        ticker: bestMatch.ticker,
        cik: bestMatch.cik_str,
      });
      return {
        cik: String(bestMatch.cik_str),
        companyName: bestMatch.title,
      };
    }
  } catch (error) {
    console.warn("[SEC] Ticker directory name search failed:", error);
  }

  // ── Step 3: EDGAR CGI company search (Atom XML) ───────────────────────
  // The browse-edgar CGI returns Atom XML. When it matches exactly one
  // company it auto-redirects to that company's filing list and includes
  // a <company-info> block with the CIK. We parse that CIK and validate
  // that the entity actually files the desired form type.
  try {
    const typeFilter = formType ? `&type=${encodeURIComponent(formType)}` : "";
    const url =
      `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(
        name
      )}&CIK=&dateb=&owner=include&count=10&search_text=&action=getcompany&output=atom` +
      typeFilter;
    console.log("[SEC] CGI company search:", url);

    const res = await secFetch(url, {
      headers: { Accept: "application/atom+xml" },
    });
    const xml = await res.text();

    // Extract CIK from <company-info><cik>...</cik>
    const cikMatch = xml.match(/<cik>0*(\d+)<\/cik>/);
    const nameMatch = xml.match(
      /<conformed-name>(.*?)<\/conformed-name>/
    );

    if (cikMatch) {
      const cgiCik = cikMatch[1];
      const cgiName = nameMatch?.[1] || name;

      // Validate: check if this CIK actually has the desired filing type
      if (formType) {
        try {
          const subs = await fetchCompanySubmissions(cgiCik);
          const forms: string[] = subs?.filings?.recent?.form || [];
          const hasForm = forms.some((f: string) => f.startsWith(formType));
          if (hasForm) {
            console.log("[SEC] CGI resolved + validated:", {
              cik: cgiCik,
              name: cgiName,
              formType,
            });
            return { cik: cgiCik, companyName: cgiName };
          }
          console.warn(
            `[SEC] CGI CIK ${cgiCik} (${cgiName}) does not file ${formType}`
          );
        } catch {
          // Validation failed, still return the CIK as best-effort
          console.warn("[SEC] CGI CIK validation fetch failed, using as-is");
          return { cik: cgiCik, companyName: cgiName };
        }
      } else {
        console.log("[SEC] CGI resolved:", { cik: cgiCik, name: cgiName });
        return { cik: cgiCik, companyName: cgiName };
      }
    }
  } catch (error) {
    console.warn(
      "[SEC] CGI company search failed:",
      error instanceof Error ? error.message : error
    );
  }

  return null;
}

async function resolveCompany(
  ticker?: string,
  rawCik?: string,
  companyName?: string
): Promise<{ cik: string; ticker?: string; companyName?: string }> {
  if (rawCik) {
    return {
      cik: rawCik.replace(/^0+/, ""),
      ticker: ticker?.toUpperCase(),
    };
  }

  if (ticker) {
    const directory = await loadTickerDirectory();
    const match = directory[ticker.toUpperCase()];
    if (match) {
      return {
        cik: String(match.cik_str),
        ticker: match.ticker.toUpperCase(),
        companyName: match.title,
      };
    }
  }

  // Try name-based search if ticker lookup failed or no ticker provided
  if (companyName || ticker) {
    const nameResult = await searchCompanyByName(
      companyName || ticker || ""
    );
    if (nameResult) {
      return {
        cik: nameResult.cik,
        ticker: ticker?.toUpperCase(),
        companyName: nameResult.companyName,
      };
    }
  }

  throw new Error(
    `Unable to resolve "${companyName || ticker}" to a CIK. Provide a valid ticker, CIK, or company name.`
  );
}

async function fetchCompanySubmissions(cik: string) {
  const padded = cik.padStart(10, "0");
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const res = await secFetch(url);
  return res.json();
}

function selectFiling(
  submissions: any,
  formType: "10-K" | "13F-HR",
  filingDate?: string,
  filingYear?: number
): SecFilingEntry | null {
  const filings = submissions?.filings?.recent;
  if (!filings || !filings.form) return null;

  const targetForms =
    formType === "13F-HR" ? ["13F-HR", "13F-HR/A"] : [formType];

  const entries: SecFilingEntry[] = filings.form.map((form: string, idx: number) => ({
    form,
    accessionNumber: filings.accessionNumber[idx],
    filingDate: filings.filingDate[idx],
    reportDate: filings.reportDate[idx],
    primaryDocument: filings.primaryDocument[idx],
  }));

  const normalizedDate = filingDate?.slice(0, 10);

  return (
    entries.find((entry) => {
      if (!targetForms.includes(entry.form)) return false;
      if (normalizedDate && entry.filingDate !== normalizedDate) {
        return false;
      }
      if (filingYear) {
        const year = Number(entry.filingDate?.slice(0, 4));
        const reportYear = Number(entry.reportDate?.slice(0, 4));
        if (year !== filingYear && reportYear !== filingYear) {
          return false;
        }
      }
      return true;
    }) || null
  );
}

function buildArchiveBase(cik: string, accessionNumber: string) {
  const accessionPlain = accessionNumber.replace(/-/g, "");
  const cikNoLeading = String(Number(cik));
  return {
    basePath: `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accessionPlain}`,
    cacheKey: `${cikNoLeading}-${accessionPlain}`,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSections(text: string): Record<string, string> {
  const lower = text.toLowerCase();
  const sections: Record<string, string> = {};

  SECTION_PATTERNS.forEach((section) => {
    const match = lower.match(section.pattern);
    if (!match || match.index === undefined) return;
    const start = match.index;
    let end = text.length;
    if (section.next) {
      const sliced = lower.slice(start + match[0].length);
      const nextMatch = sliced.match(section.next);
      if (nextMatch && nextMatch.index !== undefined) {
        end = start + match[0].length + nextMatch.index;
      }
    }
    const snippet = text
      .slice(start, end)
      .replace(/\s{3,}/g, " ")
      .trim();
    sections[section.key] = snippet;
  });

  return sections;
}

function parseInformationTable(xml: string) {
  const parsed = parser.parse(xml);
  const table =
    parsed?.informationTable?.infoTable ||
    parsed?.informationTable ||
    parsed?.edgarSubmission?.informationTable?.infoTable ||
    parsed?.edgarSubmission?.informationTable;

  if (!table) return [];
  const records = Array.isArray(table) ? table : [table];
  return records
    .map((row) => {
      if (!row) return null;
      const shares =
        Number(row?.shrsOrPrnAmt?.sshPrnamt) ||
        Number(row?.shrsOrPrnAmt?.sshprnamt);
      const voting = row?.votingAuthority || row?.votingauthority;
      return {
        nameOfIssuer: row?.nameOfIssuer || row?.nameofIssuer,
        titleOfClass: row?.titleOfClass,
        cusip: row?.cusip,
        value: Number(row?.value),
        shares: isFinite(shares) ? shares : undefined,
        shareType: row?.shrsOrPrnAmt?.sshPrnamtType,
        investmentDiscretion: row?.investmentDiscretion,
        putCall: row?.putCall || row?.putcall,
        otherManager: row?.otherManager,
        votingAuthority: voting
          ? {
              sole: Number(voting.Sole ?? voting.sole ?? 0) || undefined,
              shared: Number(voting.Shared ?? voting.shared ?? 0) || undefined,
              none: Number(voting.None ?? voting.none ?? 0) || undefined,
            }
          : undefined,
      };
    })
    .filter(Boolean) as SecFilingSummary["holdings"];
}

async function readCache(cacheKey: string) {
  if (!isSelfHostedMode()) return null;
  const filePath = path.join(CACHE_ROOT, `${cacheKey}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    return { data, filePath };
  } catch (error) {
    console.warn("[SEC Caching] Failed to read cache:", error);
    return null;
  }
}

async function writeCache(cacheKey: string, payload: any) {
  if (!isSelfHostedMode()) return;
  await ensureCacheDir();
  const filePath = path.join(CACHE_ROOT, `${cacheKey}.json`);
  await fs.promises.writeFile(
    filePath,
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
  return filePath;
}

export async function fetchSecFilingSummary(
  options: SecFilingRequest
): Promise<SecFilingSummary> {
  const {
    ticker,
    cik: rawCik,
    companyName,
    formType = "10-K",
    filingDate,
    filingYear,
    includeSections,
    limitHoldings = 25,
  } = options;

  const company = await resolveCompany(ticker, rawCik, companyName);
  const submissions = await fetchCompanySubmissions(company.cik);
  const filing = selectFiling(submissions, formType, filingDate, filingYear);

  if (!filing) {
    const identifier = [
      company.companyName,
      company.ticker ? `ticker ${company.ticker}` : null,
      `CIK ${company.cik}`,
    ]
      .filter(Boolean)
      .join(", ");
    const yearNote = filingYear ? ` for year ${filingYear}` : "";
    throw new Error(
      `No ${formType} filing found for ${identifier}${yearNote}. ` +
        `This entity (CIK ${company.cik}) may not file ${formType} forms. ` +
        `Do NOT retry with the same entity — try a different company name, ticker, or CIK.`
    );
  }

  const { basePath, cacheKey } = buildArchiveBase(
    company.cik,
    filing.accessionNumber
  );

  const cached = await readCache(cacheKey);
  if (cached?.data) {
    const summary: SecFilingSummary = cached.data;
    if (includeSections?.length && summary.sections) {
      summary.sections = Object.fromEntries(
        Object.entries(summary.sections).filter(([key]) =>
          includeSections.includes(key as TenKSectionKey)
        )
      );
    }
    return {
      ...summary,
      metadata: {
        ...summary.metadata,
        cached: true,
        cachePath: cached.filePath,
      },
      holdings: summary.holdings?.slice(
        0,
        formType === "13F-HR" ? limitHoldings : summary.holdings?.length
      ),
    };
  }

  const primaryDocUrl = `${basePath}/${filing.primaryDocument}`;
  const primary = await secFetch(primaryDocUrl, { headers: { Accept: "text/html" } });
  const primaryText = stripHtml(await primary.text());
  const sections =
    formType === "10-K" ? extractSections(primaryText) : {};

  let holdings: SecFilingSummary["holdings"] | undefined;
  let holdingsStats: SecFilingSummary["holdingsStats"];
  let informationTableUrl: string | undefined;

  if (formType === "13F-HR") {
    try {
      const indexRes = await secFetch(`${basePath}/index.json`);
      const indexJson = await indexRes.json();
      const items: Array<{ name: string }> =
        indexJson?.directory?.item || [];
      // Try multiple naming patterns:
      // 1. Standard: infotable.xml, form13fInfoTable.xml
      // 2. Vanguard-style: 13F_*.xml
      // 3. Fallback: largest non-primary XML file (handles generic names like 46994.xml)
      const infoItem =
        items.find((item) =>
          /infotable|informationtable/i.test(item.name)
        ) ||
        items.find(
          (item) =>
            /13f/i.test(item.name) &&
            item.name.endsWith(".xml") &&
            item.name !== filing.primaryDocument
        ) ||
        items
          .filter(
            (item: { name: string; size?: string }) =>
              item.name.endsWith(".xml") &&
              item.name !== filing.primaryDocument &&
              !item.name.includes("-index")
          )
          .sort(
            (a: { name: string; size?: string }, b: { name: string; size?: string }) =>
              Number(b.size || 0) - Number(a.size || 0)
          )[0] ||
        null;
      if (infoItem) {
        informationTableUrl = `${basePath}/${infoItem.name}`;
        const tableRes = await secFetch(informationTableUrl, {
          headers: { Accept: "text/xml" },
        });
        const xml = await tableRes.text();
        holdings = parseInformationTable(xml);
        if (holdings?.length) {
          const totalValue =
            holdings.reduce((acc, row) => acc + (row.value || 0), 0) || 0;
          holdingsStats = {
            totalPositions: holdings.length,
            totalValueMillions: Number((totalValue / 1000).toFixed(2)),
          };
        }
        if (holdings && limitHoldings > 0) {
          holdings = holdings
            .sort((a, b) => (b.value || 0) - (a.value || 0))
            .slice(0, limitHoldings);
        }
      }
    } catch (error) {
      console.warn("[SEC] Failed to parse 13F info table:", error);
    }
  }

  const summary: SecFilingSummary = {
    metadata: {
      companyName: submissions?.name || company.companyName || "Unknown",
      ticker: company.ticker,
      cik: company.cik,
      formType,
      accessionNumber: filing.accessionNumber,
      filingDate: filing.filingDate,
      reportDate: filing.reportDate,
      primaryDocumentUrl: primaryDocUrl,
      informationTableUrl,
      cached: false,
    },
    sections: includeSections?.length
      ? Object.fromEntries(
          Object.entries(sections).filter(([key]) =>
            includeSections.includes(key as TenKSectionKey)
          )
        )
      : sections,
    holdings,
    holdingsStats,
  };

  const cachePayload = {
    ...summary,
    metadata: {
      ...summary.metadata,
      cached: true,
    },
    fetchedAt: new Date().toISOString(),
  };
  await writeCache(cacheKey, cachePayload);

  return summary;
}
