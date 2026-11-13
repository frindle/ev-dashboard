#pragma once
// Helpers for crowpanel-21.yaml. Plain C++, no secrets. Colors are 0xRRGGBB.
#include <cstdio>
#include <cstring>
#include <string>

namespace panel {
inline uint32_t lvl_color(const char *lvl) {
  if (lvl && lvl[0] == 'r') return 0xFF3B30;
  if (lvl && lvl[0] == 'a') return 0xFFB000;
  return 0x2ECC71;
}
// "$12.34" from cents
inline std::string money(int cents) {
  char b[24];
  snprintf(b, sizeof b, "$%d.%02d", cents / 100, cents % 100);
  return b;
}
// Mbps with sensible digits: 312 / 41.2
inline std::string mbps(float v) {
  char b[16];
  if (v >= 100) snprintf(b, sizeof b, "%.0f", v);
  else snprintf(b, sizeof b, "%.1f", v);
  return b;
}
inline std::string tb(int gb) {
  char b[16];
  if (gb >= 1000) snprintf(b, sizeof b, "%.1f TB", gb / 1000.0f);
  else snprintf(b, sizeof b, "%d GB", gb);
  return b;
}
}  // namespace panel
