// installation.md:77
import { MissingPeerDependencyError, resolveProvider } from '@lousho/build-ai-agent';

const provider = resolveProvider('openai/gpt-4o-mini'); // needs OPENAI_API_KEY; does not load the peer
try {
  await provider.generate({ messages: [{ role: 'user', content: 'hello' }] });
} catch (error) {
  if (error instanceof MissingPeerDependencyError) {
    console.error(error.packageName, error.installCommand);
  }
}
export {};
