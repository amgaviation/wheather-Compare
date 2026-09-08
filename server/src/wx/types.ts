/** Shared aviation weather types. All times are UTC epoch milliseconds unless noted. */

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
export const CATEGORY_ORDER: FlightCategory[] = ['VFR', 'MVFR', 'IFR', 'LIFR'];
/** Higher = worse. */
export const CATEGORY_RANK: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

export interface Wind {
  /** True direction in degrees, null when variable or calm. */
  dirDeg: number | null;
  variable: boolean;
  speedKt: number;
  gustKt: number | null;
  /** Variable range (e.g. 180V240) when reported. */
  varFromDeg?: number;
  varToDeg?: number;
  /** Original unit for traceability. */
  unit: 'KT' | 'MPS' | 'KMH';
}

export type CloudCover = 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV' | 'CLR' | 'SKC' | 'NSC' | 'NCD';

export interface CloudLayer {
  cover: CloudCover;
  /** Base in feet AGL, null for CLR/SKC or unknown (///). */
  baseFt: number | null;
  type?: 'CB' | 'TCU';
}

export interface WxPhenomenon {
  raw: string;
  intensity: '-' | '+' | 'VC' | '';
  descriptor: string | null; // MI BC PR DR BL SH TS FZ
  phenomena: string[]; // DZ RA SN SG IC PL GR GS UP BR FG FU VA DU SA HZ PY PO SQ FC SS DS
}

/** Visibility in statute miles. `plus` = "greater than" (P6SM, 10+). */
export interface Visibility {
  sm: number;
  plus: boolean;
  /** Meters when reported in ICAO format (9999 etc.). */
  meters?: number;
  /** Less than (M1/4SM). */
  less?: boolean;
}

export interface RunwayVisualRange {
  runway: string;
  minFt: number;
  maxFt: number | null;
  /** 'P' = more than, 'M' = less than */
  qualifier: 'P' | 'M' | null;
  trend: 'U' | 'D' | 'N' | null;
}

/** The common weather element bundle shared by METAR bodies and TAF groups. */
export interface Conditions {
  wind: Wind | null;
  visibility: Visibility | null;
  weather: WxPhenomenon[];
  clouds: CloudLayer[];
  /** Vertical visibility in feet when sky obscured. */
  verticalVisFt: number | null;
  cavok: boolean;
  /** NSW in TAF: explicitly no significant weather. */
  nsw?: boolean;
  windShear?: { heightFt: number; dirDeg: number; speedKt: number } | null;
}

export interface MetarRemarks {
  automated: 'AO1' | 'AO2' | null;
  slpHpa: number | null;
  tempPreciseC: number | null;
  dewpPreciseC: number | null;
  peakWind: { dirDeg: number; speedKt: number; hh: number | null; mm: number } | null;
  windShiftMin: number | null;
  frontalPassage: boolean;
  pressureTendency: { code: number; changeHpa: number } | null;
  pressureRisingRapidly: boolean;
  pressureFallingRapidly: boolean;
  precip1hrIn: number | null;
  precip3or6hrIn: number | null;
  precip24hrIn: number | null;
  maxTemp6hrC: number | null;
  minTemp6hrC: number | null;
  maxTemp24hrC: number | null;
  minTemp24hrC: number | null;
  snowDepthIn: number | null;
  variableCeiling: { minFt: number; maxFt: number } | null;
  variableVis: { minSm: number; maxSm: number } | null;
  towerVisSm: number | null;
  surfaceVisSm: number | null;
  lightning: string | null;
  thunderstormBeganEnded: string | null;
  sensorFlags: string[]; // TSNO RVRNO PWINO FZRANO PNO SLPNO VISNO CHINO
  maintenanceNeeded: boolean;
  other: string[];
}

export interface Metar {
  raw: string;
  station: string;
  type: 'METAR' | 'SPECI';
  /** Observation time (UTC ms). */
  time: number;
  auto: boolean;
  corrected: boolean;
  nil: boolean;
  cond: Conditions;
  rvr: RunwayVisualRange[];
  tempC: number | null;
  dewpC: number | null;
  altimeterInHg: number | null;
  qnhHpa: number | null;
  remarks: MetarRemarks;
  /** Derived. */
  ceilingFt: number | null;
  category: FlightCategory | null;
  parseWarnings: string[];
}

export type TafChangeKind = 'BASE' | 'FM' | 'BECMG' | 'TEMPO' | 'PROB30' | 'PROB40' | 'PROB30 TEMPO' | 'PROB40 TEMPO';

export interface TafGroup {
  kind: TafChangeKind;
  raw: string;
  /** Start of applicability (UTC ms). */
  from: number;
  /** End of applicability (UTC ms). For FM: start of next FM or TAF end. */
  to: number;
  probability: number | null; // 30 / 40
  cond: Conditions;
  /** Elements explicitly present in the group (for inheritance logic). */
  has: { wind: boolean; visibility: boolean; weather: boolean; clouds: boolean };
  /** Ceiling and category of the group standing alone (before inheritance). */
  parseWarnings: string[];
}

export interface Taf {
  raw: string;
  station: string;
  amended: boolean;
  corrected: boolean;
  cancelled: boolean;
  nil: boolean;
  /** Issue time (UTC ms). */
  issued: number;
  validFrom: number;
  validTo: number;
  groups: TafGroup[];
  maxTemp: { c: number; time: number } | null;
  minTemp: { c: number; time: number } | null;
  parseWarnings: string[];
}

/** One-hour slice of an expanded TAF. */
export interface TafHour {
  time: number; // start of hour UTC ms
  prevailing: Conditions;
  prevailingCeilingFt: number | null;
  prevailingCategory: FlightCategory | null;
  /** Alternate states that may occur during this hour (TEMPO/PROB/BECMG transition). */
  alternates: Array<{
    kind: TafChangeKind;
    probability: number; // 0-1 assumed likelihood
    cond: Conditions;
    ceilingFt: number | null;
    category: FlightCategory | null;
  }>;
  worstCategory: FlightCategory | null;
  worstCeilingFt: number | null;
  worstVisSm: number | null;
  /** Which group(s) produced the prevailing state. */
  sourceGroups: string[];
}
