/**
 * The `HeartbeatAck` (RT-327, AD-DEVICE-001 D-2 and D-3): the reply to every
 * accepted heartbeat, stored or throttled alike. Computed from THIS request's
 * body and the current policy of the channel the body reported, never from
 * the stored row.
 *
 * With no policy for the reported channel (or no channel reported) the policy
 * and the grace instant are `null` and `compliance` is `unknown`: never `ok`
 * on missing data.
 */
import { deriveCompliance, type Compliance } from "./compliance";
import { POS_CONTRACT_REVISION } from "./pos-contract-revision";

/** One channel's stored policy, as the runtime reads it. */
export interface ChannelPolicy {
  readonly channel: string;
  readonly latestVersion: string;
  readonly recommendedVersion: string;
  readonly minSupportedVersion: string;
  readonly minSupportedGraceUntil: Date;
  readonly revision: number;
}

export interface HeartbeatAckBody {
  readonly acknowledged_at: string;
  readonly pos_contract_revision: number;
  readonly policy: {
    readonly channel: string;
    readonly latest_version: string;
    readonly recommended_version: string;
    readonly min_supported_version: string;
    readonly policy_revision: number;
  } | null;
  readonly min_supported_grace_until: string | null;
  readonly compliance: Compliance;
}

export function buildHeartbeatAck(input: {
  readonly now: Date;
  readonly appVersion: string | null;
  readonly updateChannel: string | null;
  readonly policy: ChannelPolicy | null;
}): HeartbeatAckBody {
  const { policy } = input;
  return {
    acknowledged_at: input.now.toISOString(),
    pos_contract_revision: POS_CONTRACT_REVISION,
    policy:
      policy === null
        ? null
        : {
            channel: policy.channel,
            latest_version: policy.latestVersion,
            recommended_version: policy.recommendedVersion,
            min_supported_version: policy.minSupportedVersion,
            policy_revision: policy.revision,
          },
    min_supported_grace_until: policy === null ? null : policy.minSupportedGraceUntil.toISOString(),
    compliance:
      policy === null
        ? "unknown"
        : deriveCompliance({
            appVersion: input.appVersion,
            updateChannel: input.updateChannel,
            minSupportedVersion: policy.minSupportedVersion,
          }),
  };
}
