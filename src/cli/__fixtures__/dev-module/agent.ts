import { createAgent } from '../../../createAgent';
import { mockModel } from '../../../testing';
import { GREETING } from './greeting';

export default createAgent({
  name: 'dev-module',
  instructions: GREETING,
  provider: mockModel(['module says hi', 'module says hi']),
});
