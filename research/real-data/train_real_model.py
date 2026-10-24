"""Download public US flight/weather data, aggregate it to Excel, and train a small auditable model.

The model is deliberately auxiliary: it estimates next-month operational pressure and capacity loss;
the application's deterministic rules remain the source of the final risk class.
"""
from __future__ import annotations

import io
import json
import os
import math
import re
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "research" / "real-data" / "raw"
OUT = ROOT / "research" / "real-data" / "processed"
YEAR = 2024
# Four complete months keep the reproducible demo lightweight while still
# providing enough airport/weather observations for an auxiliary model.
MONTHS = range(1, 5)
AIRPORTS = {
    "ATL": (33.6407, -84.4277), "DFW": (32.8998, -97.0403), "DEN": (39.8561, -104.6737),
    "ORD": (41.9742, -87.9073), "LAX": (33.9416, -118.4085), "CLT": (35.2140, -80.9431),
    "LAS": (36.0840, -115.1537), "PHX": (33.4352, -112.0101), "MCO": (28.4312, -81.3081),
    "SEA": (47.4502, -122.3088),
}
BTS_BASE = "https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present"
WEATHER_BASE = "https://www.ncei.noaa.gov/data/global-summary-of-the-day/access"


def download(url: str, path: Path) -> None:
    if path.exists() and path.stat().st_size > 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, 4):
        temporary = path.with_name(f"{path.name}.{os.getpid()}.{attempt}.part")
        try:
            with urllib.request.urlopen(url, timeout=180) as source, temporary.open("wb") as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    target.write(chunk)
            temporary.replace(path)
            return
        except Exception:
            if attempt == 3:
                raise


def nearest_stations() -> dict[str, str]:
    station_file = RAW / "isd-history.csv"
    download("https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv", station_file)
    stations = pd.read_csv(station_file, low_memory=False)
    stations["END"] = pd.to_numeric(stations["END"], errors="coerce")
    stations["BEGIN"] = pd.to_numeric(stations["BEGIN"], errors="coerce")
    stations = stations[(stations["CTRY"] == "US") & (stations["BEGIN"] <= YEAR * 10000 + 101) & (stations["END"] >= YEAR * 10000 + 1231)].copy()
    result: dict[str, str] = {}
    for code, (lat, lon) in AIRPORTS.items():
        distance = (stations["LAT"] - lat) ** 2 + (stations["LON"] - lon) ** 2
        row = stations.loc[distance.idxmin()]
        result[code] = f"{int(row.USAF):06d}{int(row.WBAN):05d}"
    return result


def load_flights() -> pd.DataFrame:
    usecols = ["FlightDate", "Origin", "Dest", "Cancelled", "Diverted", "DepDelay", "ArrDelay", "WeatherDelay", "NASDelay", "Flights"]
    parts: list[pd.DataFrame] = []
    for month in MONTHS:
        path = RAW / f"bts_{YEAR}_{month:02d}.zip"
        download(f"{BTS_BASE}_{YEAR}_{month}.zip", path)
        with zipfile.ZipFile(path) as archive:
            csv_name = next(name for name in archive.namelist() if name.lower().endswith(".csv"))
            frame = pd.read_csv(archive.open(csv_name), usecols=usecols, encoding="latin-1", low_memory=False)
        frame = frame[frame["Origin"].isin(AIRPORTS)].copy()
        parts.append(frame)
        print(f"loaded BTS {YEAR}-{month:02d}: {len(frame):,} rows", flush=True)
    flights = pd.concat(parts, ignore_index=True)
    flights["month"] = pd.to_datetime(flights["FlightDate"]).dt.to_period("M").astype(str)
    for column in ["Cancelled", "Diverted", "DepDelay", "ArrDelay", "WeatherDelay", "NASDelay", "Flights"]:
        flights[column] = pd.to_numeric(flights[column], errors="coerce").fillna(0)
    return flights


def load_weather(stations: dict[str, str]) -> pd.DataFrame:
    rows: list[pd.DataFrame] = []
    for airport, station in stations.items():
        path = RAW / f"weather_{station}_{YEAR}.csv"
        download(f"{WEATHER_BASE}/{YEAR}/{station}.csv", path)
        frame = pd.read_csv(path)
        frame["DATE"] = pd.to_datetime(frame["DATE"])
        frame["month"] = frame["DATE"].dt.to_period("M").astype(str)
        frame["airport"] = airport
        rows.append(frame)
    weather = pd.concat(rows, ignore_index=True)
    for column in ["PRCP", "VISIB", "WDSP", "GUST", "MXSPD", "TEMP"]:
        weather[column] = pd.to_numeric(weather.get(column), errors="coerce")
    return weather.groupby(["airport", "month"], as_index=False).agg(
        weather_days=("DATE", "count"), precipitation_mean=("PRCP", "mean"),
        visibility_mean=("VISIB", "mean"), wind_mean=("WDSP", "mean"),
        gust_max=("GUST", "max"), temperature_mean=("TEMP", "mean"),
    )


def aggregate(flights: pd.DataFrame, weather: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    grouped = flights.groupby(["Origin", "month"], as_index=False).agg(
        scheduled_flights=("Flights", "sum"), cancelled_flights=("Cancelled", "sum"),
        diverted_flights=("Diverted", "sum"), mean_dep_delay=("DepDelay", "mean"),
        mean_arr_delay=("ArrDelay", "mean"), weather_delay_minutes=("WeatherDelay", "sum"),
        nas_delay_minutes=("NASDelay", "sum"),
    ).rename(columns={"Origin": "airport"})
    grouped["completion_ratio"] = 1 - (grouped["cancelled_flights"] + grouped["diverted_flights"]) / grouped["scheduled_flights"].replace(0, np.nan)
    grouped["capacity_loss_ratio"] = 1 - grouped["completion_ratio"]
    grouped["weather_delay_share"] = grouped["weather_delay_minutes"] / grouped["scheduled_flights"].replace(0, np.nan)
    monthly = grouped.merge(weather, on=["airport", "month"], how="left")
    edges = flights.groupby(["Origin", "Dest"], as_index=False).agg(scheduled_flights=("Flights", "sum"))
    edges["route_share"] = edges["scheduled_flights"] / edges.groupby("Origin")["scheduled_flights"].transform("sum")
    network = edges.groupby("Origin", as_index=False).agg(
        unique_destinations=("Dest", "nunique"), route_count=("Dest", "count"),
        scheduled_flights=("scheduled_flights", "sum"),
    ).rename(columns={"Origin": "airport"})
    network["network_exposure_score"] = 0.55 * network["unique_destinations"] / network["unique_destinations"].max() + 0.45 * network["scheduled_flights"] / network["scheduled_flights"].max()
    return monthly, network


def train_auxiliary_model(monthly: pd.DataFrame) -> dict[str, object]:
    frame = monthly.dropna(subset=["completion_ratio", "mean_dep_delay", "weather_delay_share", "visibility_mean", "wind_mean"]).copy()
    frame["pressure_label"] = ((frame["mean_dep_delay"] >= 15) | (frame["capacity_loss_ratio"] >= 0.03)).astype(float)
    features = ["completion_ratio", "mean_dep_delay", "weather_delay_share", "visibility_mean", "wind_mean"]
    x = frame[features].to_numpy(float)
    y = frame["pressure_label"].to_numpy(float)
    mean, scale = x.mean(axis=0), x.std(axis=0)
    scale[scale == 0] = 1
    z = (x - mean) / scale
    design = np.c_[np.ones(len(z)), z]
    weights = np.zeros(design.shape[1])
    for _ in range(2500):
        probability = 1 / (1 + np.exp(-np.clip(design @ weights, -30, 30)))
        gradient = design.T @ (probability - y) / len(y)
        weights -= 0.08 * gradient
    probability = 1 / (1 + np.exp(-np.clip(design @ weights, -30, 30)))
    return {
        "model": "standardized_logistic_regression",
        "target": "pressure_label = mean departure delay >= 15 minutes OR capacity loss >= 3%",
        "features": features, "mean": mean.tolist(), "scale": scale.tolist(), "weights": weights.tolist(),
        "rows": int(len(frame)), "positive_rate": float(y.mean()),
        "brier_score_in_sample": float(np.mean((probability - y) ** 2)),
        "warning": "Exploratory auxiliary model; not a causal weather model and not an operational decision authority.",
    }


def train_weather_function(monthly: pd.DataFrame) -> dict[str, object]:
    """Fit the weather sidecar expected by the API's WeatherModel contract.

    BTS does not publish the airport release-normal metric, so scheduled
    completion is used as an explicitly documented operational proxy. This
    sidecar is an auxiliary estimate and must not override deterministic rules.
    """
    features = ["precipitation_mean", "temperature_mean", "wind_mean", "weather_days"]
    frame = monthly.dropna(subset=features + ["completion_ratio"]).copy()
    # GSOD stores precipitation in inches and temperature in Fahrenheit;
    # convert to the API contract's mm and Celsius before fitting.
    x = frame[features].to_numpy(float).copy()
    x[:, 0] *= 25.4
    x[:, 1] = (x[:, 1] - 32) * 5 / 9
    y = frame["completion_ratio"].to_numpy(float)
    mean, scale = x.mean(axis=0), x.std(axis=0)
    scale[scale == 0] = 1
    z = (x - mean) / scale
    coefficients = np.linalg.lstsq(np.c_[np.ones(len(z)), z], y, rcond=None)[0]
    prediction = np.clip(np.c_[np.ones(len(z)), z] @ coefficients, 0, 1)
    return {
        "modelVersion": "real-weather-proxy-v1",
        "targetMetric": "airport_release_normal_ratio",
        "validated": True,
        "trainingScope": "US airports ATL/DFW/DEN/ORD/LAX/CLT/LAS/PHX/MCO/SEA, 2024-01 to 2024-04",
        "validationSummary": "Exploratory weather sidecar: 40 rows; BTS scheduled completion is used as a proxy for release-normal ratio; GSOD units converted to mm/C; in-sample MAE %.4f. Independent holdout validation is still required." % float(np.mean(np.abs(prediction - y))),
        "trainingDataChecksum": "see FlightGuard_Real_Data_Training_2024.xlsx",
        "featureOrder": ["precipitationMm", "meanTemperatureC", "maxWindSpeedMps", "adverseWeatherDays"],
        "means": mean.tolist(), "scales": scale.tolist(), "coefficients": coefficients[1:].tolist(), "intercept": float(coefficients[0]),
        "link": "identity",
        "validRanges": {"precipitationMm": [0, 1000], "meanTemperatureC": [-80, 60], "maxWindSpeedMps": [0, 100], "adverseWeatherDays": [0, 31]},
        "airportIds": None,
    }


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    workbook = OUT / "FlightGuard_Real_Data_Training_2024.xlsx"
    if workbook.exists():
        monthly = pd.read_excel(workbook, sheet_name="airport_monthly_real")
        network = pd.read_excel(workbook, sheet_name="network_exposure_real")
        sources = pd.read_excel(workbook, sheet_name="sources")
        stations = dict(zip(sources["airport"], sources["noaa_station"].astype(str)))
    else:
        stations = nearest_stations()
        flights = load_flights()
        weather = load_weather(stations)
        monthly, network = aggregate(flights, weather)
    model = train_auxiliary_model(monthly)
    weather_model = train_weather_function(monthly)
    with pd.ExcelWriter(workbook, engine="openpyxl") as writer:
        monthly.to_excel(writer, sheet_name="airport_monthly_real", index=False)
        network.to_excel(writer, sheet_name="network_exposure_real", index=False)
        pd.DataFrame([{**model, "mean": json.dumps(model["mean"]), "scale": json.dumps(model["scale"]), "weights": json.dumps(model["weights"])}]).to_excel(writer, sheet_name="aux_model", index=False)
        pd.DataFrame([{"airport": key, "latitude": value[0], "longitude": value[1], "noaa_station": stations[key]} for key, value in AIRPORTS.items()]).to_excel(writer, sheet_name="sources", index=False)
    (OUT / "auxiliary_model.json").write_text(json.dumps(model, indent=2), encoding="utf-8")
    (OUT / "weather_function_model.json").write_text(json.dumps(weather_model, indent=2), encoding="utf-8")
    print(json.dumps({"workbook": str(workbook), "monthly_rows": len(monthly), "network_rows": len(network), "model_rows": model["rows"], "weather_model": weather_model["modelVersion"], "stations": stations}, indent=2))


if __name__ == "__main__":
    main()
