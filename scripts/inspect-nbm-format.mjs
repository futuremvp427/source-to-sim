#!/usr/bin/env node

const url = "https://noaa-nbm-grib2-pds.s3.amazonaws.com/blend.20260801/13/text/blend_nbptx.t13z";
const response = await fetch(url, { headers: { "User-Agent": "source-to-sim-weather-research/1.0" } });
if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
const text = await response.text();
console.log(`bytes=${text.length}`);
for (const station of ["KLAX", "KSFO", "KMIA"]) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(station)) hits.push(i);
  }
  console.log(`\n===== ${station} hits=${hits.length} =====`);
  for (const index of hits.slice(0, 2)) {
    console.log(lines.slice(Math.max(0, index - 2), index + 18).join("\n"));
  }
}
