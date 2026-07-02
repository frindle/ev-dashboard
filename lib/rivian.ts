import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { markRivianReauthRequired, markRivianReauthDueSoon, clearRivianReauthFlags } from './sessionFlags';

const GATEWAY = 'https://rivian.com/api/gql/gateway/graphql';

// Rivian sessions appear to last on the order of 90 days with no documented
// refresh mutation. Track from savedAt so we can warn the user at day 83
// and hard-flag at day 90 before we start seeing 401s in the wild.
const RIVIAN_SESSION_DAYS = 90;
const RIVIAN_SESSION_WARN_DAYS = 7;

export function checkRivianSessionAge(): { daysOld: number; daysLeft: number } | null {
  const t = readRivianTokens();
  if (!t) return null;
  const daysOld = Math.floor((Date.now() - t.savedAt) / (24 * 60 * 60 * 1000));
  const daysLeft = RIVIAN_SESSION_DAYS - daysOld;
  if (daysLeft <= 0) {
    markRivianReauthRequired(`session age ${daysOld}d ≥ ${RIVIAN_SESSION_DAYS}d`);
  } else if (daysLeft <= RIVIAN_SESSION_WARN_DAYS) {
    markRivianReauthDueSoon(daysLeft);
  }
  return { daysOld, daysLeft };
}

// Exported so a successful login callback can wipe the reauth flags.
export function noteRivianAuthRefreshed(): void {
  clearRivianReauthFlags();
}

// ── Exponential backoff on state-poll errors ─────────────────────────────
// Community guidance: Rivian throttling is opaque. Back off 15/30/60/120/240 min
// on consecutive errors and reset on the first success.
const BACKOFF_STEPS_MIN = [15, 30, 60, 120, 240];
let backoffAttempt = 0;
let nextAllowedAt = 0;

function nextBackoffMs(): number {
  const idx = Math.min(backoffAttempt, BACKOFF_STEPS_MIN.length - 1);
  return BACKOFF_STEPS_MIN[idx] * 60 * 1000;
}

function inBackoffWindow(): boolean {
  return Date.now() < nextAllowedAt;
}

function recordBackoffError(): void {
  backoffAttempt = Math.min(backoffAttempt + 1, BACKOFF_STEPS_MIN.length);
  nextAllowedAt = Date.now() + nextBackoffMs();
  console.warn(`[rivian] backoff step ${backoffAttempt}, next attempt in ${nextBackoffMs() / 60000}m`);
}

function resetBackoff(): void {
  if (backoffAttempt !== 0) {
    console.log('[rivian] backoff reset after successful fetch');
  }
  backoffAttempt = 0;
  nextAllowedAt = 0;
}

const BASE_HEADERS = {
  'User-Agent': 'RivianApp/707 CFNetwork/1237 Darwin/20.4.0',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Apollographql-Client-Name': 'com.rivian.ios.consumer-apollo-ios',
};

export interface RivianTokens {
  accessToken: string;
  refreshToken: string;
  userSessionToken: string;
  appSessionToken: string;
  csrfToken: string;
  vehicleId: string;
  savedAt: number;
}

export interface RivianVehicleState {
  chargePercent: number;      // batteryLevel.value (0-100)
  chargeLimit: number;        // batteryLimit.value (0-100)
  isCharging: boolean;
  isPluggedIn: boolean;
  isThrottled: boolean;       // chargerDerateStatus indicates active throttling
  derateReason: string;       // raw chargerDerateStatus value
  chargingState: string;      // chargerState.value raw string
  isLocked: boolean;
  climateOn: boolean;
  rangeMi: number;            // distanceToEmpty.value (miles)
  odometer: number;           // vehicleMileage.value (miles)
  chargeRateMph: number;      // not reported by Rivian API — always 0
  addedRangeMi: number;       // not reported by Rivian API — always 0
  minutesToFull: number;      // timeToEndOfCharge.value
  online: boolean;
  lat: number | null;         // gnssLocation.latitude
  lon: number | null;         // gnssLocation.longitude
  gnssTimeStamp: string | null;
  gnssSpeedMph: number | null;
  gnssAltitudeM: number | null;
  gnssErrorM: number | null;
  hvThermalEvent: string;     // batteryHvThermalEvent raw
  hvThermalPropagation: string; // batteryHvThermalEventPropagation raw
  wiperFluidState: string;    // '' | 'normal' | 'low'
  brakeFluidLow: boolean;
  tirePressureFL: string;     // 'normal' | 'low' | 'critical' | ''
  tirePressureFR: string;
  tirePressureRL: string;
  tirePressureRR: string;
  otaCurrentVersion: string;  // otaCurrentVersionNumber
  otaAvailableVersion: string;// otaAvailableVersionNumber
  otaStatus: string;          // otaStatus / otaCurrentStatus
  otaUpdateAvailable: boolean;
  otaInstalling: boolean;
}

// ── Token storage ─────────────────────────────────────────────────────────────

function tokensPath(): string {
  const dir = process.env.KEYS_DIR ?? join(process.cwd(), 'keys');
  return join(dir, 'rivian-tokens.json');
}

export function readRivianTokens(): RivianTokens | null {
  const p = tokensPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as RivianTokens;
  } catch {
    return null;
  }
}

export function writeRivianTokens(tokens: RivianTokens): void {
  writeFileSync(tokensPath(), JSON.stringify(tokens, null, 2));
}

// ── GraphQL helper ────────────────────────────────────────────────────────────

async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { ...BASE_HEADERS, ...extraHeaders },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json() as { data?: T; errors?: unknown[] };
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors[0]));
  if (!json.data) throw new Error('No data in response');
  return json.data;
}

// ── Auth flow ─────────────────────────────────────────────────────────────────

const CREATE_CSRF = `
mutation CreateCSRFToken {
  createCsrfToken { csrfToken appSessionToken }
}`;

const LOGIN = `
mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) {
    __typename
    ... on MobileLoginResponse { accessToken refreshToken userSessionToken }
    ... on MobileMFALoginResponse { otpToken }
  }
}`;

const LOGIN_OTP = `
mutation LoginWithOTP($email: String!, $otpToken: String!, $otpCode: String!) {
  loginWithOTP(email: $email, otpToken: $otpToken, otpCode: $otpCode) {
    accessToken refreshToken userSessionToken
  }
}`;

export interface LoginResult {
  type: 'success' | 'otp_required';
  otpToken?: string;
}

export async function rivianLogin(email: string, password: string): Promise<LoginResult & { csrfToken?: string; appSessionToken?: string }> {
  // Step 1: CSRF token
  const csrf = await gql<{ createCsrfToken: { csrfToken: string; appSessionToken: string } }>(CREATE_CSRF);
  const { csrfToken, appSessionToken } = csrf.createCsrfToken;

  const authHeaders = {
    'Csrf-Token': csrfToken,
    'A-Sess': appSessionToken,
  };

  // Step 2: Login
  const loginData = await gql<{
    login: {
      __typename: string;
      accessToken?: string;
      refreshToken?: string;
      userSessionToken?: string;
      otpToken?: string;
    };
  }>(LOGIN, { email, password }, authHeaders);

  const login = loginData.login;

  if (login.__typename === 'MobileMFALoginResponse' && login.otpToken) {
    return { type: 'otp_required', otpToken: login.otpToken, csrfToken, appSessionToken };
  }

  if (login.__typename === 'MobileLoginResponse' && login.accessToken) {
    const tokens = await resolveTokensAndVehicle({
      accessToken: login.accessToken,
      refreshToken: login.refreshToken!,
      userSessionToken: login.userSessionToken!,
      appSessionToken,
      csrfToken,
    });
    writeRivianTokens(tokens);
    return { type: 'success' };
  }

  throw new Error('Unexpected login response');
}

export async function rivianLoginOtp(
  email: string,
  otpToken: string,
  otpCode: string,
  csrfToken: string,
  appSessionToken: string,
): Promise<void> {
  const authHeaders = { 'Csrf-Token': csrfToken, 'A-Sess': appSessionToken };
  const data = await gql<{
    loginWithOTP: { accessToken: string; refreshToken: string; userSessionToken: string };
  }>(LOGIN_OTP, { email, otpToken, otpCode }, authHeaders);

  const { accessToken, refreshToken, userSessionToken } = data.loginWithOTP;
  const tokens = await resolveTokensAndVehicle({
    accessToken,
    refreshToken,
    userSessionToken,
    appSessionToken,
    csrfToken,
  });
  writeRivianTokens(tokens);
}

// ── Vehicle lookup ────────────────────────────────────────────────────────────

const GET_USER_VEHICLES = `
query GetCurrentUser {
  currentUser {
    id
    vehicles {
      id
      name
      vin
      vehicle { id vin make model modelYear }
    }
  }
}`;

async function resolveTokensAndVehicle(partial: Omit<RivianTokens, 'vehicleId' | 'savedAt'>): Promise<RivianTokens> {
  const authHeaders = {
    'Csrf-Token': partial.csrfToken,
    'A-Sess': partial.appSessionToken,
    'U-Sess': partial.userSessionToken,
  };

  let vehicleId = '';
  try {
    const userData = await gql<{
      currentUser: { vehicles: Array<{ id: string; name: string; vin: string }> };
    }>(GET_USER_VEHICLES, {}, authHeaders);

    vehicleId = userData.currentUser.vehicles[0]?.id ?? '';
  } catch {
    // Non-fatal — user can provide vehicle ID manually
  }

  return { ...partial, vehicleId, savedAt: Date.now() };
}

// ── Vehicle state ─────────────────────────────────────────────────────────────

const GET_VEHICLE_STATE = `
query GetVehicleState($vehicleID: String!) {
  vehicleState(id: $vehicleID) {
    cloudConnection { lastSync isOnline }
    batteryLevel { timeStamp value }
    distanceToEmpty { timeStamp value }
    batteryLimit { timeStamp value }
    timeToEndOfCharge { timeStamp value }
    chargerState { timeStamp value }
    chargerStatus { timeStamp value }
    chargerDerateStatus { timeStamp value }
    powerState { timeStamp value }
    vehicleMileage { timeStamp value }
    doorFrontLeftLocked { timeStamp value }
    doorFrontRightLocked { timeStamp value }
    cabinPreconditioningStatus { timeStamp value }
    chargePortState { timeStamp value }
    gnssLocation { timeStamp latitude longitude }
    gnssSpeed { timeStamp value }
    gnssAltitude { timeStamp value }
    gnssError { timeStamp positionHorizontal positionVertical speed bearing }
    wiperFluidState { timeStamp value }
    brakeFluidLow { timeStamp value }
    tirePressureStatusFrontLeft { timeStamp value }
    tirePressureStatusFrontRight { timeStamp value }
    tirePressureStatusRearLeft { timeStamp value }
    tirePressureStatusRearRight { timeStamp value }
    batteryHvThermalEvent { timeStamp value }
    batteryHvThermalEventPropagation { timeStamp value }
    otaCurrentVersionNumber { timeStamp value }
    otaAvailableVersionNumber { timeStamp value }
    otaStatus { timeStamp value }
    otaCurrentStatus { timeStamp value }
  }
}`;

interface RawVehicleState {
  cloudConnection: { lastSync: string; isOnline?: boolean };
  batteryLevel: { value: number } | null;
  distanceToEmpty: { value: number } | null;
  batteryLimit: { value: number } | null;
  timeToEndOfCharge: { value: number } | null;
  chargerState: { value: string; timeStamp?: string } | null;
  chargerStatus: { value: string; timeStamp?: string } | null;
  chargerDerateStatus: { value: string; timeStamp?: string } | null;
  powerState: { value: string; timeStamp?: string } | null;
  vehicleMileage: { value: number } | null;
  doorFrontLeftLocked: { value: string } | null;
  cabinPreconditioningStatus: { value: string } | null;
  chargePortState: { value: string; timeStamp?: string } | null;
  gnssLocation: { latitude: number; longitude: number; timeStamp?: string } | null;
  gnssSpeed: { value: number; timeStamp?: string } | null;
  gnssAltitude: { value: number; timeStamp?: string } | null;
  gnssError: { positionHorizontal?: number; positionVertical?: number; speed?: number; bearing?: number; timeStamp?: string } | null;
  wiperFluidState: { value: string; timeStamp?: string } | null;
  brakeFluidLow: { value: boolean | string; timeStamp?: string } | null;
  tirePressureStatusFrontLeft: { value: string; timeStamp?: string } | null;
  tirePressureStatusFrontRight: { value: string; timeStamp?: string } | null;
  tirePressureStatusRearLeft: { value: string; timeStamp?: string } | null;
  tirePressureStatusRearRight: { value: string; timeStamp?: string } | null;
  batteryHvThermalEvent: { value: string; timeStamp?: string } | null;
  batteryHvThermalEventPropagation: { value: string; timeStamp?: string } | null;
  otaCurrentVersionNumber: { value: string; timeStamp?: string } | null;
  otaAvailableVersionNumber: { value: string; timeStamp?: string } | null;
  otaStatus: { value: string; timeStamp?: string } | null;
  otaCurrentStatus: { value: string; timeStamp?: string } | null;
}

function authHeaders(t: RivianTokens): Record<string, string> {
  return {
    'Csrf-Token': t.csrfToken,
    'A-Sess': t.appSessionToken,
    'U-Sess': t.userSessionToken,
  };
}

export async function fetchRivianVehicleState(vehicleId?: string): Promise<RivianVehicleState | null> {
  const tokens = readRivianTokens();
  if (!tokens) return null;

  const vid = vehicleId ?? tokens.vehicleId;
  if (!vid) return null;

  // Rivian throttling is opaque — respect our own backoff clock.
  if (inBackoffWindow()) {
    return null;
  }

  // Piggyback the 90-day session-age check on the poll cycle. Cheap.
  checkRivianSessionAge();

  try {
    const data = await gql<{ vehicleState: RawVehicleState }>(
      GET_VEHICLE_STATE,
      { vehicleID: vid },
      authHeaders(tokens),
    );

    resetBackoff();
    const vs = data.vehicleState;
    const chargingStateRaw = vs.chargerState?.value ?? 'disconnected';
    const chargerStateTs = vs.chargerState?.timeStamp;
    const chargerStatusRaw = vs.chargerStatus?.value ?? '';
    const chargerStatusTs = vs.chargerStatus?.timeStamp;
    const chargePortRaw = vs.chargePortState?.value ?? '';
    const chargePortTs = vs.chargePortState?.timeStamp;
    const powerStateRaw = vs.powerState?.value ?? '';
    const powerStateTs = vs.powerState?.timeStamp;

    const derateRawEarly = vs.chargerDerateStatus?.value ?? '';
    const hvThermalRaw = vs.batteryHvThermalEvent?.value ?? '';
    const hvThermalPropRaw = vs.batteryHvThermalEventPropagation?.value ?? '';
    const wiperFluidRaw = vs.wiperFluidState?.value ?? '';
    const brakeFluidRaw = vs.brakeFluidLow?.value;
    const tpFL = vs.tirePressureStatusFrontLeft?.value ?? '';
    const tpFR = vs.tirePressureStatusFrontRight?.value ?? '';
    const tpRL = vs.tirePressureStatusRearLeft?.value ?? '';
    const tpRR = vs.tirePressureStatusRearRight?.value ?? '';
    const gnssErrH = vs.gnssError?.positionHorizontal;
    console.log(
      `[rivian] chargerState="${chargingStateRaw}"@${chargerStateTs ?? '?'} ` +
      `chargerStatus="${chargerStatusRaw}"@${chargerStatusTs ?? '?'} ` +
      `chargePortState="${chargePortRaw}"@${chargePortTs ?? '?'} ` +
      `powerState="${powerStateRaw}"@${powerStateTs ?? '?'} ` +
      `derate="${derateRawEarly}" hvThermal="${hvThermalRaw}" hvProp="${hvThermalPropRaw}" ` +
      `tires=FL:${tpFL}/FR:${tpFR}/RL:${tpRL}/RR:${tpRR} ` +
      `wiper="${wiperFluidRaw}" brakeLow=${brakeFluidRaw} ` +
      `gnssErrH=${gnssErrH ?? '?'} online=${vs.cloudConnection?.isOnline ?? '?'}`
    );

    // Staleness threshold for the chargerState (legacy logic). Once we
    // confirm chargePortState is fresh and behaves correctly, this can
    // be replaced with a direct chargePortState read.
    const STALE_MS = 15 * 60 * 1000;
    const chargerStateStale = chargerStateTs
      ? (Date.now() - new Date(chargerStateTs).getTime()) > STALE_MS
      : false;

    // Resolve plug status. Rivian uses several fields and they often
    // disagree because the car sleeps mid-state. From production:
    //   chargerStatus="chrgr_sts_not_connected"  ← authoritative
    //   chargePortState="close"                  ← Rivian uses singular "close"
    //   chargerState="charging_ready"            ← stale, lies about plug
    //
    // Rule: any explicit "not connected" / "close[d]" / "empty" /
    // "disconnected" is trusted regardless of staleness. The car was
    // last seen unplugged and we have no fresher signal otherwise.
    // Only treat as plugged in when we have a FRESH signal saying so.
    const UNPLUGGED_RE = /\b(not[_ ]?connected|^close[d]?$|disconnected|empty|unplugged)\b/i;
    const anyExplicitUnplugged =
      UNPLUGGED_RE.test(chargerStatusRaw) ||
      UNPLUGGED_RE.test(chargePortRaw) ||
      chargingStateRaw.toLowerCase() === 'disconnected';

    const portFresh = chargePortTs
      ? (Date.now() - new Date(chargePortTs).getTime()) < STALE_MS
      : false;
    const portSaysPluggedIn = chargePortRaw !== '' && !UNPLUGGED_RE.test(chargePortRaw);

    // Only treat as charging when the contactor is actually closed and power is flowing
    const CHARGING_ACTIVE = new Set(['charging', 'charging_active', 'charge_starting', 'charge_active', 'charging_ac_1ph', 'charging_ac_3ph']);
    const isCharging = !chargerStateStale && CHARGING_ACTIVE.has(chargingStateRaw.toLowerCase());

    // Plug resolution order:
    //   1. Any explicit "not connected" anywhere → false (trusted even stale)
    //   2. Fresh chargePortState says plugged → true
    //   3. Fresh chargerState says plugged → true
    //   4. Default false
    let isPluggedIn: boolean;
    if (anyExplicitUnplugged) {
      isPluggedIn = false;
    } else if (portFresh && portSaysPluggedIn) {
      isPluggedIn = true;
    } else if (!chargerStateStale && chargingStateRaw.toLowerCase() !== 'disconnected' && chargingStateRaw !== '') {
      isPluggedIn = true;
    } else {
      isPluggedIn = false;
    }

    // Rivian charger derate (throttling). Treat anything that's not empty
    // / "no_derate" / "none" / "inactive" as throttled. Specific reason
    // strings are surfaced verbatim — we don't have a documented enum.
    const derateRaw = (vs.chargerDerateStatus?.value ?? '').trim();
    const derateLower = derateRaw.toLowerCase();
    const isThrottled = derateRaw !== '' &&
      derateLower !== 'no_derate' &&
      derateLower !== 'none' &&
      derateLower !== 'inactive' &&
      derateLower !== 'normal';

    // Only show climate as on for explicitly active states; 'system_idle', 'not_available', etc. → off
    const CLIMATE_ACTIVE = new Set(['cooling', 'heating', 'defrost', 'ventilation', 'preconditioning', 'hvac_conditioning']);
    const climateVal = (vs.cabinPreconditioningStatus?.value ?? '').toLowerCase();

    const otaCurrent = vs.otaCurrentVersionNumber?.value ?? '';
    const otaAvailable = vs.otaAvailableVersionNumber?.value ?? '';
    const otaStatusRaw = (vs.otaStatus?.value ?? vs.otaCurrentStatus?.value ?? '').toString();
    const otaStatusLower = otaStatusRaw.toLowerCase();
    const otaInstalling = /install|download|apply|updating/.test(otaStatusLower);
    const otaUpdateAvailable = otaAvailable !== '' && otaAvailable !== otaCurrent;

    const brakeLowBool = brakeFluidRaw === true || brakeFluidRaw === 'low' || brakeFluidRaw === 'true';

    return {
      chargePercent: vs.batteryLevel?.value ?? 0,
      chargeLimit: vs.batteryLimit?.value ?? 80,
      isCharging,
      isPluggedIn,
      isThrottled,
      derateReason: derateRaw,
      chargingState: chargingStateRaw,
      isLocked: vs.doorFrontLeftLocked?.value === 'locked',
      climateOn: CLIMATE_ACTIVE.has(climateVal),
      rangeMi: vs.distanceToEmpty?.value ?? 0,
      // vehicleMileage is returned in meters; convert to miles
      odometer: Math.round((vs.vehicleMileage?.value ?? 0) / 1609.344),
      minutesToFull: vs.timeToEndOfCharge?.value ?? 0,
      chargeRateMph: 0,
      addedRangeMi: 0,
      online: vs.cloudConnection?.isOnline ?? false,
      lat: vs.gnssLocation?.latitude ?? null,
      lon: vs.gnssLocation?.longitude ?? null,
      gnssTimeStamp: vs.gnssLocation?.timeStamp ?? null,
      gnssSpeedMph: vs.gnssSpeed?.value != null ? vs.gnssSpeed.value * 2.23694 : null,
      gnssAltitudeM: vs.gnssAltitude?.value ?? null,
      gnssErrorM: vs.gnssError?.positionHorizontal ?? null,
      hvThermalEvent: hvThermalRaw,
      hvThermalPropagation: hvThermalPropRaw,
      wiperFluidState: wiperFluidRaw,
      brakeFluidLow: brakeLowBool,
      tirePressureFL: tpFL,
      tirePressureFR: tpFR,
      tirePressureRL: tpRL,
      tirePressureRR: tpRR,
      otaCurrentVersion: otaCurrent,
      otaAvailableVersion: otaAvailable,
      otaStatus: otaStatusRaw,
      otaUpdateAvailable,
      otaInstalling,
    };
  } catch (e) {
    const msg = String(e);
    // 401 in the error body → session expired. Set the reauth flag so the
    // dashboard can surface a banner.
    if (/401|unauthori[sz]ed|invalid[_ ]session|expired/i.test(msg)) {
      try { markRivianReauthRequired('401 from vehicleState: ' + msg.slice(0, 200)); } catch {}
    }
    recordBackoffError();
    console.warn('[rivian] fetchRivianVehicleState failed:', msg.slice(0, 240));
    return null;
  }
}

// Clear backoff + reauth flags after a successful login. Called from
// admin login endpoints.
export function noteRivianLoginSuccess(): void {
  resetBackoff();
  noteRivianAuthRefreshed();
}

export function hasRivianTokens(): boolean {
  return readRivianTokens() !== null;
}
