#!/usr/bin/env python3
"""Reference impl for: ev-circuit-charging-truth

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Write the SIMPLEST change that makes the verify pass. It doubles as your review
reference when the model's diff comes back.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/circuitStatus.ts'
t = p.read_text()

OLD = """export function circuitStatus(
  leftAmps: number,
  rightAmps: number,
  leftPlugged: boolean,
  rightPlugged: boolean,
): { label: string; charging: boolean } {
  const chargingCount = (leftAmps > 0 ? 1 : 0) + (rightAmps > 0 ? 1 : 0);"""
NEW = """export function circuitStatus(
  leftAmps: number,
  rightAmps: number,
  leftPlugged: boolean,
  rightPlugged: boolean,
  leftCharging: boolean,
  rightCharging: boolean,
): { label: string; charging: boolean } {
  const chargingCount = (leftAmps > 0 && leftCharging ? 1 : 0) + (rightAmps > 0 && rightCharging ? 1 : 0);"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
