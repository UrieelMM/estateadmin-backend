export const TOWER_SNAPSHOT_MAX_LENGTH = 40;

export const sanitizeTowerSnapshot = (
  value: unknown,
): string | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized;
};

export const resolveTowerSnapshot = (
  inputTower?: unknown,
  userTower?: unknown,
): string => {
  return (
    sanitizeTowerSnapshot(inputTower) ||
    sanitizeTowerSnapshot(userTower) ||
    ''
  );
};
