/**
 * Item 37: Anki CSV and Quizlet TSV exports (.apkg deliberately skipped).
 */

export type ExportCard = {
  question: string;
  answer: string;
  tags?: string[];
};

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function toAnkiCsv(cards: ExportCard[]): string {
  const header = `#separator:Comma\n#html:false\n#tags column:3\n`;
  const rows = cards.map((c) =>
    [csvEscape(c.question), csvEscape(c.answer), (c.tags ?? []).join(" ")].join(","),
  );
  return header + rows.join("\n") + (rows.length ? "\n" : "");
}

export function toQuizletTsv(cards: ExportCard[]): string {
  const escapeTsv = (v: string) => v.replace(/[\t\n\r]/g, " ");
  const rows = cards.map((c) => `${escapeTsv(c.question)}\t${escapeTsv(c.answer)}`);
  return rows.join("\n") + (rows.length ? "\n" : "");
}
