import { describe, expect, it } from "vitest";
import {
  forecastDailyMax,
  latestAvailableCycle,
  nbmBulletinUrl,
  NbmParseError,
  parseNbmBulletin,
  parseRowValues,
  parseStationBlock,
  temperatureSeries,
} from "./nbm";

/** Verbatim excerpt of the operational 2026-08-26 15Z NBH bulletin. */
const NBH_KNYC = [
  " KNYC   NBM V5.0 NBH GUIDANCE    8/26/2026  1500 UTC",
  " UTC  16 17 18 19 20 21 22 23 00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 ",
  " TMP  77 79 81 81 82 81 79 76 75 74 74 74 74 73 73 72 72 71 71 72 74 76 78 79 80",
  " TSD   1  1  1  1  1  1  2  2  2  1  1  1  1  1  1  1  1  1  1  1  1  1  2  3  3",
  " DPT  60 60 59 59 59 60 61 63 63 64 64 65 64 64 64 64 65 65 66 66 68 68 69 69 69",
];

/** Verbatim excerpt of the operational 2026-08-26 15Z NBS bulletin. */
const NBS_KNYC = [
  " KNYC    NBM V5.0 NBS GUIDANCE    8/26/2026  1500 UTC",
  " DT      /AUG  27                /AUG  28                /AUG  29         ",
  " UTC  21 00 03 06 09 12 15 18 21 00 03 06 09 12 15 18 21 00 03 06 09 12 15 ",
  " FHR  06 09 12 15 18 21 24 27 30 33 36 39 42 45 48 51 54 57 60 63 66 69 72 ",
  " TXN                 70          81          70          83          67   ",
  " TMP  81 75 74 73 71 74 79 80 79 75 73 72 71 72 78 82 83 78 74 71 68 68 74",
  " TSD   1  2  1  1  1  1  3  3  2  2  2  2  1  1  2  2  2  2  2  2  3  3  3",
];

describe("parseRowValues", () => {
  it("splits fixed-width 3-character fields", () => {
    expect(parseRowValues(" TMP  77 79 81").slice(0, 3)).toEqual([77, 79, 81]);
  });

  it("handles right-aligned single digits", () => {
    expect(parseRowValues(" TSD   1  1  2").slice(0, 3)).toEqual([1, 1, 2]);
  });

  it("returns null for blank fields rather than zero", () => {
    // TXN is blank except where a max/min applies; zero would be a real -0F.
    const v = parseRowValues(" TXN                 70          81   ");
    expect(v[0]).toBeNull();
    expect(v).toContain(70);
  });
});

describe("parseStationBlock — NBH", () => {
  const f = parseStationBlock(NBH_KNYC);

  it("extracts station, version and product", () => {
    expect(f.station).toBe("KNYC");
    expect(f.version).toBe("V5.0");
    expect(f.product).toBe("NBH");
  });

  it("parses the model cycle time as UTC", () => {
    expect(f.cycleTime.toISOString()).toBe("2026-08-26T15:00:00.000Z");
  });

  it("treats the first NBH column as forecast hour 1", () => {
    expect(f.forecastHours[0]).toBe(1);
    expect(f.validTimes[0]?.toISOString()).toBe("2026-08-26T16:00:00.000Z");
  });

  it("rolls valid times past midnight UTC correctly", () => {
    // Column 8 is the printed 00Z, which is the next calendar day.
    expect(f.validTimes[8]?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("keeps TMP and TSD aligned to the same columns", () => {
    const s = temperatureSeries(f);
    expect(s[0]).toMatchObject({ temperatureF: 77, sdF: 1, forecastHour: 1 });
    expect(s[4]).toMatchObject({ temperatureF: 82, sdF: 1 });
  });

  it("retains the raw header as provenance", () => {
    expect(f.rawHeader).toContain("NBM V5.0 NBH GUIDANCE");
  });
});

describe("parseStationBlock — NBS", () => {
  const f = parseStationBlock(NBS_KNYC);

  it("uses the explicit FHR row rather than inferring", () => {
    expect(f.forecastHours.slice(0, 3)).toEqual([6, 9, 12]);
  });

  it("derives valid times from cycle plus forecast hour", () => {
    expect(f.validTimes[0]?.toISOString()).toBe("2026-08-26T21:00:00.000Z");
    expect(f.validTimes[1]?.toISOString()).toBe("2026-08-27T00:00:00.000Z");
  });

  it("ignores the DT continuation row", () => {
    expect(f.rows["DT"]).toBeUndefined();
  });

  it("captures TXN sparsely without turning blanks into zero", () => {
    expect(f.rows["TXN"]?.[0]).toBeNull();
    expect(f.rows["TXN"]).toContain(70);
  });
});

describe("timestamp cross-check", () => {
  it("throws when derived valid times disagree with the printed UTC row", () => {
    // Corrupt the UTC row so column 0 claims 20Z when FHR 1 implies 16Z.
    const corrupted = [...NBH_KNYC];
    corrupted[1] = " UTC  20 17 18 19 20 21 22 23";
    expect(() => parseStationBlock(corrupted)).toThrow(NbmParseError);
  });

  it("throws on an unrecognised header rather than guessing", () => {
    expect(() => parseStationBlock([" KNYC something else entirely"])).toThrow(NbmParseError);
  });

  it("rejects a product we do not use intraday", () => {
    expect(() =>
      parseStationBlock([" KNYC   NBM V5.0 NBE GUIDANCE    8/26/2026  1500 UTC", " UTC  16"]),
    ).toThrow(/unsupported product/);
  });

  it("throws when a station block has no UTC row", () => {
    expect(() => parseStationBlock([NBH_KNYC[0]!, " TMP  77 79"])).toThrow(/no UTC row/);
  });
});

describe("parseNbmBulletin", () => {
  const bulletin = [
    " KORD   NBM V5.0 NBH GUIDANCE    8/26/2026  1500 UTC",
    " UTC  16 17 18",
    " TMP  70 71 72",
    ...NBH_KNYC,
    " KLAX   NBM V5.0 NBH GUIDANCE    8/26/2026  1500 UTC",
    " UTC  16 17 18",
    " TMP  75 76 77",
  ].join("\n");

  it("extracts only the requested stations", () => {
    const found = parseNbmBulletin(bulletin, ["KNYC", "KLAX"]);
    expect([...found.keys()].sort()).toEqual(["KLAX", "KNYC"]);
  });

  it("separates adjacent station blocks correctly", () => {
    const found = parseNbmBulletin(bulletin, ["KNYC"]);
    expect(found.get("KNYC")?.rows["TMP"]?.[0]).toBe(77);
  });

  it("returns an empty map when no requested station is present", () => {
    expect(parseNbmBulletin(bulletin, ["KZZZ"]).size).toBe(0);
  });
});

describe("nbmBulletinUrl", () => {
  it("builds the operational NOAA path for NBH", () => {
    expect(nbmBulletinUrl("NBH", new Date("2026-08-26T15:00:00Z"))).toBe(
      "https://noaa-nbm-grib2-pds.s3.amazonaws.com/blend.20260826/15/text/blend_nbhtx.t15z",
    );
  });

  it("builds the operational NOAA path for NBS with zero padding", () => {
    expect(nbmBulletinUrl("NBS", new Date("2026-01-05T06:00:00Z"))).toContain("blend.20260105/06/text/blend_nbstx.t06z");
  });
});

describe("latestAvailableCycle", () => {
  it("steps back by the publish lag and truncates to the hour", () => {
    expect(latestAvailableCycle(new Date("2026-08-26T17:42:00Z")).toISOString()).toBe("2026-08-26T15:00:00.000Z");
  });

  it("never returns a cycle in the future", () => {
    const now = new Date("2026-08-26T17:42:00Z");
    expect(latestAvailableCycle(now).getTime()).toBeLessThan(now.getTime());
  });
});

describe("forecastDailyMax", () => {
  const f = parseStationBlock(NBH_KNYC);

  it("returns the peak within the local calendar day", () => {
    const r = forecastDailyMax(f, "2026-08-26", "America/New_York");
    // 16Z-23Z on 2026-08-26 is 12:00-19:00 local; peak is 82F at 20Z.
    expect(r?.maxF).toBe(82);
  });

  it("carries the peak hour's own standard deviation", () => {
    expect(forecastDailyMax(f, "2026-08-26", "America/New_York")?.sdF).toBe(1);
  });

  it("marks a day incomplete when guidance does not reach late afternoon", () => {
    // 2026-08-27 columns here only run to 12Z, i.e. 08:00 local.
    const r = forecastDailyMax(f, "2026-08-27", "America/New_York");
    expect(r?.complete).toBe(false);
  });

  it("marks a day complete when guidance spans the afternoon", () => {
    expect(forecastDailyMax(f, "2026-08-26", "America/New_York")?.complete).toBe(true);
  });

  it("returns null for a day the bulletin does not cover", () => {
    expect(forecastDailyMax(f, "2026-09-15", "America/New_York")).toBeNull();
  });
});
