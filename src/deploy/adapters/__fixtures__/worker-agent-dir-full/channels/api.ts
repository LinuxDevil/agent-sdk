import { httpChannel } from 'lousho';

// A JSON API channel under POST /channels/api.
export default httpChannel({ name: 'api' });
