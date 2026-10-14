export function isClosureMessage(message) {
  const type = String(message?.roadManagementType || "").toLowerCase();
  if (/lane|partial/.test(type)) return false;
  if (/^(roadclosed|carriagewayclosed|carriagewayblocked|roadblocked)$/.test(type)) return true;
  const text = `${message?.title || ""} ${message?.text || ""}`.toLowerCase();
  if (/\b(?:ikke|not)\s+(?:helt\s+)?(?:stengt|sperret|closed|blocked)\b|\bgjenåpnet\b|\breopened\b/.test(text)) return false;
  if (/\b(?:felt|lane|ramp|rampe|ett løp|én retning|en retning)\b/.test(text) && !/\b(?:hele tunnelen|begge løp|all lanes)\b/.test(text)) return false;
  return /\b(?:stengt|closed|closure|sperret|blocked|impassable)\b|ikke farbar/.test(text);
}

export function isPartialClosure(message) {
  const type = `${message?.roadManagementType || ""} ${message?.trafficConstrictionType || ""}`.toLowerCase();
  const text = `${message?.title || ""} ${message?.text || ""}`.toLowerCase();
  return /lane.*(?:blocked|closed)|partial|constrict|narrowing/.test(type) ||
    (/\b(?:felt|lane|rampe|ett løp|én retning|en retning)\b/.test(text) && /stengt|sperret|closed|blocked/.test(text));
}

export function measurementAge(updated, now = Date.now()) {
  const timestamp = Date.parse(updated || "");
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Infinity;
}
