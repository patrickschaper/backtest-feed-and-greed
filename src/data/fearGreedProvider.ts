import type { FearGreedPoint } from "../types.js";

const DEFAULT_FEAR_GREED_CSV_URL =
  "https://raw.githubusercontent.com/whit3rabbit/fear-greed-data/main/fear-greed.csv";

function normalizeDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function fetchFearGreedHistory(
  csvUrl = DEFAULT_FEAR_GREED_CSV_URL
): Promise<FearGreedPoint[]> {
  const response = await fetch(csvUrl);
  if (!response.ok) {
    throw new Error(`Fear & Greed source request failed with status ${response.status}`);
  }

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    throw new Error("Fear & Greed source returned no usable rows");
  }

  const output: FearGreedPoint[] = [];
  for (const line of lines.slice(1)) {
    const [dateRaw, scoreRaw] = line.split(",");
    if (!dateRaw || !scoreRaw) {
      continue;
    }
    const value = Number(scoreRaw);
    const parsedDate = new Date(dateRaw);
    if (Number.isNaN(value) || Number.isNaN(parsedDate.getTime())) {
      continue;
    }
    output.push({
      date: normalizeDate(parsedDate),
      value
    });
  }

  output.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (output.length === 0) {
    throw new Error("Fear & Greed source rows could not be parsed");
  }
  return output;
}
