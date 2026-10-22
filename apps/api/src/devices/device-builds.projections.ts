/**
 * The fleet baseline projection (RT-719, `consoleGetFleetBaseline`;
 * `console-device-builds.openapi.yaml`): the distinct POS builds installed on
 * the ACTIVE devices in scope, with a device count each and an explicit count of
 * devices whose build is unknown (the evidence RT-713 reads as
 * `fleet_baseline.source`). Pure: the service reads the grouped rows, this maps
 * them onto the wire.
 *
 * One group per distinct reported identity (`buildCommit`, `appVersion`,
 * `contractPinCommit`); the group with no commit is the unknown devices (the
 * 0073 CHECK keeps its other columns null), counted in `unknownDeviceCount` and
 * never folded into a build. `kind` is `release` exactly when an `appVersion` is
 * known, else `build` (the RT-709 section C.1 entry kinds).
 */

/** One group of the read: a reported identity (or the unknown group) and its active devices. */
export interface FleetBuildGroupRow {
  readonly build_commit: string | null;
  readonly app_version: string | null;
  readonly contract_pin: string | null;
  readonly device_count: number;
  readonly oldest_reported_at: Date | null;
  readonly latest_reported_at: Date | null;
}

export interface FleetBuildEntry {
  readonly kind: "release" | "build";
  readonly posVersion: string | null;
  readonly buildId: string;
  readonly contractPinCommit: string | null;
  readonly deviceCount: number;
  readonly oldestReportedAt: string;
  readonly latestReportedAt: string;
}

export interface FleetBaseline {
  readonly scope: "store" | "all_in_scope";
  readonly storeRef: string | null;
  readonly basis: "terminal_reported";
  readonly generatedAt: string;
  readonly deviceCount: number;
  readonly reportingDeviceCount: number;
  readonly unknownDeviceCount: number;
  readonly installed: FleetBuildEntry[];
}

function toEntry(row: FleetBuildGroupRow, commit: string): FleetBuildEntry | null {
  // A group with a commit always has its server times (the 0073 CHECK); skip a group that does not rather than invent one.
  if (row.oldest_reported_at === null || row.latest_reported_at === null) return null;
  return {
    kind: row.app_version === null ? "build" : "release",
    posVersion: row.app_version,
    buildId: commit,
    contractPinCommit: row.contract_pin,
    deviceCount: row.device_count,
    oldestReportedAt: row.oldest_reported_at.toISOString(),
    latestReportedAt: row.latest_reported_at.toISOString(),
  };
}

export function toFleetBaseline(input: {
  readonly rows: readonly FleetBuildGroupRow[];
  readonly storeId: string | null;
  readonly generatedAt: Date;
}): FleetBaseline {
  const installed = input.rows.flatMap((row) => (row.build_commit === null ? [] : [toEntry(row, row.build_commit)]));
  const entries = installed.filter((entry): entry is FleetBuildEntry => entry !== null);
  const unknownDeviceCount = input.rows.reduce((sum, row) => sum + (row.build_commit === null ? row.device_count : 0), 0);
  const reportingDeviceCount = entries.reduce((sum, entry) => sum + entry.deviceCount, 0);
  return {
    scope: input.storeId === null ? "all_in_scope" : "store",
    storeRef: input.storeId,
    basis: "terminal_reported",
    generatedAt: input.generatedAt.toISOString(),
    deviceCount: reportingDeviceCount + unknownDeviceCount,
    reportingDeviceCount,
    unknownDeviceCount,
    installed: entries,
  };
}
