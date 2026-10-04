import { httpChannel } from '@lousho/build-ai-agent';

// A JSON API channel under POST /channels/api.
export default httpChannel({ name: 'api' });
