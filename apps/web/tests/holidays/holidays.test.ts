import { describe, expect, it } from "vitest";
import data from "../../src/holidays/holidays.json";
import { holidaysFor, holidayTable } from "../../src/holidays";
import { decodeShiftJis, parseHolidayCsv } from "../../src/holidays/parse";

const HEADER = "国民の祝日・休日月日,国民の祝日・休日名称";
const FIXED = ["1/1", "2/11", "2/23", "4/29", "5/3", "5/4", "5/5", "11/3", "11/23"];
/** 1年に16日あり、固定日の祝日を含む、それらしいCSV。drop で固定日を落とす */
const csv = (years: number[], extra: string[] = [], drop: string[] = []) =>
  [
    HEADER,
    ...years.flatMap((y) => [
      ...FIXED.filter((md) => !drop.includes(`${y}/${md}`)).map((md) => `${y}/${md},祝日`),
      ...Array.from({ length: 7 }, (_, i) => `${y}/8/${i + 1},祝日`),
    ]),
    ...extra,
  ].join("\r\n");

describe("decodeShiftJis", () => {
  it("Shift_JISの日本語を読む", () => {
    expect(decodeShiftJis(new Uint8Array([0x8c, 0xb3, 0x93, 0xfa]))).toBe("元日");
  });
  it("壊れたバイトは例外", () => {
    expect(() => decodeShiftJis(new Uint8Array([0x81]))).toThrow();
  });
});

describe("parseHolidayCsv", () => {
  it("日付を YYYY-MM-DD にし、firstYear より前を捨てて、日付順に返す", () => {
    const r = parseHolidayCsv(csv([2019, 2021, 2020]), 2020);
    expect(r[0]).toEqual({ date: "2020-01-01", name: "祝日" });
    expect(r.every((h) => h.date >= "2020")).toBe(true);
    expect(r.map((h) => h.date)).toEqual([...r.map((h) => h.date)].sort());
    expect(r).toHaveLength(32);
    expect(r.filter((h) => h.date.startsWith("2020"))).toHaveLength(16);
  });
  it("見出しが違えば例外", () => {
    expect(() => parseHolidayCsv("a,b\n2020/1/1,元日", 2020)).toThrow("header");
  });
  it("形式が違う行、存在しない日付、重複は例外", () => {
    expect(() => parseHolidayCsv(csv([2020], ["2020-03-01,春分"]), 2020)).toThrow("invalid CSV row");
    expect(() => parseHolidayCsv(csv([2020], ["2020/2/30,春分"]), 2020)).toThrow("invalid date");
    expect(() => parseHolidayCsv(csv([2020], ["2020/1/1,元日"]), 2020)).toThrow("duplicate");
  });
  it("名称の列が2列を超える、引用符つきの行は例外", () => {
    expect(() => parseHolidayCsv(csv([2020], ["2020/3/20,春分の日,extra"]), 2020)).toThrow("invalid CSV row");
    expect(() => parseHolidayCsv(csv([2020], ['2020/3/20,"春分の日"']), 2020)).toThrow("invalid CSV row");
  });
  it("最後の年の末尾が欠けたCSV（件数は足りる）は、固定日の祝日がないので例外", () => {
    expect(() => parseHolidayCsv(csv([2020, 2021], [], ["2021/11/23"]), 2020)).toThrow("missing fixed holiday 2021-11-23");
    expect(() => parseHolidayCsv(csv([2020, 2021], [], ["2021/11/3"]), 2020)).toThrow("missing fixed holiday 2021-11-03");
  });
  it("年の祝日が少なすぎる、または年が欠けているときは例外", () => {
    expect(() => parseHolidayCsv([HEADER, "2020/1/1,元日"].join("\n"), 2020)).toThrow("too few");
    expect(() => parseHolidayCsv(csv([2020, 2022]), 2020)).toThrow("too few holidays in 2021");
    expect(() => parseHolidayCsv(csv([2019]), 2020)).toThrow("no holidays");
    const thirteen = [HEADER, ...FIXED.map((md) => `2020/${md},祝日`), ...Array.from({ length: 4 }, (_, i) => `2020/8/${i + 1},祝日`)];
    expect(() => parseHolidayCsv(thirteen.join("\n"), 2020)).toThrow("too few holidays in 2020: 13");
    expect(parseHolidayCsv([...thirteen, "2020/8/5,祝日"].join("\n"), 2020)).toHaveLength(14);
  });
});

describe("holidays.json", () => {
  const years = Object.entries(data.years);
  it("年のキーと日付が合い、日付順で、実在する日付だけ", () => {
    for (const [y, rows] of years) {
      const dates = rows.map((r) => r[0]!);
      expect(dates.every((d) => d.startsWith(`${y}-`) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d))).toBe(true);
      expect(dates).toEqual([...dates].sort());
      expect(new Set(dates).size).toBe(dates.length);
    }
  });
  it("各年の祝日が14日以上で、固定日の祝日を含む", () => {
    for (const [y, rows] of years) {
      expect(rows.length).toBeGreaterThanOrEqual(14);
      for (const md of ["01-01", "02-11", "02-23", "04-29", "05-03", "05-04", "05-05", "11-03", "11-23"]) expect(rows.some((r) => r[0] === `${y}-${md}`)).toBe(true);
    }
  });
  it("firstYear〜lastYear が途切れず、取得元のハッシュがある", () => {
    expect(years.map(([y]) => Number(y))).toEqual(Array.from({ length: data.lastYear - data.firstYear + 1 }, (_, i) => data.firstYear + i));
    expect(data.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("2026年の祝日（振替休日と秋分の日を含む）が入っている", () => {
    for (const d of ["2026-01-12", "2026-05-06", "2026-09-22", "2026-11-03", "2026-11-23"]) expect(holidayTable.dates.has(d)).toBe(true);
    expect(holidayTable.dates.has("2026-11-04")).toBe(false);
  });
});

describe("holidaysFor", () => {
  const { firstYear, lastYear } = holidayTable;
  it("対象の年の内側なら一覧を返す。範囲の両端の日も通る", () => {
    expect(holidaysFor("2026-11-04").has("2026-11-23")).toBe(true);
    expect(holidaysFor(`${firstYear}-01-01`, `${lastYear}-12-31`)).toBe(holidayTable.dates);
  });
  it("from・to のどちらかが範囲の外なら例外（年をまたいで古い一覧のまま営業日を数えない）", () => {
    expect(() => holidaysFor(`${lastYear + 1}-01-04`)).toThrow("holiday data covers");
    expect(() => holidaysFor(`${firstYear - 1}-12-30`)).toThrow("holiday data covers");
    expect(() => holidaysFor(`${lastYear}-12-01`, `${lastYear + 1}-01-12`)).toThrow("holiday data covers");
    expect(() => holidaysFor(`${firstYear - 1}-12-30`, `${firstYear}-01-04`)).toThrow("holiday data covers");
  });
  it("書式が違う日付、存在しない日付は例外", () => {
    for (const d of ["2026/11/04", "2026-13-45", "2026-02-30", ""]) expect(() => holidaysFor(d)).toThrow("invalid date");
  });
  it("取得元の版（SHA-256）を外に出す", () => {
    expect(holidayTable.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
