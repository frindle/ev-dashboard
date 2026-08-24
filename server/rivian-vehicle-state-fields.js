// The single source of truth for the `vehicleState` field selection.
//
// It lives here, in server/, rather than in lib/ because it has to be
// readable by BOTH module systems: lib/rivian.ts imports it (webpack bundles
// it into the Next build, so there's no runtime file dependency), and
// server/rivian-state-monitor.js `require`s it at runtime from the deployed
// image -- and the Dockerfile copies server/ into the final image but not
// lib/ (see Dockerfile: only .next/standalone, server/, protos/, scripts/).
//
// Plain CommonJS with a literal object export on purpose: that's the shape
// Node's cjs-module-lexer can statically analyse, so `import
// { VEHICLE_STATE_FIELDS } from '...'` works from ESM too (scripts/*.mjs).
//
// The polled GetVehicleState query and the pushed vehicleState subscription
// MUST request the same fields -- lib/rivian.ts has exactly one mapping
// function for both paths, and a field present on one path but not the other
// would silently read as "always null" on the other. Add fields here, never
// in one consumer only.

const VEHICLE_STATE_FIELDS = `
    cloudConnection { lastSync isOnline }
    batteryLevel { timeStamp value }
    distanceToEmpty { timeStamp value }
    batteryLimit { timeStamp value }
    timeToEndOfCharge { timeStamp value }
    chargerState { timeStamp value }
    chargerStatus { timeStamp value }
    chargerDerateStatus { timeStamp value }
    powerState { timeStamp value }
    gearStatus { timeStamp value }
    vehicleMileage { timeStamp value }
    doorFrontLeftLocked { timeStamp value }
    doorFrontLeftClosed { timeStamp value }
    doorFrontRightLocked { timeStamp value }
    doorFrontRightClosed { timeStamp value }
    doorRearLeftLocked { timeStamp value }
    doorRearLeftClosed { timeStamp value }
    doorRearRightLocked { timeStamp value }
    doorRearRightClosed { timeStamp value }
    twelveVoltBatteryHealth { timeStamp value }
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
    otaCurrentStatus { timeStamp value }`;

module.exports = { VEHICLE_STATE_FIELDS };
