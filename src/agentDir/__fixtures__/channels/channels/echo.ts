// A plain channel object without a name: the file name ('echo') becomes the channel name.
export default {
  async parse() {
    return { sessionKey: 'k', input: 'hi', replyTo: null };
  },
  async reply() {},
};
