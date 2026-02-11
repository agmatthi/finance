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
 * Search for a company by name. First checks the loaded ticker directory
 * (covers publicly-traded entities like BlackRock, State Street), then falls
 * back to EDGAR full-text search (EFTS) to find entities that may not be in
 * the ticker file (e.g. privately-held 13F filers like Vanguard Group).
 */
export async function searchCompanyByName(
  name: string,
  formType?: "10-K" | "13F-HR"
): Promise<{ cik: string; companyName: string } | null> {
  const searchTerm = name.toLowerCase().trim();
  if (!searchTerm || searchTerm.length < 2) return null;

  // Step 1: Search through loaded ticker directory by company title
  try {
    const directory = await loadTickerDirectory();
    let bestMatch: CompanyTickerRecord | null = null;
    let bestScore = 0;

    for (const entry of Object.values(directory)) {
      const title = entry.title.toLowerCase();
      // Exact match — return immediately
      if (title === searchTerm) {
        bestMatch = entry;
        bestScore = Infinity;
        break;
      }
      // Title contains search term (e.g. "blackrock" matches "BlackRock Inc.")
      if (title.includes(searchTerm) && searchTerm.length > bestScore) {
        bestMatch = entry;
        bestScore = searchTerm.length;
      }
      // Search term contains title (e.g. "blackrock inc" matches "BlackRock")
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

  // Step 2: Use EDGAR full-text search (EFTS) to find entity by name.
  // This handles entities not in company_tickers.json (e.g. private 13F filers).
  try {
    const formFilter = formType
      ? `&forms=${encodeURIComponent(formType)}`
      : "";
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(
      name
    )}%22${formFilter}`;
    console.log("[SEC] Searching EFTS for company name:", url);

    const res = await secFetch(url);
    const data = await res.json();

    const hits = data?.hits?.hits;
    if (Array.isArray(hits) && hits.length > 0) {
      const source = hits[0]._source || hits[0] || {};

      // Method 1: Some EFTS responses include "COMPANY (CIK 0000102909)" in display fields
      const nameFields = [
        source.entity_name_agg,
        source.display_names?.[0],
        source.entity_name,
      ]
        .filter(Boolean)
        .join(" ");

      const cikFromField = nameFields.match(/CIK\s*[:#]?\s*0*(\d{1,10})/i);
      if (cikFromField) {
        console.log("[SEC] EFTS found CIK from entity field:", cikFromField[1]);
        return {
          cik: cikFromField[1],
          companyName: source.entity_name || name,
        };
      }

      // Method 2: Extract CIK from accession number (format: 0000102909-24-012345)
      const accession =
        hits[0]._id || source.accession_no || source.accession_number || "";
      if (typeof accession === "string") {
        const accessionMatch = accession.match(/^0*(\d{1,10})-\d{2}-\d+/);
        if (accessionMatch) {
          console.log(
            "[SEC] EFTS found CIK from accession number:",
            accessionMatch[1]
          );
          return {
            cik: accessionMatch[1],
            companyName: source.entity_name || name,
          };
        }
      }

      // Method 3: Direct CIK field
      const directCik = source.entity_id || source.cik || source.entity_cik;
      if (directCik) {
        const cleaned = String(directCik)
          .replace(/\D/g, "")
          .replace(/^0+/, "");
        if (cleaned) {
          console.log("[SEC] EFTS found CIK from direct field:", cleaned);
          return {
            cik: cleaned,
            companyName: source.entity_name || name,
          };
        }
      }
    }

    console.warn("[SEC] EFTS search returned no usable results for:", name);
  } catch (error) {
    console.warn(
      "[SEC] EFTS company search failed:",
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
    throw new Error(
      `No ${formType} filing found for ${company.ticker || company.cik}`
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
      const infoItem = items.find((item) =>
        /infotable|informationtable/i.test(item.name)
      );
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
