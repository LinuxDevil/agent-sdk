import { httpChannel } from '@linuxdevil/lousho';

// A JSON API channel under POST /channels/api.
export default httpChannel({ name: 'api' });
