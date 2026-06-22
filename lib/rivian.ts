import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const GATEWAY = 'https://rivian.com/api/gql/gateway/graphql';

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
    powerState { timeStamp value }
    vehicleMileage { timeStamp value }
    doorFrontLeftLocked { timeStamp value }
    doorFrontRightLocked { timeStamp value }
    cabinPreconditioningStatus { timeStamp value }
    chargePortState { timeStamp value }
    gnssLocation { timeStamp latitude longitude }
  }
}`;

interface RawVehicleState {
  cloudConnection: { lastSync: string; isOnline?: boolean };
  batteryLevel: { value: number } | null;
  distanceToEmpty: { value: number } | null;
  batteryLimit: { value: number } | null;
  timeToEndOfCharge: { value: number } | null;
  chargerState: { value: string } | null;
  chargerStatus: { value: string } | null;
  powerState: { value: string } | null;
  vehicleMileage: { value: number } | null;
  doorFrontLeftLocked: { value: string } | null;
  cabinPreconditioningStatus: { value: string } | null;
  gnssLocation: { latitude: number; longitude: number } | null;
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

  try {
    const data = await gql<{ vehicleState: RawVehicleState }>(
      GET_VEHICLE_STATE,
      { vehicleID: vid },
      authHeaders(tokens),
    );

    const vs = data.vehicleState;
    const chargingStateRaw = vs.chargerState?.value ?? 'disconnected';

    // Only treat as charging when the contactor is actually closed and power is flowing
    const CHARGING_ACTIVE = new Set(['charging', 'charging_active', 'charge_starting', 'charge_active']);
    const isCharging = CHARGING_ACTIVE.has(chargingStateRaw.toLowerCase());

    // Only show climate as on for explicitly active states; 'system_idle', 'not_available', etc. → off
    const CLIMATE_ACTIVE = new Set(['cooling', 'heating', 'defrost', 'ventilation', 'preconditioning', 'hvac_conditioning']);
    const climateVal = (vs.cabinPreconditioningStatus?.value ?? '').toLowerCase();

    return {
      chargePercent: vs.batteryLevel?.value ?? 0,
      chargeLimit: vs.batteryLimit?.value ?? 80,
      isCharging,
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
    };
  } catch {
    return null;
  }
}

export function hasRivianTokens(): boolean {
  return readRivianTokens() !== null;
}
