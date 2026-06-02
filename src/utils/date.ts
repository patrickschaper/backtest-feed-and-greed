export function subtractDays(baseDate: Date, days: number): Date {
  const result = new Date(baseDate);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

export function normalizeDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
