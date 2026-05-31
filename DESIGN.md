# HEMS — Home Energy Management System
## Ontwerp- en Architectuurdocument

---

## 1. Doel en Visie

### Waarom dit systeem?

Steeds meer huishoudens hebben zonnepanelen, een elektrische auto en een thuisaccu. Elk apparaat heeft zijn eigen app die alleen naar zichzelf kijkt. Het gevolg: de zonnepanelen leveren terug aan het net terwijl de accu leeg is, of de EV laadt van het net terwijl de zon vol schijnt.

Het HEMS-systeem orkestreert alle energiestromen in één logica:

> **Gebruik zelf zoveel mogelijk van wat je opwekt. Laad de EV op zonnestroom. Bewaar genoeg in de accu voor de nacht. Lever pas terug als alles vol is.**

### Kernprincipes

1. **Zon is primair** — alles wat de EV en accu nodig hebben, komt bij voorkeur van de zon
2. **Geen klapperen** — systeem schakelt stabiel, geen aan/uit per minuut
3. **Vooruitdenken** — dagplanning op basis van weersverwachting, niet alleen reactief
4. **Leren van gedrag** — eigen verbruikspatronen worden gemeten en gebruikt in de planning
5. **Transparantie** — alles zichtbaar in twee dashboard-widgets

---

## 2. Systeemarchitectuur

```
Open-Meteo API
     │ weersverwachting (straling W/m²)
     ▼
PlanningEngine ──────────────────────────────────────────────┐
  │ dagplan (schedule[24])                                    │
  ▼                                                           │
EmsManager (tick elke 60s)                                   │
  │                                                           │
  ├── HomeWizardAdapter → P1 meter (gridW, pvW per fase)     │
  ├── BatteryAdapter    → inverter (soc, powerW)             │
  ├── TeslaEvAdapter    → Wall Connector + Tesla app          │
  ├── ThermostatAdapter → warmtepomp thermostaten            │
  └── DumpLoadAdapter   → overschot schakelaar               │
                                                              │
Homey flows ←──── FlowManager (trigger cards) ←─────────────┘
Dashboard   ←──── Widgets (EMS Morgen + EMS Vandaag)
Tijdlijn    ←──── NotificationManager
```

---

## 3. Weersdata — Open-Meteo API

### Waarom Open-Meteo?

- Gratis, geen API-key, GDPR-compliant
- Geeft **uurlijkse shortwave_radiation (W/m²)** — direct bruikbaar voor PV-berekening
- Bevat ook: temperatuur, bewolking, neerslag
- Locatie: automatisch van Homey's geolocation

### API-aanroep

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude={lat}
  &longitude={lon}
  &hourly=temperature_2m,cloud_cover,shortwave_radiation,precipitation_probability,wind_speed_10m
  &daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,shortwave_radiation_sum
  &forecast_days=3
  &timezone=Europe/Amsterdam
```

### Caching en retry

- Cache: 1 uur (voorkomt overbelasting bij meerdere herberekeningen)
- Bij fout: 2 pogingen (10s tussenpoze, timeout 15s)
- Na 2 mislukkingen: fallback (vlakke curve, 0 W/m² straling)
- Fallback geeft melding in tijdlijn

### Verwerking

De ruwe JSON wordt geparsed naar:

```javascript
forecast = {
  today:    { hourly: [{hour, radiationW, cloudCoverPct, tempC}], dayMax, avgCloudPct },
  tomorrow: { hourly: [...], dayMax, avgCloudPct },
  tonight:  { nightMin }   // min temp 22:00-06:00 voor verwarmen/koelen beslissing
}
```

---

## 4. PV-productiecurve — De Parabool

### Formule (STC-methode)

```
expectedKw = (radiationW / 1000) × peakKwp × 0.80
```

- `radiationW`: straling op dat uur (W/m²) van Open-Meteo
- `1000`: STC-norm (Standard Test Conditions) — panelen worden gemeten bij 1000 W/m²
- `peakKwp`: geïnstalleerd piekstroom in kilowatt-peak
- `0.80`: systeemrendement (omvormerverliezen, kabels, temperatuur)

**Waarom geen oppervlak nodig:** het kWp-getal bevat al het oppervlak × paneel-rendement × 1000 W/m². Door te delen door 1000 krijg je een factor 0-1 die je direct met kWp kunt vermenigvuldigen.

### Piekuur per fase (oriëntatie-correctie)

Panelen op verschillende dakvlakken produceren op verschillende tijdstippen. Een oost-gericht vlak piekt vroeg, een west-gericht vlak piekt laat.

**Instelling:** per fase (L1/L2/L3) stel je het piekuur in (standaard: 13 = zuiden).

**Correctie:** voor elke fase wordt een Gaussische wegingsfunctie berekend:

```
weight(h) = exp( -((h - peakHour)² / (2 × σ²)) )    σ = 3.0 uur

fraction(h) = weight(h) / sum(weight[0..23])

stringRadW(h) = radiationByHour[h] × (str.peakKw/total) +
                (totalDailyRad/24) × (fraction - 1/24) × str.peakKw/total × 2
```

Dit verschuift de curve naar links (oost) of rechts (west) zonder de totale dagenergie te veranderen.

**Oriëntatie-richtlijnen:**

| Richting | Piekuur |
|----------|---------|
| Oost     | 9-10    |
| Zuidoost | 11      |
| Zuiden   | 13      |
| Zuidwest | 15      |
| West     | 16-17   |

---

## 5. Planningslogica (PlanningEngine)

### Twee plannen naast elkaar

| Plan | Variabele | Doel |
|------|-----------|------|
| Vandaag | `_planToday` | Operationeel: stuurt EV/accu/WP realtime |
| Morgen | `_planTomorrow` | Preview: EMS Morgen widget |

### Herberekeningsschema

| Tijd | Target | Reden |
|------|--------|-------|
| 04:00 | today | Verse ochtendverwachting + nachtload berekend |
| 12:00 | today | Middag-update bewolking |
| 19:00 | tomorrow | Vroege avondplanning |
| 22:00 | tomorrow | Definitieve planning |
| Start app | today/tomorrow | Direct na herstart (netwerk ready na 30s) |

### Prioriteitsvolgorde in het plan

```
1. Huisverbruik            — altijd gedekt
2. Thuisaccu nachtreserve  — minimum wat de accu moet bewaren
3. EV laden (solar-first)  — alleen als zon surplus ≥ EV-drempel
4. Thuisaccu bijladen      — resterende surplus
5. Warmtepomp offset       — per fase, bij surplus
6. Dump load               — als alles vol is
```

### Uurlijkse schedule-bouw

Voor elk uur (0-23) wordt berekend:

```
netKwh = pvKwh - consumKwh - evFixedLoad

Als netKwh > 0 (surplus):
  → Accu laden (tot max, cap op batMaxChargeKw)
  → EV laden (alleen als netKwh ≥ evMinKwhPerH)
  → Dump load

Als netKwh < 0 (tekort) EN geen zonne-uur:
  → Accu ontladen (niet tijdens zonne-uren met EV aan!)

Zonne-uur = pvKwh ≥ 0.1 kWh in dat uur
```

### EV thuis-check

Voor het bepalen van `evNeededKwh`: als de auto op de doeldatum niet thuis is (thuisdag-instellingen), wordt `evNeededKwh = 0` en wordt er geen EV-laden ingepland.

```javascript
const evIsHome = settings.get(`ev_home_${['sun','mon',...][targetDate.getDay()]}`)
                 ?? (targetDate.getDay() === 0 || targetDate.getDay() === 6)
```

---

## 6. EV Laadstrategie (Strategie B)

### Real-time beslissing (elke 60s)

```
surplusW = evLoadW - gridW - targetImportW

Start EV:  surplusW ≥ minPowerW (5A × fasen × 230V)
Stop EV:   surplusW < -200W
Stroom:    altijd vast op minCurrentA (standaard 5A)
```

**Waarom geen dynamisch rampen:** de thuisaccu absorbeert fluctuaties beter dan de laadpaal. Vaste stroom geeft minder stress op de laadpaal en stabieler gedrag.

### Piekblokken

Twee dagelijkse vensters waarbij EV-laden altijd gestopt wordt (bijv. 07:00-09:00 en 17:00-21:00). Tijdens piekblok: accu ontlaadt maximaal voor het huis.

**Uitzondering:** als een rit-deadline nadert en de auto niet vol is → fast_charge overschrijft het piekblok.

### Solar-first check (planning)

```
solarCoversEv = (totalPvKwh - totalConsumKwh) ≥ evNeededKwh

Zo ja:  alleen laden van zonne-surplus (geen nacht/netlading gepland)
Zo nee: kijk of nachtladen van accu helpt
```

### Nachtladen van accu

Als zon niet voldoende is voor EV:

```
batAvailableForEv = batCurrentKwh - batReserveKwh

EV laadt van accu totdat batAvailableForEv op is
→ Accu naar idle
→ EV laadt verder van net
→ EV klaar → accu terug naar auto-mode
```

---

## 7. Battery Reserve

### Berekening

```
nightLoad    = gemiddelde huislast van laatste 3 nachten
               (zonsondergang → zonsopkomst, EV uitgesloten)
               Sleutel: night_load_YYYYMMDD

morningPeak  = huislast van zonsopkomst tot eerste solar-EV-startuur
               (uur waarbij pvKwh×1000 - consumKwh×1000 ≥ evMinPowerW)
               Gebaseerd op rolling day load

batReserveKwh = nightLoad + morningPeak
```

### Fallback bij geen data

Als er nog geen historische data is (eerste dag):
```
batReserveKwh ≈ batCapacityKwh × 0.30  (30% van capaciteit)
```

### Berekening tijdstip

- **Night load**: berekend bij de 04:00-herberekening (vorige nacht is dan compleet)
- **Day load**: berekend bij de 19:00-herberekening (dag is vrijwel voorbij)
- Opslag: per dag als `night_load_YYYYMMDD` en `day_load_YYYYMMDD` (array[24])

---

## 8. Verbruiksdata (Actuals)

### 10-minuten resolutie

Elke minuut slaat de EMS een voortschrijdend gemiddelde op per 10-minuten slot:

```
Sleutel: actuals_YYYYMMDD_HH_S   (S = 0-5, slot binnen het uur)
Waarden: { n, pvW, gridW, batW, evW }
```

144 slots per dag (24u × 6 slots). Worden gebruikt door:
- EMS Vandaag widget (grafiek met actuals)
- Night/day load berekening

### Night Load meting

```
nightLoad_kWh = Σ max(0, gridW - evW) × (10/60/1000)
                voor elk slot van zonsondergang tot zonsopkomst
```

### Day Load meting

```
dayLoad[h] = Σ max(0, pvW + gridW - evW) × (10/60/1000)
             voor elk slot in uur h, van zonsopkomst tot zonsondergang
```

---

## 9. Warmtepomp — Fase-bewuste Offset

### Principe

Bij zonne-overschot op een specifieke fase: verhoog de setpoint van de warmtepomp op die fase (verwarmen) of verlaag (koelen). Zo wordt overtollige energie thermisch opgeslagen.

### Per-fase logica

```
Voor elke warmtepomp met toegewezen fase X:
  phaseGridW = gridPhases[X-1]

  Als phaseGridW < -drempel → surplus op fase X → setpoint omhoog
  Als phaseGridW >  drempel → tekort op fase X → setpoint omlaag
  Anders                    → normaal
```

Warmtepomp met fase = 0 (Alle fasen) gebruikt het totale surplus.

### Verwarmen vs. Koelen

Automatische seizoensschakelaar op basis van weersverwachting (één keer per dag):

```
Als nachtMin > 10°C EN dagMax > 17°C → Koelen
Anders                               → Verwarmen

Verwarmen + surplus → setpoint ↑ (meer warmte opslaan)
Koelen   + surplus → setpoint ↓ (meer koude opslaan)
```

---

## 10. Instellingen — Overzicht

### 🔌 Net & Aansluiting

| Instelling | Beschrijving |
|------------|-------------|
| Netmeter (P1) | HomeWizard of andere P1-meter |
| Fasen | 1 of 3 fasen |
| Max capaciteit (A) | Hoofdzekering |
| Contract type | Vast tarief of Dynamisch |
| Inkoopprijs (€/kWh) | Voor vast contract |
| Terugleverprijs (€/kWh) | Voor vast contract |
| Prijsprovider | ENTSO-E (gratis) of Tibber |
| API key | Vereist voor Tibber |

### ☀️ Zonnepanelen

| Instelling | Beschrijving |
|------------|-------------|
| PV-meter | Omvormer kWh-meter |
| Piekvermogen (kWp) | Totaal of per fase (L1/L2/L3) |
| Piekuur L1/L2/L3 | Uur van maximale productie per fase (0-23) |

Het piekuur bepaalt de vorm van de parabool per fase. Standaard 13 (zuiden).

### 🔋 Thuisaccu

| Instelling | Beschrijving |
|------------|-------------|
| Accu apparaat | Growatt/SolarEdge/etc. in Homey |
| Capaciteit (kWh) | Totale opslagcapaciteit |
| Max laadvermogen (W) | Begrenst laadsnelheid in planning |
| Max ontlaadvermogen (W) | Begrenst ontlaadsnelheid in planning |

### 🚗 Elektrische auto

| Instelling | Beschrijving |
|------------|-------------|
| EV apparaat | Tesla of andere EV in Homey |
| Wall Connector IP | Lokale meting (optioneel) |
| Aparte laadpaal | Extra laadpaal apparaat |
| Batterijcapaciteit (kWh) | Voor EV-energieberekening |
| Standaard doel SoC (%) | Laad tot dit % als geen rit gepland |
| Laadmodus | Zie tabel hieronder |
| Min laadstroom (A) | Start-drempel strategie B (IEC min = 5A) |
| Max laadstroom (A) | Plafond bij snel laden |
| Netbuffer (W) | Kleine import-buffer bij faseongelijkheid |
| Ochtendpiek van/tot | EV geblokkeerd venster 1 |
| Avondpiek van/tot | EV geblokkeerd venster 2 |
| Uitstelduur (min) | Bij belastingsbalancering flow |
| 's Nachts laden van net | Nachtvenster voor netlading |
| Nachtvenster van/tot | Tijdvenster nachtlading |
| Auto staat thuis op | Weekdagen dat auto op oprit staat |

**Laadmodi:**

| Modus | Gedrag |
|-------|--------|
| Alleen zon | Strategie B: 5A vast bij surplus ≥ drempel |
| Zon + net | Zolvolgend + nachtladen als gepland |
| Vast vermogen | Altijd op vaste stroom |
| Snel laden | Altijd op maximale stroom |
| Uit | EMS beheert EV niet |

### 🌡️ Warmtepomp

| Instelling | Beschrijving |
|------------|-------------|
| WP 1/2/3 apparaat | Thermostaat apparaat |
| Netfase WP 1/2/3 | L1/L2/L3 of Alle fasen |
| Offset bij overschot (°C) | Setpoint aanpassing bij surplus |

### ⚙️ EMS Gedrag

| Instelling | Beschrijving |
|------------|-------------|
| Overschot drempel (W) | Minimaal surplus voor acties |

---

## 11. Dashboard Widgets

### Beide widgets: zelfde formaat

```
┌─────────────────────────────────────────────┐
│ Titel                            [badge]     │
│                                              │
│  [☀️ Zon]  [⚡ Net]  [🔋 Accu]  [🚗 EV]    │
│  totaal    import/  vermogen    vermogen     │
│            export   + SoC%                  │
│                                              │
│  ┌─────────────────────────────────────────┐│
│  │                                         ││
│  │              Grafiek                    ││
│  │                                         ││
│  └─────────────────────────────────────────┘│
│                                              │
│ [status links]              [tijd rechts]   │
└─────────────────────────────────────────────┘
```

### Widget 1 — EMS Morgen (altijd MORGEN)

**Tegeltjes (totalen uit plan):**
- ☀️ Zon: totale verwachte dagproductie (kWh)
- 🔋 Accu: beschikbare accuenergie (kWh)
- 🚗 EV: benodigde laadenergie (kWh, 0 als niet thuis)
- Badge: ✅ Haalbaar / ⚠️ Krap

**Grafiek (alleen stippellijnen = planning):**
- 🟢 Groen vlak: verwachte zonproductie
- 🔴 Rood gestippeld: verwacht huisverbruik
- 🟠 Oranje vlak: geplande EV-lading (surplus ná verbruik)
- 🟡 Geel vlak: geplande accubelading
- 🔵 Blauw vlak: geplande accu-ontlading
- 🟡 Rechter-as gestippeld: verwachte accu-SoC

**Databron:** `planningEngine._planTomorrow`

### Widget 2 — EMS Vandaag (altijd VANDAAG)

**Tegeltjes (live waarden):**
- ☀️ Zon: huidige productie (W)
- ⚡ Net: ↓ import rood / ↑ export groen (W)
- 🔋 Accu: huidig vermogen + SoC %
- 🚗 EV: huidig laadvermogen of "–"

**Grafiek (combinatie):**
- Stippellijnen: voorspelling van vandaag (uit `_planToday`)
- Solid vlakken: gemeten actuals (10-minuten resolutie)
- Stippellijnen lopen door voor uren die nog niet gemeten zijn

**Databron actuals:** `actuals_YYYYMMDD_HH_S` via `getActuals` API
**Databron forecast:** `planningEngine._planToday` via `getTodayPlan` API

---

## 12. Notificaties (Homey tijdlijn)

| Gebeurtenis | Bericht | Trigger |
|-------------|---------|---------|
| Plan berekend | ✅/⚠️ Plan [dag]: X kWh zon, Y kWh EV | Alleen geplande recalcs (niet handmatig) |
| Plan krap | ⚠️ Dagplan krap — onvoldoende zon | prio1NotFeasible event |
| EV gestart | 🚗 EV laden gestart — XXXW | evChargingStarted |
| EV gestopt | 🔌 EV laden gestopt — X.X kWh | evChargingStopped |
| Reserve bereikt | 🔋 Accu reserve bereikt — EV op net | Night EV switching |
| WP omgeschakeld | 🌡️ Warmtepomp → koelen/verwarmen | heatpumpModeChanged |
| EV klaar | ✅ EV klaar voor vertrek — XX% | evReadyForDeparture |
| Accu laag | 🔋 Thuisaccu onder minimum — XX% | batteryBelowMinimum |
| Weersdata fout | ❌ Weersdata mislukt na 2 pogingen | Na 2 retries |

---

## 13. Flows — Trigger Cards

| Trigger | Tokens | Gebruik |
|---------|--------|---------|
| EMS wil EV laden starten | — | → Tesla: Start het opladen |
| EMS wil EV laden stoppen | — | → Tesla: Stop het opladen |
| EMS wil laadstroom instellen | current (A) | → Tesla: Stel laadstroom in |
| EMS modus gewijzigd | mode | Loggen of notificatie |
| EV klaar voor vertrek | soc (%) | Melding sturen |
| Dagplan krap | — | Alternatieve actie instellen |
| Warmtepomp omgeschakeld | mode | Loggen |

---

## 14. Toetsing nieuwe functionaliteit

Bij elke nieuwe feature, check:

1. **Klopt het met de prioriteitsvolgorde?** (Sectie 5)
2. **Verstoort het de solar-first logica?** EV mag nooit meer laden dan wat zon oplevert tenzij nachtlading gepland
3. **Widget impact**: toont EMS Morgen nog altijd morgen? Toont EMS Vandaag alleen actuals + vandaag's forecast?
4. **Notificatie-spam**: stuurt het geen melding bij handmatige acties?
5. **Accu-reserve**: wordt `batReserveKwh` gerespecteerd bij nieuwe ontlaad-logica?
6. **Thuisdag-check**: geldt de nieuwe logica ook niet als auto er niet is?
