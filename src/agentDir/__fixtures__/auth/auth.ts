// N10a: an agent directory's route auth, an ordered list.
import { apiToken, basic } from '../../../auth';

export default [basic({ users: { ops: 'pw' } }), apiToken('dir-token')];
