// BMCA（Best Master Clock Algorithm）数据集比较。
// 数值越小越优：priority1 -> clockClass -> priority2 -> grandmasterId。

export function isMasterCapable(dataset) {
  // clockClass >= 248 的时钟不可作为 master（IEEE 1588 默认数据集约定）。
  return dataset != null && dataset.clockClass < 248;
}

export function compareDatasets(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  for (const key of ['priority1', 'clockClass', 'priority2']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return String(a.gmId).localeCompare(String(b.gmId));
}

export function selectBestMaster(candidates) {
  let best = null;
  for (const dataset of candidates.values()) {
    if (!isMasterCapable(dataset)) continue;
    if (compareDatasets(dataset, best) < 0) best = dataset;
  }
  return best;
}
