/**
 * sdkCompat: the minimum `@lousho/build-ai-agent` version whose `lousho
 * bridge` speaks protocol 1 (W10a/W10b). Studio and the SDK ship from the
 * same repo, so the floor is this package's own version at the merge -
 * W15b's compatibility matrix is the consumer that revisits it.
 */
import { VERSION } from '@linuxdevil/lousho';

/** First SDK version that ships `lousho bridge`. */
export const MIN_BRIDGE_SDK_VERSION = VERSION;
