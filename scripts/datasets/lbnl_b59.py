#!/usr/bin/env python3
"""
Converts the LBNL Building 59 dataset into FlowCarbon's import table (see the "Import data" card on the Data page).

Dataset: N. Luo, Z. Wang, D. Blum et al., "A three-year building operational performance dataset for informing
energy efficiency", Scientific Data 9, 156 (2022). doi:10.7941/D1N33Q, mirrored at https://zenodo.org/records/5951008
(CC0 1.0). Unzip Building_59.zip and pass its "Bldg59_clean data" folder.

What maps to what, and what does not:
- People: camera counts for the south halves of the third and fourth floors (occ.csv, 1 min, 22 May 2018 to
  21 Feb 2019), summed and taken as the highest count within each 15 minutes, so a floor is not called empty while
  someone was there for part of it.
- Energy: the south wing's HVAC, lighting and plug ("MELs") loads from ele.csv, average kW per 15 min, times 0.25 h.
  The meters cover the wing, not single floors, so the two floors become one zone, "3-4S".
- Cooling state: the HVAC counts as running ("full") whenever the wing's HVAC draws more than 2 kW. From June to
  November 2018 it ran almost around the clock; from December it was off a third of the time or more. Part of the
  night-time load may be ventilation the building needs; FlowCarbon's findings say what ran while nobody was
  counted, not that all of it could have been switched off.
- Lighting level: lighting power over its 95th percentile, capped at 1.
- Times are UTC in the source and are written with a Z, so FlowCarbon reads them in the building's own time zone
  (America/Los_Angeles).

usage: python3 -I lbnl_b59.py "<path to Bldg59_clean data>" out.csv [--from 2018-05-22] [--to 2019-02-22]
"""

import csv
import datetime as dt
import sys

ZONE = "3-4S"


def utc(text: str, fmt: str) -> dt.datetime:
    return dt.datetime.strptime(text.strip(), fmt).replace(tzinfo=dt.timezone.utc)


def bucket(t: dt.datetime) -> dt.datetime:
    return t.replace(minute=t.minute - t.minute % 15, second=0, microsecond=0)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(zip(sys.argv[1::2], sys.argv[2::2]))
    if len(args) < 2:
        sys.exit(__doc__)
    folder, out = args[0], args[1]
    start = dt.datetime.fromisoformat(opts.get("--from", "2018-05-22")).replace(tzinfo=dt.timezone.utc)
    end = dt.datetime.fromisoformat(opts.get("--to", "2019-02-22")).replace(tzinfo=dt.timezone.utc)

    people: dict[dt.datetime, float] = {}
    with open(f"{folder}/occ.csv", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            t = utc(row["date"], "%Y-%m-%d %H:%M:%S")
            if not start <= t < end:
                continue
            try:
                n = float(row["occ_third_south"] or 0) + float(row["occ_fourth_south"] or 0)
            except ValueError:
                continue
            b = bucket(t)
            people[b] = max(people.get(b, 0.0), n)

    energy: dict[dt.datetime, tuple[float, float, float]] = {}
    with open(f"{folder}/ele.csv", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            t = utc(row["date"], "%Y/%m/%d %H:%M")
            if not start <= t < end:
                continue
            try:
                energy[bucket(t)] = (float(row["hvac_S"]), float(row["lig_S"]), float(row["mels_S"]))
            except (ValueError, TypeError):
                continue

    lights = sorted(v[1] for v in energy.values())
    full_light = lights[int(len(lights) * 0.95)] if lights else 1.0
    rows = 0
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "floor", "people", "hvac_kwh", "lighting_kwh", "plug_kwh", "hvac", "lights"])
        # only intervals with both people and energy: a missing count is not an empty floor
        for t in sorted(set(people) & set(energy)):
            hvac_kw, light_kw, plug_kw = energy[t]
            w.writerow(
                [
                    t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    ZONE,
                    round(people[t]),
                    round(max(0.0, hvac_kw) * 0.25, 3),
                    round(max(0.0, light_kw) * 0.25, 3),
                    round(max(0.0, plug_kw) * 0.25, 3),
                    "full" if hvac_kw > 2 else "off",
                    round(min(1.0, max(0.0, light_kw) / full_light), 3) if full_light > 0 else 0,
                ]
            )
            rows += 1
    print(f"{rows} rows for zone {ZONE}, {start:%Y-%m-%d} to {end:%Y-%m-%d}; full lighting = {full_light:.2f} kW")


if __name__ == "__main__":
    main()
