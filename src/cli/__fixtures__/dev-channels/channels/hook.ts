// A plain channel: the file name ('hook') is the route. The reply names the version of this file.
export default {
  async parse(req: { text: string }) {
    return { sessionKey: 'k', input: req.text, replyTo: null };
  },
  async reply({ text, respond }: { text: string; respond?: (status: number, body: unknown) => void }) {
    respond?.(200, { reply: `v1:${text}` });
  },
};
